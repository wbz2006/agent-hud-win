'use strict';

/**
 * Codex 本地会话数据采集器。
 *
 * 数据源：%USERPROFILE%\.codex\sessions\<年>\<月>\<日>\rollout-*.jsonl
 * 每个文件是一条 rollout，记录型 JSONL（每行一个 JSON 对象）。
 *
 * 用量来自 token_usage_record 记录，比 Claude 的粒度更细：
 *   input_tokens / cached_input_tokens / cache_write_input_tokens
 *   output_tokens / reasoning_output_tokens / total_tokens
 *
 * 关于中转站：会话元数据里 model_provider 为 "custom" 时表示走了自定义
 * 供应商（中转站）。本项目不做任何 provider 判定，只如实记录该字段，
 * 因为用量数据本身在本地就是完整的 —— 中转站不影响采集。
 *
 * 对应原 macOS 项目：AgentHUDCore/Providers/Codex/CodexTranscripts.swift
 *                   AgentHUDCore/Providers/Codex/CodexUsageProvider.swift
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { ParseCache } = require('./cache');

const CODEX_HOME = path.join(os.homedir(), '.codex');
const SESSIONS_DIR = path.join(CODEX_HOME, 'sessions');

/** 解析结果缓存：Codex 单目录可达数百 MB，未变更的文件直接复用。 */
const cache = new ParseCache();

/*
 * 官方登录态的百分比额度（ChatGPT 订阅版 Codex 的 5 小时 / 周窗口）。
 *
 * 数据来自每轮响应的 event_msg/token_count → rate_limits：
 *   { limit_id, limit_name, primary: { used_percent, window_minutes, resets_at },
 *     secondary: {...} | null, credits, plan_type, ... }
 * 官方登录（auth.json 存在）时上游会真实回填；走中转站或未登录时字段整体为 null。
 *
 * 注意两点：
 *   1. 该字段与 model_provider 无关地出现在**每一条** token_count 里，但只有
 *      官方通路会带值 —— 所以解析时"取最近一条非空的"，末尾 null 不能覆盖前值
 *      （同一会话里官方值在前、中转 null 在后不会发生，但防御式解析更稳）。
 *   2. used_percent 是"该窗口已用百分比"，剩余比例 = 100 - used_percent。
 *      resets_at 实测可为 null（窗口刚开始时），此时重置时间未知，如实显示。
 */

/** Codex 把会话按 年/月/日 分目录存放。 */
function findRollouts(dir = SESSIONS_DIR, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) findRollouts(full, out);
    else if (e.isFile() && e.name.endsWith('.jsonl')) out.push(full);
  }
  return out;
}

function emptyUsage() {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    calls: 0,
    reasoningTokens: 0,
  };
}

/** 从文件名/路径提取会话 id。 */
function sessionIdOf(file) {
  const base = path.basename(file, '.jsonl');
  const m = base.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
  return m ? m[1] : base;
}

/** 项目名：取 cwd 的最后一段。 */
function projectOf(cwd) {
  if (!cwd) return 'unknown';
  const parts = cwd.split(/[\\/]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : cwd;
}

/**
 * 解析单个 rollout 文件。
 *
 * 注意实现细节：
 * - 文件可能很大（本机最大 25 MB / 数万行），逐行 split 后只做浅解析。
 * - token_usage_record 的 usage 是"该次响应"的增量，可直接累加。
 * - 用 model_provider 记录供应商；model 名取自 turn_context 或 session_meta。
 */
function parseRollout(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }

  const session = {
    source: 'codex',
    id: sessionIdOf(file),
    project: 'unknown',
    cwd: null,
    model: null,
    provider: null,
    lastAt: null,
    firstAt: null,
    usage: emptyUsage(),
    byModel: {},
    originator: null,
    cliVersion: null,
    rateLimits: null,
  };

  for (const line of raw.split('\n')) {
    const c = line.charCodeAt(0);
    if (c !== 123 /* '{' */) continue;

    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }

    if (rec.timestamp) {
      if (!session.firstAt) session.firstAt = rec.timestamp;
      session.lastAt = rec.timestamp;
    }

    if (rec.type === 'session_meta' && rec.payload) {
      const p = rec.payload;
      session.cwd = p.cwd || session.cwd;
      session.project = projectOf(p.cwd);
      session.provider = p.model_provider || session.provider;
      session.originator = p.originator || session.originator;
      session.cliVersion = p.cli_version || session.cliVersion;
      continue;
    }

    if (rec.type === 'turn_context' && rec.payload) {
      // 模型名可能在 turn_context 里，优先用它
      const p = rec.payload;
      if (p.model && !session.model) session.model = p.model;
      if (p.cwd && session.project === 'unknown') session.project = projectOf(p.cwd);
      continue;
    }

    if (rec.type === 'event_msg' && rec.payload && rec.payload.type === 'token_count') {
      // 官方登录态的百分比额度随每轮 token_count 下发；只记最近一条非空的。
      if (rec.payload.rate_limits) {
        const norm = normalizeRateLimits(rec.payload.rate_limits, rec.timestamp || session.lastAt);
        if (norm) session.rateLimits = norm;
      }
      continue;
    }

    if (rec.type === 'token_usage_record' && rec.payload && rec.payload.usage) {
      const u = rec.payload.usage;
      session.usage.inputTokens += u.input_tokens || 0;
      session.usage.outputTokens += u.output_tokens || 0;
      session.usage.cacheReadTokens += u.cached_input_tokens || 0;
      session.usage.cacheCreationTokens += u.cache_write_input_tokens || 0;
      session.usage.reasoningTokens += u.reasoning_output_tokens || 0;
      session.usage.calls += 1;
    }
  }

  if (!session.model) session.model = 'codex';
  if (!session.provider) session.provider = 'custom';
  return session;
}

/**
 * 归一化一条 rate_limits 文档（纯函数，便于单测）。
 *
 * 返回 null 表示"这条没有官方百分比数据"（字段整体为 null，中转站/未登录的常态），
 * 调用方应保留上一个非空值而不是覆盖成 null。
 *
 * @param {object} rl rollout 里的 rate_limits 原始对象
 * @param {string} [ts] 该 token_count 记录的时间戳（ISO），用于「数据更新时刻」
 * @returns {{primary: {usedPercent:number, windowMinutes:number|null, resetsAt:string|null},
 *            secondary: 同形 | null, planType: string|null, fetchedAt: string|null} | null}
 */
function normalizeRateLimits(rl, ts = null) {
  if (!rl || typeof rl !== 'object') return null;
  const windowOf = (w) => {
    if (!w || typeof w !== 'object') return null;
    const used = Number(w.used_percent);
    if (!Number.isFinite(used)) return null;
    const minutes = Number.isFinite(Number(w.window_minutes)) ? Number(w.window_minutes) : null;
    const resetsAt = typeof w.resets_at === 'string' && w.resets_at ? w.resets_at : null;
    return { usedPercent: used, windowMinutes: minutes, resetsAt };
  };
  const primary = windowOf(rl.primary);
  if (!primary) return null; // 中转站/未登录：primary 为 null → 无官方百分比
  const secondary = windowOf(rl.secondary);
  return {
    primary,
    secondary,
    planType: typeof rl.plan_type === 'string' && rl.plan_type ? rl.plan_type : null,
    fetchedAt: typeof ts === 'string' ? ts : null,
  };
}

/**
 * 聚合官方登录态的百分比额度：取"最近更新"的那条会话的值。
 *
 * 为什么按 fetchedAt 而不是文件 mtime：同一时刻可能开着多个 Codex 会话，
 * 它们各自携带同一个账号的窗口数据，谁的时间戳新谁更可信。
 *
 * **新鲜度规则（必须有，否则旧数据冒充当前额度）**：
 * used_percent 是"该窗口已用百分比"，只在窗口内单调增长；窗口一旦过去
 * 就整体重置。所以一条记录只在满足以下全部条件时才算有效：
 *   1. 数据年龄 < 窗口时长（now - fetchedAt < window_minutes）——
 *      超过窗宽数据必然已被重置（实测 9/23 的 24% 若不过滤，
 *      10/25 仍会显示"剩余 76%"，纯属误导）；
 *   2. resetsAt 可解析时不早于 now（已重置 → 旧值失效）。
 * 全库都没有有效值（纯中转站使用 / 数据全过期）时返回 null，
 * 调用方隐藏额度区，不显示假数据。
 *
 * @param {Array} sessions parseRollout 产出的会话数组
 * @param {number} [now] 当前时间戳（默认 Date.now()，测试可注入）
 * @returns {object|null}
 */
function collectOfficialQuota(sessions, now = Date.now()) {
  let best = null;
  for (const s of sessions || []) {
    const rl = s && s.rateLimits;
    if (!rl || !rl.primary) continue;
    const fetchedMs = rl.fetchedAt ? Date.parse(rl.fetchedAt) : NaN;
    if (!Number.isFinite(fetchedMs)) continue;
    // 条件 1：数据年龄不得超过其窗口时长
    const windowMs = Number.isFinite(rl.primary.windowMinutes)
      ? rl.primary.windowMinutes * 60 * 1000
      : 0;
    if (windowMs > 0 && now - fetchedMs >= windowMs) continue;
    // 条件 2：resetsAt 已过 → 窗口已重置，旧值失效
    const resetMs = rl.primary.resetsAt ? Date.parse(rl.primary.resetsAt) : NaN;
    if (Number.isFinite(resetMs) && resetMs <= now) continue;
    if (!best || String(rl.fetchedAt || '') > String(best.fetchedAt || '')) {
      best = rl;
    }
  }
  return best;
}

/** 采集全部 Codex 会话。 */
function collect({ limit = 0 } = {}) {
  const files = findRollouts();
  const sessions = [];

  // 按修改时间倒序，优先解析最近的会话
  const withStat = [];
  for (const f of files) {
    try {
      withStat.push({ f, mtime: fs.statSync(f).mtimeMs });
    } catch {
      /* 忽略无法访问的文件 */
    }
  }
  withStat.sort((a, b) => b.mtime - a.mtime);

  const target = limit > 0 ? withStat.slice(0, limit) : withStat;
  for (const { f } of target) {
    // 走缓存：文件未变更时跳过读取与解析
    const s = cache.get(f, parseRollout);
    if (s) sessions.push(s);
  }
  cache.prune(withStat.map((x) => x.f));
  return sessions;
}

module.exports = {
  cache,
  CODEX_HOME,
  SESSIONS_DIR,
  findRollouts,
  parseRollout,
  collect,
  emptyUsage,
  sessionIdOf,
  projectOf,
  normalizeRateLimits,
  collectOfficialQuota,
};
