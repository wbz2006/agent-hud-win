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
    /** 上游限流事件（含服务端给的重置时刻与当时的模型），见 ratelimit.js。 */
    rateLimits: [],
    /**
     * 每个模型的调用时刻数组（仅保留近 48 小时），用于计算"当前限流窗口内
     * 该模型被调用了多少次"。按模型统计需要时间维度，byModel 只有总量。
     */
    modelCalls: {},
    /** 每个模型最近一次出现时的 provider，用于展示 "provider / model"。 */
    modelProviders: {},
  };

  /*
   * 当前生效的模型。llm/retry 记录本身**不带模型字段**，只有 provider，
   * 所以必须在按序解析时维护"当前模型"，限流发生时就近归属。
   *
   * 依据：实测 llm/retry 的 provider 字段不可靠（例如它仍写 workbuddy-vision，
   * 但当时模型已切到 workbuddy-ai 的 deepseek-v4.1-flash）。而下列记录的
   * model 字段可信且能覆盖 100% 的限流事件。
   */
  let curModel = null;
  let curProvider = null;
  const MODEL_CALL_KEEP_MS = 48 * 60 * 60 * 1000;

  /*
   * 从报错文本里提取上游给的重置时刻（时间戳）。
   *
   * 实测同一上游存在**中英文两种文案**，正则必须同时覆盖：
   *   CN: "您的使用量已超出频率限制，将在 2026-10-15 15:18:20 UTC+8 重置"
   *   EN: "usage exceeds frequency limit, ... your usage will reset at
   *        2026-10-15 17:33:05 UTC+8, alternatively, ..."
   * 仅匹配中文报文会导致英文报文 resetAt=null，被误判为"已恢复"。
   * 报错里标注 UTC+8，转时间戳时减 8 小时。
   */
  const RESET_AT_RE = /(?:将在|will reset at)\s*(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2}):(\d{2})/;
  const extractResetAt = (msg) => {
    const m = RESET_AT_RE.exec(msg);
    if (!m) return null;
    const ts = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4] - 8, +m[5], +m[6]);
    return Number.isNaN(ts) ? null : ts;
  };

  /*
   * 失败事件去重与分类。
   * 同一失败可能同时出现在 llm/retry 与 assistant/attempt（或多次重试），
   * 用 (kind|provider|model|10秒窗口|消息头) 做键去重。
   * kind 分类：soft_rate（有重置时间）/ free_tier（OpenCode 渠道禁止）/
   *           timeout / auth / other。
   */
  const seenErrors = new Set();
  const classifyFailure = (msg) => {
    if (/soft_rate/.test(msg)) return 'soft_rate';
    if (/FreeTierError|free tier/i.test(msg)) return 'free_tier';
    if (/timed out|timeout/i.test(msg)) return 'timeout';
    if (/401|unauthorized|api[ -]?key/i.test(msg)) return 'auth';
    return 'other';
  };
  const pushError = (provider, model, time, kind, resetAt) => {
    session.rateLimits.push({ time, provider: provider || curProvider, model: model || curModel, kind, resetAt });
  };
  const dedupKey = (kind, time, fmsg) =>
    `${kind}|${curProvider}|${curModel}|${Math.floor(time / 10000)}|${fmsg.slice(0, 60)}`;

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

    /*
     * 维护"当前模型"。这些记录带可信的 model 字段：
     *   - model/selection / request/header / request/context：模型切换时写入
     *   - assistant/message：每次成功调用都有（最密集，411/411 覆盖）
     * 顺序解析即可得到每个时刻生效的模型。
     */
    const dd = rec.data || {};
    if (
      rec.type === 'model/selection' &&
      dd.model
    ) {
      curModel = dd.model;
      curProvider = dd.provider || curProvider;
      continue;
    }
    if (rec.type === 'request/header' && dd.header && dd.header.config && dd.header.config.model) {
      curModel = dd.header.config.model;
      curProvider = dd.header.config.provider || curProvider;
      continue;
    }
    if (rec.type === 'request/context' && dd.model) {
      curModel = dd.model;
      curProvider = dd.provider || curProvider;
      continue;
    }

    // 上游失败事件：DSH 记录模型请求失败有两处——
    //   ① llm/retry：进入重试的失败（soft_rate、timeout 走这里）
    //   ② assistant/attempt 的 finish error：**不重试的终止性失败**
    //      （如 OpenCode 免费档 403 FreeTierError，实测只有 attempt 记录）
    if (rec.type === 'llm/retry' && rec.data && rec.data.failure) {
      const fmsg = String(rec.data.failure.message || '');
      const kind = classifyFailure(fmsg);
      const resetAt = extractResetAt(fmsg);
      const t = typeof rec.time === 'number' ? rec.time : Date.now();
      const dk = dedupKey(kind, t, fmsg);
      if (!seenErrors.has(dk)) {
        seenErrors.add(dk);
        pushError(curProvider, curModel, t, kind, resetAt);
      }
    }

    // 终止性失败（不重试，如 403 FreeTierError）：从 assistant/attempt 的 finish error 收集
    if (rec.type === 'assistant/attempt' && rec.data && Array.isArray(rec.data.stream)) {
      for (const c of rec.data.stream) {
        const fr = c && c.chunk && c.chunk.finish && c.chunk.finish.reason;
        if (!fr || fr.kind !== 'error' || !fr.failure) continue;
        const fmsg = String(fr.failure.message || '');
        const kind = classifyFailure(fmsg);
        const t = typeof rec.time === 'number' ? rec.time : Date.now();
        const dk = dedupKey(kind, t, fmsg);
        if (!seenErrors.has(dk)) {
          seenErrors.add(dk);
          pushError(curProvider, curModel, t, kind, extractResetAt(fmsg));
        }
      }
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
      // 成功调用是最可信的模型来源，同步更新当前模型
      if (msg.source.model) {
        curModel = msg.source.model;
        if (p && p !== 'null') curProvider = p;
      }
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

    // 记录该模型的调用时刻（限流窗口内按模型计次用），只保留近 48 小时
    if (typeof rec.time === 'number') {
      if (!session.modelCalls[model]) session.modelCalls[model] = [];
      session.modelCalls[model].push(rec.time);
      if (curProvider) session.modelProviders[model] = curProvider;
    }
  }

  // 裁剪过老的调用时刻，避免长会话把内存吃满
  const cutoff = Date.now() - MODEL_CALL_KEEP_MS;
  for (const [m, arr] of Object.entries(session.modelCalls)) {
    const kept = arr.filter((t) => t >= cutoff);
    if (kept.length) session.modelCalls[m] = kept;
    else delete session.modelCalls[m];
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
