'use strict';

/**
 * 数据源注册表与统一汇总。
 *
 * 每个 source 导出一个 collect()，返回统一形状的会话数组：
 *   {
 *     source:   'claude' | 'codex' | 'dsh',
 *     id:       会话唯一 id,
 *     project:  项目名（用于展示）,
 *     cwd:      工作目录（可选）,
 *     model:    主模型名,
 *     provider: 供应商标记（中转站会体现为 'custom'）,
 *     lastAt:   ISO 时间字符串,
 *     usage:    { inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens, calls }
 *   }
 */

const claude = require('./claude-source');
const codex = require('./codex-source');
const dsh = require('./dsh-source');
const quota = require('./quota');
const ratelimit = require('./ratelimit');

const SOURCES = [
  { key: 'claude', label: 'Claude Code', collect: claude.collect },
  { key: 'codex', label: 'Codex', collect: codex.collect },
  { key: 'dsh', label: 'DSH', collect: dsh.collect },
];

function emptyUsage() {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, calls: 0 };
}

function addUsage(into, u) {
  into.inputTokens += u.inputTokens || 0;
  into.outputTokens += u.outputTokens || 0;
  into.cacheReadTokens += u.cacheReadTokens || 0;
  into.cacheCreationTokens += u.cacheCreationTokens || 0;
  into.calls += u.calls || 0;
  return into;
}

/**
 * 采集全部数据源，按 agent 分组汇总。
 * 单个源失败不影响其它源 —— 分别 try/catch，并在结果里记录错误。
 */
function collectAll() {
  const agents = [];
  for (const s of SOURCES) {
    const agent = {
      key: s.key,
      label: s.label,
      ok: false,
      error: null,
      sessions: [],
      totals: emptyUsage(),
      byModel: {},
      providers: [],
      lastAt: null,
    };
    try {
      const sessions = s.collect() || [];
      agent.sessions = sessions;
      agent.ok = true;

      const provSet = new Set();
      for (const sess of sessions) {
        addUsage(agent.totals, sess.usage);
        const model = sess.model || 'unknown';
        if (!agent.byModel[model]) agent.byModel[model] = emptyUsage();
        addUsage(agent.byModel[model], sess.usage);
        if (sess.provider && sess.provider !== 'null') provSet.add(sess.provider);
        if (sess.lastAt && (!agent.lastAt || sess.lastAt > agent.lastAt)) agent.lastAt = sess.lastAt;
      }
      agent.providers = [...provSet];
      agent.sessionCount = sessions.length;
    } catch (err) {
      agent.error = String((err && err.message) || err);
    }
    agents.push(agent);
  }
  return agents;
}

/** 全局汇总：总量、24h 分桶、按 agent 的用量。 */
function summarizeAll(agents, now = Date.now(), opts = {}) {
  const DAY = 24 * 60 * 60 * 1000;
  const totals = emptyUsage();
  const buckets = new Array(96).fill(0); // 24h，每 15 分钟一格
  const bucketsBySource = {}; // 每个源一份，供切换到单源视图时使用
  const byModel = {};
  const bySource = {};

  // 额度视图需要跨源的全部会话（provider 信息主要在 DSH 里）
  const allSessions = [];
  for (const a of agents) allSessions.push(...a.sessions);
  const providerQuota = quota.aggregateByProvider(allSessions, { period: 'today', now });

  // 上游限流状态（soft_rate）：只有 DSH 会话里记录了限流事件
  const dshAgent = agents.find((a) => a.key === 'dsh');
  const rateLimits = ratelimit.summarizeRateLimits(dshAgent ? dshAgent.sessions : [], {
    now,
    includeFreeModel: !!opts.includeFreeModel,
    // 下面三个来自设置页的「限流监控」分组，此前只写配置、无人消费
    enabled: opts.rateEnabled !== false,
    includeOpenCode: opts.rateOpenCode !== false,
    graceMinutes: Number.isFinite(opts.rateGraceMinutes) ? opts.rateGraceMinutes : null,
  });

  /*
   * Codex 官方登录态的百分比额度（ChatGPT 订阅版的 5h/周窗口）。
   * 数据在本地 rollout 里，与登录态绑定 —— 走中转站时全库无值，
   * 这里返回 null，UI 隐藏该区块（绝不编造百分比）。
   */
  const codexAgent = agents.find((a) => a.key === 'codex');
  const codexQuota = codexAgent
    ? codex.collectOfficialQuota(codexAgent.sessions)
    : null;

  for (const a of agents) {
    for (const k of Object.keys(totals)) totals[k] += a.totals[k] || 0;
    bySource[a.key] = {
      label: a.label,
      ok: a.ok,
      error: a.error,
      totals: a.totals,
      sessionCount: a.sessionCount || 0,
      providers: a.providers,
      lastAt: a.lastAt,
    };
    for (const [m, u] of Object.entries(a.byModel)) {
      if (!byModel[m]) byModel[m] = emptyUsage();
      for (const k of Object.keys(byModel[m])) byModel[m][k] += u[k] || 0;
    }

    const sb = new Array(96).fill(0);
    for (const s of a.sessions) {
      if (!s.lastAt) continue;
      const t = Date.parse(s.lastAt);
      const age = now - t;
      if (age >= 0 && age < DAY) {
        const idx = Math.min(95, Math.floor((DAY - age) / (15 * 60 * 1000)));
        const v = (s.usage.outputTokens || 0) + (s.usage.inputTokens || 0);
        buckets[idx] += v;
        sb[idx] += v;
      }
    }
    bucketsBySource[a.key] = sb;
  }

  // 最近会话（跨源合并，按时间倒序）
  const recent = [];
  for (const a of agents) {
    for (const s of a.sessions) {
      recent.push({
        source: a.key,
        sourceLabel: a.label,
        id: s.id,
        project: s.project,
        model: s.model,
        provider: s.provider,
        lastAt: s.lastAt,
        tokens: (s.usage.inputTokens || 0) + (s.usage.outputTokens || 0),
        calls: s.usage.calls || 0,
      });
    }
  }
  recent.sort((a, b) => (b.lastAt || '').localeCompare(a.lastAt || ''));

  return {
    generatedAt: new Date(now).toISOString(),
    totals,
    buckets,
    bucketsBySource,
    byModel,
    bySource,
    providers: providerQuota,
    rateLimits,
    codexQuota,
    sessions: recent.slice(0, 60),
  };
}

/** 汇总各源的缓存命中统计，用于诊断采集开销。 */
function cacheStats() {
  return {
    claude: claude.cache ? claude.cache.stats() : null,
    codex: codex.cache ? codex.cache.stats() : null,
    dsh: dsh.cache ? dsh.cache.stats() : null,
  };
}

module.exports = { SOURCES, collectAll, summarizeAll, emptyUsage, addUsage, cacheStats };
