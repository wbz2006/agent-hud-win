'use strict';

/**
 * CC Switch 数据库探测层。
 *
 * 为什么单独拆一个文件：CC Switch 升级时**表名、字段名都可能变**。
 * 以前把 `cc-switch.db` / `proxy_request_logs` / `total_cost_usd` 全部写死，
 * 它一改版 HUD 的「今日花费」就整块失效，得改代码重新发布。
 *
 * 现在改成运行时探测：
 *   1. 找数据库 —— 搜常见目录里的 *.db，用"含请求日志表"判定，不认文件名
 *   2. 找表名   —— 按候选名列表匹配 sqlite_master
 *   3. 找字段名 —— 按同义词列表匹配 PRAGMA table_info，取第一个命中的
 *
 * 探测结果带缓存（TTL 60s）：采集每 30 秒一次，没必要每次都查 schema。
 * 缓存只在探测成功时生效；失败不缓存，让下一次采集有机会重试到。
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

/**
 * 候选数据库目录，按优先级排列。
 *
 * 第一个是当前版本的实际位置；后面的是历史位置/其他可能。
 * 用目录级候选而不是写死完整路径，是因为新版可能挪窝。
 */
const DB_DIR_CANDIDATES = [
  path.join(os.homedir(), '.cc-switch'),
  path.join(os.homedir(), '.ccswitch'),
  path.join(os.homedir(), 'AppData', 'Roaming', 'cc-switch'),
  path.join(os.homedir(), 'AppData', 'Roaming', 'CC Switch'),
];

/** 候选请求日志表名（按可能性排序）。 */
const TABLE_CANDIDATES = [
  'proxy_request_logs',
  'request_logs',
  'proxy_logs',
  'request_log',
];

/** 候选 app_type 字段（用来区分 Claude/Codex/DSH）。 */
const APP_TYPE_CANDIDATES = ['app_type', 'app', 'appType', 'source'];

/** 候选金额字段（美元口径的合计花费）。 */
const COST_CANDIDATES = [
  'total_cost_usd',
  'cost_usd',
  'total_cost',
  'cost',
  'total_cost_cny',
];

/** 候选创建时间字段（Unix 秒）。 */
const CREATED_AT_CANDIDATES = ['created_at', 'createdAt', 'timestamp', 'ts'];

/** 候选 provider 字段。 */
const PROVIDER_CANDIDATES = ['provider_id', 'providerId', 'provider'];

/** 候选模型名字段（用于按模型拆金额）。 */
const MODEL_CANDIDATES = ['model', 'request_model', 'model_name'];

/** 候选 provider 名称表（LEFT JOIN 用）。 */
const PROVIDER_TABLE_CANDIDATES = ['providers', 'provider'];

/** 探测结果缓存 TTL。采集间隔通常 10~60s，60s 足够覆盖又不至于太旧。 */
const CACHE_TTL_MS = 60 * 1000;

let cache = null; // { at, result }
let lastFailure = null; // 记住失败原因，降级时告诉用户

/** 执行一段 Python，返回 stdout。超时短一点：探测是热路径，别拖慢采集。 */
function runPy(script, timeout = 5000) {
  return execFileSync('python', ['-c', script], {
    encoding: 'utf8',
    timeout,
    windowsHide: true,
  });
}

/**
 * 在一个目录里找"可能是 CC Switch 主库"的 .db 文件。
 *
 * 判定标准：**文件能当 sqlite 打开且里面至少有张表**。
 * 不用"含请求日志表"来筛选 —— 那样会把无关库也跳过，
 * 于是"库里没有请求日志表"和"目录里没有库"两种情况给出同样错误，
 * 用户看不出差别（测试抓到的）。
 */
function findDbInDir(dir) {
  if (!dir || !fs.existsSync(dir)) return null;
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => /\.db$/i.test(f));
  } catch {
    return null;
  }
  // 主库文件名优先（cc-switch.db），其次看别的
  const ordered = files.sort((a, b) => {
    const score = (f) => (/cc.?switch\.db$/i.test(f) ? 0 : 1);
    return score(a) - score(b);
  });

  for (const f of ordered) {
    const full = path.join(dir, f);
    try {
      const out = runPy(`
import sqlite3, json
c = sqlite3.connect(${JSON.stringify(full)})
names = [r[0] for r in c.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()]
print(json.dumps(names))
`);
      const tables = JSON.parse(out.trim() || '[]');
      // 能打开且至少有张表 → 认它是候选库
      if (tables.length > 0) return { path: full, tables };
    } catch {
      // 这个库打不开或不是 sqlite，跳过
    }
  }
  return null;
}

/** 在多个候选目录里找数据库，返回 { path, tables } 或 null。 */
function locateDatabase() {
  for (const dir of DB_DIR_CANDIDATES) {
    const found = findDbInDir(dir);
    if (found) return found; // 已是 { path, tables }
  }
  return null;
}

/** 从候选列表里挑第一个真实存在的名字，没有则返回 null。 */
function pick(existing, candidates) {
  for (const c of candidates) {
    if (existing.includes(c)) return c;
  }
  return null;
}

/**
 * 探测一次，返回完整 schema 描述。
 *
 * 失败**一律不缓存**（这是刻意的）：CC Switch 可能在两次采集之间才启动、
 * 或者才释放数据库锁。缓存失败会让 HUD 在 60 秒内一直显示"不可用"，
 * 而其实只差一次重试。代价是失败时每轮都跑一次探测（约几十 ms），可接受。
 *
 * @returns {{ok: boolean, db?: string, logTable?: string, appType?: string|null,
 *            cost?: string|null, createdAt?: string|null, provider?: string|null,
 *            providerTable?: string|null, error?: string}}
 */
function probe(force = false) {
  const now = Date.now();
  if (!force && cache && now - cache.at < CACHE_TTL_MS) return cache.result;

  try {
    const db = locateDatabase();
    if (!db) {
      const err = '未找到 CC Switch 数据库（已搜索：' + DB_DIR_CANDIDATES.join('、') + '）';
      lastFailure = err;
      return { ok: false, error: err }; // 不缓存
    }

    // 金额字段是硬需求：没有它就等于没有"花费"这个核心数据
    const logTable = pick(db.tables, TABLE_CANDIDATES);
    if (!logTable) {
      const err = 'CC Switch 库里没有请求日志表（实际表：' + db.tables.join('、') + '）';
      lastFailure = err;
      return { ok: false, error: err, db: db.path, tables: db.tables }; // 不缓存
    }

    const colsOut = runPy(`
import sqlite3, json
c = sqlite3.connect(${JSON.stringify(db.path)})
cols = [r[1] for r in c.execute("PRAGMA table_info(${logTable})").fetchall()]
print(json.dumps(cols))
`);
    const cols = JSON.parse(colsOut.trim() || '[]');

    const cost = pick(cols, COST_CANDIDATES);
    if (!cost) {
      const err = '请求日志表缺少金额字段（实际字段：' + cols.join('、') + '）';
      lastFailure = err;
      return { ok: false, error: err, db: db.path, logTable, cols }; // 不缓存
    }

    const result = {
      ok: true,
      db: db.path,
      logTable,
      appType: pick(cols, APP_TYPE_CANDIDATES),
      cost,
      createdAt: pick(cols, CREATED_AT_CANDIDATES),
      provider: pick(cols, PROVIDER_CANDIDATES),
      model: pick(cols, MODEL_CANDIDATES),
      providerTable: pick(db.tables, PROVIDER_TABLE_CANDIDATES),
    };
    cache = { at: now, result };
    return result;
  } catch (err) {
    const msg = String((err && err.message) || err);
    lastFailure = /locked/i.test(msg) ? 'CC Switch 数据库被占用' : msg;
    const result = { ok: false, error: lastFailure };
    // 失败不缓存：让下次采集能重试到（CC Switch 释放锁之后就恢复了）
    return result;
  }
}

/** 取最近一次失败的原因，供上层做"为什么没有花费"的提示。 */
function lastError() {
  return lastFailure;
}

/** 清空缓存（测试用；也用于用户手动刷新）。 */
function resetCache() {
  cache = null;
}

module.exports = { probe, lastError, resetCache, DB_DIR_CANDIDATES, CACHE_TTL_MS };
