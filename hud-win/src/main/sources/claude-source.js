'use strict';

/**
 * Claude Code 本地会话数据采集器。
 *
 * 数据源（Windows）：%USERPROFILE%\.claude\projects\<项目目录>\<sessionId>.jsonl
 * 每条 assistant 记录的 message.usage 携带 token 用量。
 *
 * 对应原 macOS 项目：
 *   AgentHUDCore/Providers/Claude/ClaudeTranscriptStore.swift
 *   AgentHUDCore/Providers/Claude/ClaudeTranscriptParser.swift
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { ParseCache } = require('./cache');

const CLAUDE_HOME = path.join(os.homedir(), '.claude');
const PROJECTS_DIR = path.join(CLAUDE_HOME, 'projects');

/** 解析结果缓存：文件未变更时复用上次结果。 */
const cache = new ParseCache();

/** 递归找出所有 .jsonl 会话文件。 */
function findTranscripts(dir = PROJECTS_DIR, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      findTranscripts(full, out);
    } else if (e.isFile() && e.name.endsWith('.jsonl')) {
      out.push(full);
    }
  }
  return out;
}

function emptyUsage() {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    calls: 0,
  };
}

function addUsage(into, u) {
  into.inputTokens += u.input_tokens || 0;
  into.outputTokens += u.output_tokens || 0;
  into.cacheCreationTokens += u.cache_creation_input_tokens || 0;
  into.cacheReadTokens += u.cache_read_input_tokens || 0;
  into.calls += 1;
  return into;
}

/** 从文件路径还原项目名（Claude 用目录名编码路径，形如 D--Users-Foo-bar）。 */
function projectNameFromPath(file) {
  const rel = path.relative(PROJECTS_DIR, file);
  const seg = rel.split(path.sep)[0] || 'unknown';
  return seg.replace(/^--?/, '').replace(/--?$/, '').replace(/-/g, ' ').trim() || 'unknown';
}

/**
 * 解析单个会话文件。
 * 逐行读取，跳过非法 JSON 行，容忍写入中途的截断行。
 */
function parseTranscript(file) {
  const session = {
    source: 'claude',
    id: path.basename(file, '.jsonl'),
    project: projectNameFromPath(file),
    cwd: null,
    model: null,
    provider: null,
    file,
    mtime: 0,
    firstAt: null,
    lastAt: null,
    usage: emptyUsage(),
    byModel: {},
    costUSD: 0,
  };

  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return null;
  }
  session.mtime = stat.mtimeMs;

  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }

  for (const line of raw.split('\n')) {
    if (!line || line.charCodeAt(0) !== 123 /* '{' */) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue; // 截断行 / 非法行，跳过
    }

    if (rec.timestamp) {
      if (!session.firstAt) session.firstAt = rec.timestamp;
      session.lastAt = rec.timestamp;
    }

    if (rec.type === 'cost-state' && typeof rec.totalCostUSD === 'number') {
      session.costUSD = rec.totalCostUSD;
      continue;
    }

    if (rec.type !== 'assistant') continue;
    const msg = rec.message;
    if (!msg) continue;

    if (msg.model && msg.model !== '<synthetic>' && !session.model) session.model = msg.model;
    if (rec.cwd && !session.cwd) session.cwd = rec.cwd;

    const u = msg.usage;
    if (u) {
      addUsage(session.usage, u);
      const model = msg.model || 'unknown';
      if (!session.byModel[model]) session.byModel[model] = emptyUsage();
      addUsage(session.byModel[model], u);
    }
  }

  if (!session.model) session.model = 'claude';
  return session;
}

/** 采集全部会话。 */
function collect({ since = 0 } = {}) {
  const files = findTranscripts();
  const sessions = [];
  for (const f of files) {
    try {
      const st = fs.statSync(f);
      if (st.mtimeMs < since) continue;
    } catch {
      continue;
    }
    // 走缓存：文件未变更时跳过读取与解析
    const s = cache.get(f, parseTranscript);
    if (s) sessions.push(s);
  }
  cache.prune(files);
  sessions.sort((a, b) => b.mtime - a.mtime);
  return sessions;
}

module.exports = {
  cache,
  CLAUDE_HOME,
  PROJECTS_DIR,
  findTranscripts,
  parseTranscript,
  collect,
  emptyUsage,
};
