'use strict';

/**
 * DSH（DeepSeek Harness）本地会话数据采集器。
 *
 * 数据源：%USERPROFILE%\.dsh\sessions\<项目目录>\session-<uuid>\session.v4.jsonl.zstd
 *
 * 与其它源不同，这里有两层格式障碍，都必须正确处理：
 *   1. 文件是 zstd 压缩。Node 24 有 zlib.zstdDecompressSync，但它对这类
 *      多帧文件只解出第一帧（实测 478 KB 只解出 210 字节）。Electron 内置
 *      Node 20 更是完全没有 zstd API。因此这里调用外部 zstd 可执行文件。
 *   2. 解压后的内容是 UTF-16 LE（BOM ff fe），不是 UTF-8。
 *      用 utf8 读会得到满屏 \x00 交错的乱码。
 *
 * 用量来自 assistant/message 记录的 data.usage：
 *   { inputTokens, outputTokens, totalTokens, ... }
 * 模型名在 data.message.source.model，供应商在 data.message.source.provider。
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const { ParseCache } = require('./cache');

const DSH_HOME = path.join(os.homedir(), '.dsh');
const SESSIONS_DIR = path.join(DSH_HOME, 'sessions');

/**
 * 解析结果缓存。收益最大的一处：每个文件要启动一次外部 zstd 进程
 * （实测 25 ms × 23 文件约 575 ms），文件未变更时可直接跳过。
 */
const cache = new ParseCache();

/** 候选 zstd 可执行文件位置（本机实测 msys64 可用）。 */
const ZSTD_CANDIDATES = [
  'zstd',
  'C:\\msys64\\mingw64\\bin\\zstd.exe',
  'C:\\Program Files\\Git\\usr\\bin\\zstd.exe',
];

let zstdPath = undefined; // undefined = 未探测, null = 不可用

/** 探测系统里可用的 zstd。 */
function findZstd() {
  if (zstdPath !== undefined) return zstdPath;
  for (const cand of ZSTD_CANDIDATES) {
    try {
      execFileSync(cand, ['--version'], { stdio: 'ignore', timeout: 5000 });
      zstdPath = cand;
      return zstdPath;
    } catch {
      /* 试下一个 */
    }
  }
  zstdPath = null;
  return null;
}

/** 递归找出所有 session.v4.jsonl.zstd。 */
function findSessions(dir = SESSIONS_DIR, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) findSessions(full, out);
    else if (e.isFile() && e.name.endsWith('.jsonl.zstd')) out.push(full);
  }
  return out;
}

/**
 * 解压 .zstd 并解码为文本。
 * 优先用外部 zstd（可靠处理多帧）；不可用时退回 Node 内置（可能只能解第一帧）。
 */
function readZstd(file) {
  const z = findZstd();
  let buf;
  if (z) {
    buf = execFileSync(z, ['-d', '-c', file], { maxBuffer: 512 * 1024 * 1024, timeout: 60000 });
  } else {
    const zlib = require('zlib');
    if (typeof zlib.zstdDecompressSync !== 'function') {
      throw new Error('无可用 zstd 解码器：既没有 zstd 可执行文件，Node 也没有 zstd API');
    }
    buf = zlib.zstdDecompressSync(fs.readFileSync(file));
  }

  // UTF-16 LE（BOM ff fe）与 UTF-8 自适应
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return buf.toString('utf16le');
  }
  return buf.toString('utf8');
}

function emptyUsage() {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, calls: 0 };
}

/** 从路径取项目名：sessions 下的一级目录，形如 --D-Main_FIles-agent-view-hub-- */
function projectOf(file) {
  const rel = path.relative(SESSIONS_DIR, file);
  const seg = rel.split(path.sep)[0] || 'unknown';
  return seg.replace(/^--/, '').replace(/--$/, '').replace(/-/g, ' ').trim() || 'unknown';
}

function sessionIdOf(file) {
  const m = file.match(/session-([0-9a-f-]{36})/i);
  return m ? m[1] : path.basename(path.dirname(file));
}

/**
 * 解析单个 DSH 会话。
 *
 * assistant/message 的 usage 是该次响应增量，直接累加。
 * 同一文件里可能有多个 turn，全部计入。
 */
function parseSession(file) {
  let text;
  try {
    text = readZstd(file);
  } catch (err) {
    return { error: String(err.message || err), file };
  }

  const session = {
    source: 'dsh',
    id: sessionIdOf(file),
    project: projectOf(file),
    cwd: null,
    model: null,
    provider: null,
    lastAt: null,
    firstAt: null,
    usage: emptyUsage(),
    byModel: {},
  };

  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const c0 = trimmed.charCodeAt(0);
    if (c0 !== 123 /* '{' */) continue;

    let rec;
    try {
      rec = JSON.parse(trimmed);
    } catch {
      continue;
    }

    // 会话元数据
    if (rec.type === 'session' && !session.cwd) {
      session.cwd = rec.cwd || null;
      continue;
    }

    // 时间戳：DSH 用毫秒 time
    if (typeof rec.time === 'number') {
      const iso = new Date(rec.time).toISOString();
      if (!session.firstAt) session.firstAt = iso;
      session.lastAt = iso;
    }

    if (rec.type !== 'assistant/message') continue;
    const data = rec.data;
    if (!data) continue;

    const msg = data.message;
    if (msg && msg.source) {
      if (msg.source.model && !session.model) session.model = msg.source.model;
      const p = msg.source.provider;
      // 数据里存在字符串 "null" 这样的脏值，按缺失处理
      if (p && p !== 'null' && !session.provider) session.provider = p;
    }

    const u = data.usage;
    if (!u) continue;

    const input = u.inputTokens || 0;
    const output = u.outputTokens || 0;
    const cacheRead = u.cacheReadTokens || u.cachedInputTokens || 0;
    const cacheCreate = u.cacheCreationTokens || u.cacheWriteInputTokens || 0;

    session.usage.inputTokens += input;
    session.usage.outputTokens += output;
    session.usage.cacheReadTokens += cacheRead;
    session.usage.cacheCreationTokens += cacheCreate;
    session.usage.calls += 1;

    const model = (msg && msg.source && msg.source.model) || session.model || 'unknown';
    if (!session.byModel[model]) session.byModel[model] = emptyUsage();
    const bm = session.byModel[model];
    bm.inputTokens += input;
    bm.outputTokens += output;
    bm.cacheReadTokens += cacheRead;
    bm.cacheCreationTokens += cacheCreate;
    bm.calls += 1;
  }

  if (!session.model) session.model = 'dsh';
  return session;
}

/** 采集全部 DSH 会话。 */
function collect({ limit = 0 } = {}) {
  const files = findSessions();
  const withStat = [];
  for (const f of files) {
    try {
      withStat.push({ f, mtime: fs.statSync(f).mtimeMs });
    } catch {
      /* 忽略 */
    }
  }
  withStat.sort((a, b) => b.mtime - a.mtime);

  const target = limit > 0 ? withStat.slice(0, limit) : withStat;
  const sessions = [];
  const errors = [];
  for (const { f } of target) {
    // 走缓存：文件未变更时跳过 zstd 解压
    const s = cache.get(f, parseSession);
    if (!s) continue;
    if (s.error) errors.push({ file: f, error: s.error });
    else sessions.push(s);
  }
  cache.prune(withStat.map((x) => x.f));
  if (errors.length) {
    // 不抛出：部分文件失败不应让整个源失败
    sessions.errors = errors;
  }
  return sessions;
}

module.exports = {
  cache,
  DSH_HOME,
  SESSIONS_DIR,
  findSessions,
  findZstd,
  readZstd,
  parseSession,
  collect,
  emptyUsage,
  projectOf,
  sessionIdOf,
};
