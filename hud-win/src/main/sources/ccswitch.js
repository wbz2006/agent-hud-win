'use strict';

/**
 * CC Switch 用量数据源。
 *
 * CC Switch（~/.cc-switch）是本机的 Claude Code / Codex 配置切换器，它在
 * SQLite（cc-switch.db）里逐条记录了每次请求的 token 与**已算好的金额**：
 *
 *   proxy_request_logs(request_id, provider_id, app_type, model,
 *                      input_tokens, output_tokens, cache_read_tokens,
 *                      cache_creation_tokens, input_cost_usd, output_cost_usd,
 *                      total_cost_usd, status_code, created_at, ...)
 *
 * 为什么用它而不用本地 token 估算：中转站计费规则不公开（倍率按渠道变化），
 * CC Switch 是用户自己实际付费的账本，金额是真实值而非估算。
 *
 * ## 对 CC Switch 的依赖与降级
 *
 * 这个模块对 CC Switch 是强依赖，而 CC Switch 升级时表名/字段名都可能变。
 * 为免每次都要改代码重新发布，这里分三层：
 *
 *   1. **自动探测**（ccdb.js）：找数据库、找表名、找字段名，全部按候选列表
 *      匹配而非写死。它改文件名、加后缀、挪目录都能自适应。
 *   2. **优雅降级**（本文件）：探测失败时**不抛错**，返回 { ok: false,
 *      reason: '...' }，上层据此把"今日花费"显示成"—"并附原因，
 *      其余数据（token / 会话 / 限流）照常工作。
 *   3. **缓存**（ccdb.js）：探测结果 60s TTL，不给热路径加 schema 查询开销。
 *
 * 读法上还有个坑：数据库正被 CC Switch 进程占用，必须**只读打开**并设
 * query_only，否则会拿到 "database is locked"。
 */

const path = require('path');
const { execFileSync } = require('child_process');
const ccdb = require('./ccdb');

/**
 * CC Switch 内部的人民币折算率。
 *
 * 实测（2026-10-17）：数据库 SUM(total_cost_usd) = $4.2342，
 * 而 CC Switch 界面显示 0.8498 —— 比值正好 **5.0**（真实汇率是 7.2，
 * 所以这不是汇率换算，是它内部固定的 1 USD = 5 CNY 折算）。
 * 也就是说：库里的 total_cost_usd 名义上叫 usd，界面上却按 ÷5 显示成"美元"。
 *
 * 用户实际看到的是 0.8498 这个数（且确认为人民币），所以 HUD 也用 ÷5 后的
 * 人民币值，符号标 ￥，避免把 $4.23 显示成"花了 4 美元"这种误导。
 *
 * 若将来 CC Switch 改了折算率，只需改这一个常量。
 */
const USD_TO_CNY = 5;

/** 美元 → 人民币（保留 4 位，够显示到分） */
function toCny(usd) {
  return Math.round((usd || 0) / USD_TO_CNY * 1e4) / 1e4;
}

/**
 * 探测失败时的统一返回。
 *
 * 关键：**不抛异常**。调用方（worker）本来用 try/catch 包着，抛出去会让
 * 整个采集失败 → 红框 → 用户以为 HUD 坏了。返回结构化失败让上层
 * 只把"花费"这一栏降级。
 */
function degrade(reason) {
  return {
    ok: false,
    reason,
    byApp: {},
    totalUsd: null,
    totalCny: null,
  };
}

/**
 * 在探测到的 schema 上跑一段只读 SQL，返回解析后的 JSON。
 *
 * @param {string} sql SQL 语句
 * @param {number} timeout 毫秒
 */
function query(sql, timeout = 6000) {
  // 用 Python 的 sqlite3 读：Node 内置没有 sqlite 模块，而引入 better-sqlite3
  // 会多一个原生依赖（本机打包要走镜像，依赖越少越稳）。
  const script = `
import sqlite3, json
c = sqlite3.connect(${JSON.stringify(ccdb.probe().db)}, uri=False)
c.execute("PRAGMA query_only = ON")
rows = c.execute(${JSON.stringify(sql)}).fetchall()
print(json.dumps(rows, ensure_ascii=False))
`;
  const stdout = execFileSync('python', ['-c', script], {
    encoding: 'utf8',
    timeout,
    windowsHide: true,
  });
  return JSON.parse(stdout.trim() || '[]');
}

/** 探测失败时把原因翻译成用户能看懂的话。 */
function failReason() {
  const e = ccdb.lastError();
  if (!e) return 'CC Switch 数据不可用';
  if (/locked/i.test(e)) return 'CC Switch 正在写入，稍后自动恢复';
  if (/未找到/.test(e)) return '未检测到 CC Switch 账本';
  return e;
}

/**
 * 今日（本地时区）各 app_type 的金额与请求数。
 *
 * @returns {{ok:boolean, byApp?:object, totalUsd?:number, totalCny?:number,
 *            unit?:string, reason?:string}}
 *   byApp: { codex: { usd, cny, requests }, claude: {...}, ... }
 *   reason 仅在 ok=false 时出现，说明为什么没有数据（供 UI 展示）。
 */
function readTodayCost() {
  const s = ccdb.probe();
  if (!s.ok) return degrade(failReason());

  // 没有 app_type 列时，退化到"只统计总数"—— 比完全失败好
  const hasApp = !!s.appType;
  const hasCreated = !!s.createdAt;

  // SQLite 的 date(created_at,'unixepoch','localtime') 会用系统本地时区换算，
  // 与"今日"的直觉一致。字段不存在时退化为全量统计（宁可少一个筛选，
  // 也不要因为缺一列就整块失败）。
  const where = hasCreated
    ? `WHERE date(${s.createdAt}, 'unixepoch', 'localtime') = date('now', 'localtime')`
    : '';
  const selectApp = hasApp ? s.appType : 'NULL';
  const sql = `
    SELECT ${selectApp} AS app,
           COUNT(*) AS req,
           SUM(CAST(${s.cost} AS REAL)) AS usd
    FROM ${s.logTable}
    ${where}
    GROUP BY app
  `;

  try {
    const rows = query(sql);
    const byApp = {};
    let total = 0;
    for (const [app, req, usd] of rows) {
      const u = Number(usd || 0);
      const key = app == null ? '_all' : String(app);
      byApp[key] = { usd: u, cny: toCny(u), requests: Number(req || 0) };
      total += u;
    }
    return {
      ok: true,
      byApp,
      totalUsd: total,
      totalCny: toCny(total),
      unit: '¥',
    };
  } catch (err) {
    const msg = String((err && err.message) || err);
    return degrade(/locked/i.test(msg) ? 'CC Switch 正在写入，稍后自动恢复' : msg);
  }
}

/**
 * 今日某个 provider 的金额（用于圆环）。
 *
 * @param {string|null} providerId CC Switch 的 provider_id；传 null 取全部
 */
function readTodayCostBy(providerId) {
  const all = readTodayCost();
  if (!providerId) {
    return {
      ...all,
      usd: all.ok ? all.totalUsd : null,
      cny: all.ok ? all.totalCny : null,
    };
  }

  const s = ccdb.probe();
  if (!s.ok) return degrade(failReason());
  if (!s.provider) return degrade('CC Switch 日志表缺少 provider 字段');

  const where = s.createdAt
    ? `AND date(${s.createdAt}, 'unixepoch', 'localtime') = date('now', 'localtime')`
    : '';
  const sql = `
    SELECT COUNT(*) AS req, SUM(CAST(${s.cost} AS REAL)) AS usd
    FROM ${s.logTable}
    WHERE ${s.provider} = ${JSON.stringify(providerId)}
    ${where}
  `;
  try {
    const rows = query(sql);
    const [req, usd] = rows[0] || [0, 0];
    const u = Number(usd || 0);
    return { ok: true, usd: u, cny: toCny(u), requests: Number(req || 0), unit: '¥' };
  } catch (err) {
    const msg = String((err && err.message) || err);
    return degrade(/locked/i.test(msg) ? 'CC Switch 正在写入，稍后自动恢复' : msg);
  }
}

/**
 * CC Switch 里的 provider_id 列表（供设置页挑选）。
 * 只列有请求记录的，方便定位"哪个是中转站"。
 */
function listProviders() {
  const s = ccdb.probe();
  if (!s.ok) return { ok: false, error: failReason() };

  // provider 表可能不存在（或改了名），此时退化为不 JOIN ——
  // 拿不到友好名称就用 id 本身，不影响列表可用。
  const join = s.providerTable && s.provider
    ? `LEFT JOIN ${s.providerTable} p ON p.id = l.${s.provider}`
    : '';
  const nameCol = s.providerTable && s.provider
    ? `COALESCE(p.name, l.${s.provider})`
    : `l.${s.provider || 'rowid'}`;
  const groupCol = s.provider || 'rowid';

  const sql = `
    SELECT l.${groupCol} AS pid,
           ${nameCol} AS name,
           NULL AS url,
           COUNT(*) AS req,
           SUM(CAST(l.${s.cost} AS REAL)) AS usd
    FROM ${s.logTable} l
    ${join}
    GROUP BY pid
    ORDER BY usd DESC
  `;
  try {
    const rows = query(sql, 8000);
    return {
      ok: true,
      providers: rows.map((r) => ({
        provider_id: r[0],
        name: r[1] != null ? String(r[1]) : String(r[0]),
        url: r[2],
        requests: Number(r[3] || 0),
        usd: Number(r[4] || 0),
      })),
    };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
}

module.exports = {
  readTodayCost,
  readTodayCostBy,
  listProviders,
  toCny,
  USD_TO_CNY,
};
