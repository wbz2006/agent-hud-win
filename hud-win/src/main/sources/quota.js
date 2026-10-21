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

/** 插件注册的两条额度路由（国内版 / 国际版），端口由 findDshPort() 决定。 */
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
 * DSH 本地 HTTP 服务端口 —— **不能写死**。
 *
 * 踩过的坑（2026-10-21）：早先这里固定 19387，当时 DSH 恰好跑在该端口上，
 * 一切正常；后来 DSH 每次启动随机分配端口（实测这次是 8734，同进程还占了
 * 8735~8740 做内部服务），而 19387 已无人监听，于是额度区永远显示
 * 「DSH 未运行或路由不可达 / 离线」—— **DSH 明明开着**。
 *
 * 现在的探测顺序：
 *   1. 环境变量 DSH_WEB_PORT（用户在设置里手动指定，优先级最高）
 *   2. 已知候选端口（老版本用过 19387，新版 GUI 从 8734 起）
 *   3. 系统里所有 127.0.0.1 监听端口（兜底，只在 CDP/新版 DSH 未知时起作用）
 * 探测判据是「这个端口上 /plugins/<id>/status 能返回 JSON」，不是「端口开着」。
 */
const DSH_WEB_PORT_CANDIDATES = [19387, 8734];

/** 已知的额度路由插件 id（用于探测时定位端口）。 */
const QUOTA_PLUGIN_ID = 'dsh-workbuddy-connect';

const PROBE_TIMEOUT_MS = 700;   // 单次探测，必须短：候选端口多时会串行累加
const PROBE_CACHE_MS = 60000;   // 探测成功后缓存 1 分钟，避免每轮都扫

let probeCache = null; // { port, at }

/**
 * 判断某端口上的 DSH 是否真的响应该插件的额度路由。
 * 只看「有没有 HTTP 响应」——200 说明已登录，401/403 说明端口对但仍可用。
 */
async function probePort(port, timeoutMs = PROBE_TIMEOUT_MS) {
  try {
    const res = await fetch(
      `http://127.0.0.1:${port}/plugins/${QUOTA_PLUGIN_ID}/status`,
      { signal: AbortSignal.timeout(timeoutMs) }
    );
    // 401/403 也算「端口正确」：路由存在，只是这个请求没带鉴权
    return { port, reachable: res.status === 200 || res.status === 401 || res.status === 403 };
  } catch {
    return { port, reachable: false };
  }
}

/**
 * 找到当前 DSH 的端口。
 * @returns {Promise<number|null>} 找不到返回 null（调用方降级展示，不编造数据）
 */
async function findDshPort() {
  const now = Date.now();
  if (probeCache && now - probeCache.at < PROBE_CACHE_MS) return probeCache.port;

  // 1) 用户手动指定
  const explicit = Number(process.env.DSH_WEB_PORT || 0);
  if (explicit > 0) {
    const r = await probePort(explicit);
    if (r.reachable) return remember(explicit);
  }

  // 2) 已知候选（并行探测，避免串行等待）
  const known = await Promise.all(DSH_WEB_PORT_CANDIDATES.map((p) => probePort(p)));
  const hit = known.find((r) => r.reachable);
  if (hit) return remember(hit.port);

  // 3) 兜底：扫本机所有监听端口
  const ports = listLocalListeningPorts();
  const scanned = await Promise.all(ports.map((p) => probePort(p, 400)));
  const any = scanned.find((r) => r.reachable);
  if (any) return remember(any.port);

  return null;
}

function remember(port) {
  probeCache = { port, at: Date.now() };
  return port;
}

/** 列出本机 127.0.0.1 上的监听端口（仅 Windows 可用，失败返回空数组）。 */
function listLocalListeningPorts() {
  try {
    const { execFileSync } = require('child_process');
    const out = execFileSync('netstat', ['-ano', '-p', 'TCP'], { encoding: 'utf8', timeout: 3000 });
    const set = new Set();
    for (const line of out.split(/\r?\n/)) {
      const m = line.match(/^\s*TCP\s+(\S+):(\d+)\s+\S+\s+LISTENING/i);
      if (m && /^(127\.0\.0\.1|0\.0\.0\.0|\[::1\]|\[::\])$/.test(m[1])) set.add(Number(m[2]));
    }
    // 排除明显无关的系统端口，减少探测噪音
    const skip = new Set([135, 139, 445, 5353, 5357, 49152, 49664, 49665, 49666, 49667, 49668, 49669]);
    return [...set].filter((p) => p > 1024 && !skip.has(p));
  } catch {
    return [];
  }
}

/** 端口缓存失效（设置变更后可调用，让下一轮重新探测）。 */
function resetPortCache() {
  probeCache = null;
}

/**
 * 拉取真实剩余额度。
 * 单个端点失败不影响另一个；DSH 未运行时整体返回空数组（调用方降级展示）。
 *
 * @returns {Promise<Array>} 每个账号一条 { key, label, ok, error, total, accounts, expiresAt }
 */
async function fetchCredits({ timeoutMs = 4000 } = {}) {
  const out = [];
  const port = await findDshPort();
  if (!port) {
    // 一个端口都没探到：把所有端点标为不可达，原因说清楚
    for (const ep of ENDPOINTS) {
      out.push({
        key: ep.key,
        label: ep.label,
        ok: false,
        error: 'DSH 未运行或路由不可达',
        total: null,
        accounts: [],
        expiresAt: null,
      });
    }
    return out;
  }

  for (const ep of ENDPOINTS) {
    const rec = { key: ep.key, label: ep.label, ok: false, error: null, total: null, accounts: [], expiresAt: null };
    try {
      const res = await fetch(`http://127.0.0.1:${port}${ep.path}`, {
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

module.exports = {
  fetchCredits,
  aggregateByProvider,
  loadRates,
  PROVIDER_LABELS,
  findDshPort,
  resetPortCache,
  ENDPOINTS,
};
