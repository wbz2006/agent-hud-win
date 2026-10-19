'use strict';

/**
 * 额度（quota）模块。
 *
 * 数据来源有两条，互补而非替代：
 *
 * 1. **真实剩余额度**（推荐主数据）
 *    `dsh-workbuddy-connect` 插件在 DSH 的 web server 上注册了只读路由：
 *      GET http://127.0.0.1:19387/plugins/dsh-workbuddy-connect/status      (国内版)
 *      GET http://127.0.0.1:19387/plugins/dsh-workbuddy-connect/ai/status   (国际版)
 *    返回 credits.total（剩余积分）与 accounts[]（各包的 remain/size）。
 *    这是上游计费接口的实时结果，不是估算。
 *
 *    注意三点：
 *      - 路由由插件在 DSH 宿主内注册，**DSH 必须正在运行**；否则连接被拒。
 *      - 余额是实时计算的，从不落盘，所以只能走 HTTP，不能在文件里找。
 *      - 插件对请求有 Host/Origin 校验（防 DNS rebinding）：默认 fetch 即可通过，
 *        不要伪造这两个头，伪造会被 403。
 *
 * 2. **本地实测消耗量**（辅助）
 *    按 provider 聚合 token 与调用次数，用于判断"今天烧得快不快"。
 *    模型倍率来自 .workbuddy-catalog.json 的 billing.credits —— 那是**单价倍率，
 *    不是剩余积分**，只用来换算消耗，绝不能当额度显示。
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const DSH_HOME = path.join(os.homedir(), '.dsh');

/** 插件注册的额度路由。端口与 DSH web GUI 相同。 */
const DSH_WEB_PORT = 19387;
const ENDPOINTS = [
  { key: 'workbuddy', label: 'WorkBuddy', path: '/plugins/dsh-workbuddy-connect/status' },
  { key: 'workbuddy-ai', label: 'WorkBuddy AI', path: '/plugins/dsh-workbuddy-connect/ai/status' },
];

/** WorkBuddy 的模型目录文件（含单价倍率与免费标记）。 */
const CATALOG_FILES = [
  { file: path.join(DSH_HOME, '.workbuddy-catalog.json'), label: 'WorkBuddy' },
  { file: path.join(DSH_HOME, '.workbuddy-ai-catalog.json'), label: 'WorkBuddy AI' },
];

const PROVIDER_LABELS = {
  workbuddy: 'WorkBuddy',
  'workbuddy-ai': 'WorkBuddy AI',
  'workbuddy-vision': 'WorkBuddy Vision',
  opencode2dsh: 'OpenCode2DSH',
  'opencode2dsh-vision': 'OpenCode2DSH Vision',
  'deepseek-account': 'DeepSeek 官方',
  jy: 'Jy',
  qingshu: '轻书',
};

/**
 * 拉取真实剩余额度。
 * 单个端点失败不影响另一个；DSH 未运行时整体返回空数组（调用方降级展示）。
 *
 * @returns {Promise<Array>} 每个账号一条 { key, label, ok, error, total, accounts, expiresAt }
 */
async function fetchCredits({ timeoutMs = 4000 } = {}) {
  const out = [];
  for (const ep of ENDPOINTS) {
    const rec = { key: ep.key, label: ep.label, ok: false, error: null, total: null, accounts: [], expiresAt: null };
    try {
      const res = await fetch(`http://127.0.0.1:${DSH_WEB_PORT}${ep.path}`, {
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const doc = await res.json();

      if (doc.status === 'signed-out') {
        rec.error = '未登录';
      } else if (doc.creditsError) {
        // 文档仍 200，但计费查询失败：如实上报，不显示 0
        rec.error = String(doc.creditsError).slice(0, 120);
      } else if (doc.credits && typeof doc.credits.total === 'number') {
        rec.ok = true;
        rec.total = doc.credits.total;
        rec.accounts = (doc.credits.accounts || []).map((a) => ({
          packageName: a.packageName,
          remain: a.remain,
          size: a.size,
          unlimited: !!a.unlimited,
        }));
        rec.expiresAt = typeof doc.expiresAt === 'number' ? doc.expiresAt : null;
        rec.domain = doc.domain || null;
      } else {
        rec.error = '响应缺少 credits.total';
      }
    } catch (err) {
      const msg = String((err && err.message) || err);
      rec.error = /fetch failed|ECONNREFUSED|abort/i.test(msg) ? 'DSH 未运行或路由不可达' : msg;
    }
    out.push(rec);
  }
  return out;
}

/** 读取 WorkBuddy 模型目录的单价倍率（仅用于换算本地消耗）。 */
function loadRates() {
  const map = new Map();
  for (const { file, label } of CATALOG_FILES) {
    let doc;
    try {
      doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      continue;
    }
    for (const entry of Object.values(doc.entries || {})) {
      for (const m of entry.models || []) {
        const b = m.billing || {};
        let rate = null;
        if (typeof b.credits === 'string') {
          const n = parseFloat(b.credits.replace(/[^0-9.]/g, ''));
          if (!Number.isNaN(n)) rate = n;
        }
        if (!map.has(m.id)) {
          map.set(m.id, { rate, free: !!b.free, badges: (b.badges || []).slice(), catalog: label });
        }
      }
    }
  }
  return map;
}

/** 归到本地时区当天 0 点。 */
function startOfDayLocal(ts) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * 按 provider 聚合今日消耗量。
 *
 * @param {Array} sessions 各采集器返回的会话（含 provider / model / usage / lastAt）
 * @param {object} opts
 * @param {'today'|'7d'|'all'} opts.period
 * @param {number} opts.now
 */
function aggregateByProvider(sessions, { period = 'today', now = Date.now() } = {}) {
  const rates = loadRates();
  const dayStart = startOfDayLocal(now);
  const cutoff = period === 'today' ? dayStart : period === '7d' ? dayStart - 6 * 86400000 : 0;

  const acc = new Map();

  for (const s of sessions) {
    const provider = s.provider || '(unknown)';
    const t = s.lastAt ? Date.parse(s.lastAt) : now;
    if (cutoff > 0 && t < cutoff) continue;

    if (!acc.has(provider)) {
      acc.set(provider, {
        provider,
        label: PROVIDER_LABELS[provider] || provider,
        calls: 0,
        inputTokens: 0,
        outputTokens: 0,
        models: new Map(),
        lastAt: null,
        freeCalls: 0,
        ratedCalls: 0,
      });
    }
    const a = acc.get(provider);
    a.calls += s.usage.calls || 0;
    a.inputTokens += s.usage.inputTokens || 0;
    a.outputTokens += s.usage.outputTokens || 0;
    if (s.lastAt && (!a.lastAt || s.lastAt > a.lastAt)) a.lastAt = s.lastAt;

    for (const [model, u] of Object.entries(s.byModel || {})) {
      const info = rates.get(model);
      const prev = a.models.get(model) || { model, calls: 0, outputTokens: 0, rate: null, free: false };
      prev.calls += u.calls || 0;
      prev.outputTokens += u.outputTokens || 0;
      if (info) {
        prev.rate = info.rate;
        prev.free = info.free;
        prev.badges = info.badges;
      }
      a.models.set(model, prev);

      const calls = u.calls || 0;
      if (info) {
        a.ratedCalls += calls;
        if (info.rate === 0 || info.free) a.freeCalls += calls;
      }
    }
  }

  const out = [];
  for (const a of acc.values()) {
    const models = [...a.models.values()].map((m) => ({
      model: m.model,
      calls: m.calls,
      outputTokens: m.outputTokens,
      rate: m.rate,
      free: m.free,
      badges: m.badges || [],
      // 倍率未知时给 null，不编造积分
      creditCost: m.rate === null || m.rate === undefined ? null : +(m.rate * m.calls).toFixed(2),
    }));
    models.sort((x, y) => y.calls - x.calls);

    const allRated = models.length > 0 && models.every((m) => m.creditCost !== null);
    const credits = allRated ? +models.reduce((s2, m) => s2 + (m.creditCost || 0), 0).toFixed(2) : null;

    out.push({
      provider: a.provider,
      label: a.label,
      calls: a.calls,
      inputTokens: a.inputTokens,
      outputTokens: a.outputTokens,
      tokens: a.inputTokens + a.outputTokens,
      models,
      lastAt: a.lastAt,
      freeCalls: a.freeCalls,
      ratedCalls: a.ratedCalls,
      coverage: a.calls ? Math.round((a.ratedCalls / a.calls) * 100) : 0,
      credits,
    });
  }

  out.sort((x, y) => y.calls - x.calls);
  return out;
}

module.exports = { fetchCredits, aggregateByProvider, loadRates, PROVIDER_LABELS, DSH_WEB_PORT };
