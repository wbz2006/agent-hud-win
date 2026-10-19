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
};
