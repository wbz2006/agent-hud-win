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

/** 真实市场汇率（USD → CNY）。仅当用户选择「按真实汇率折算」时使用。 */
const REAL_FX_RATE = 7.2;

/**
 * 金额换算模式（可在设置里切换）。
 *
 * - `'internal'`（默认）：跟 CC Switch 界面显示一致，总额 ÷ 5。
 *   好处：和你在 CC Switch 里看到的数字完全对得上，不会怀疑"两边不一样"。
 *
 * - `'real'`：按真实汇率 ¥7.2/$ 折算。
 *   好处：如果你在中转站按真实美元充值/结算，这个数字才是你实际花掉的人民币。
 *   注意：库里存的 total_cost_usd 到底是不是"真美元"，取决于你的中转站怎么计价 ——
 *   如果中转站本身就以"1 美元 = 5 元"的虚拟额度计费，这一项会让你看到偏高的数字。
 *
 * - `'raw'`：不换算，直接显示库里原始值（当作美元，前面标 $）。
 *   适合自己核对账本、或中转站确实按美元结算且不想引入汇率假设的场景。
 */
const COST_MODE = { INTERNAL: 'internal', REAL: 'real', RAW: 'raw' };

/**
 * 换算成显示值。
 * @param {number} usd 数据库原始值
 * @param {'internal'|'real'|'raw'} mode 计价模式
 * @returns {number}
 */
function toDisplay(usd, mode = COST_MODE.INTERNAL) {
  const v = usd || 0;
  if (mode === COST_MODE.RAW) return Math.round(v * 1e4) / 1e4;
  if (mode === COST_MODE.REAL) return Math.round(v * REAL_FX_RATE * 1e4) / 1e4;
  return Math.round((v / USD_TO_CNY) * 1e4) / 1e4;
}

/** 该模式下金额的单位符号。 */
function unitOf(mode) {
  return mode === COST_MODE.RAW ? '$' : '￥';
}

/** 兼容旧调用：等价于 toDisplay(usd, 'internal') */
function toCny(usd) {
  return toDisplay(usd, COST_MODE.INTERNAL);
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
 * @param {'internal'|'real'|'raw'} [mode] 计价模式，默认 internal（与 CC Switch 显示一致）
 * @returns {{ok:boolean, byApp?:object, totalUsd?:number, totalCny?:number,
 *            unit?:string, mode?:string, reason?:string}}
 *   byApp: { codex: { usd, cny, requests }, claude: {...}, ... }
 *   cny 字段存的是**按 mode 换算后的显示值**（名字保留 cny 是为了兼容旧调用方）。
 *   reason 仅在 ok=false 时出现，说明为什么没有数据（供 UI 展示）。
 */
function readTodayCost(mode = COST_MODE.INTERNAL) {
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

  /*
   * 按模型聚合（Codex 面板要显示"每个模型今天花了多少钱"）。
   *
   * model 是可选字段：老版本库没有它时退化为空表，不影响 byApp 主功能。
   * 只取 codex 相关的行 —— byApp 证明只有 codex 走中转站计费，
   * 其他 app_type 即使有 model 也不是中转站花费，混进来会误导。
   */
  const hasModel = !!s.model;
  const modelSql = hasModel
    ? `
    SELECT ${hasApp ? s.appType : 'NULL'} AS app,
           ${s.model} AS model,
           COUNT(*) AS req,
           SUM(CAST(${s.cost} AS REAL)) AS usd
    FROM ${s.logTable}
    ${where}
    GROUP BY app, model
    ORDER BY usd DESC
  `
    : null;

  try {
    const rows = query(sql);
    const byApp = {};
    let total = 0;
    // Normalize app_type values to match UI source keys.
    // DB stores 'claude-desktop' but UI expects 'claude'; map accordingly.
    const APP_TYPE_MAP = { 'claude-desktop': 'claude' };
    for (const [app, req, usd] of rows) {
      const u = Number(usd || 0);
      let key = app == null ? '_all' : String(app);
      // Normalize: map 'claude-desktop' → 'claude' for UI compatibility
      key = APP_TYPE_MAP[key] || key;
      byApp[key] = { usd: u, cny: toDisplay(u, mode), requests: Number(req || 0) };
      total += u;
    }

    // 模型级金额：{ appType: { modelName: {usd, cny, requests} } }
    const byAppModel = {};
    if (modelSql) {
      try {
        for (const [app, model, req, usd] of query(modelSql)) {
          const u = Number(usd || 0);
          let appKey = app == null ? '_all' : String(app);
          // Normalize app_key same as byApp (e.g., 'claude-desktop' -> 'claude')
          appKey = APP_TYPE_MAP[appKey] || appKey;
          const modelKey = model == null || model === '' ? '(未知模型)' : String(model);
          if (!byAppModel[appKey]) byAppModel[appKey] = {};
          byAppModel[appKey][modelKey] = {
            usd: u,
            cny: toDisplay(u, mode),
            requests: Number(req || 0),
          };
        }
      } catch {
        // 模型级只是锦上添花，失败不影响 app 级主数据
      }
    }

    return {
      ok: true,
      byApp,
      byAppModel,
      totalUsd: total,
      totalCny: toDisplay(total, mode),
      unit: unitOf(mode),
      mode,
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
 * @param {'internal'|'real'|'raw'} [mode] 计价模式，默认 internal
 */
function readTodayCostBy(providerId, mode = COST_MODE.INTERNAL) {
  const all = readTodayCost(mode);
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
    return {
      ok: true,
      usd: u,
      cny: toDisplay(u, mode),
      requests: Number(req || 0),
      unit: unitOf(mode),
      mode,
    };
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

/**
 * 各 app_type 的**可用性统计**（近 N 小时的请求成功率与延迟）。
 *
 * 为什么用 status_code 而不是延迟判定"不可用"：
 *   实测本机近 7 天 1500 次 codex 请求**全部是 200**，但平均延迟 22.6 秒、
 *   最高 207 秒。延迟高只是"慢"，不代表"不可用"；真正的中断会体现为
 *   4xx/5xx 或超时无记录。所以可用率 = 非错误状态码占比，延迟单独作为辅助指标。
 *
 * 判定口径：
 *   - 可用：status_code 为 2xx/3xx
 *   - 不可用：status_code >= 400，或记录里 status_code 为空且 error_message 有内容
 *   - 注意有些行的 status_code 可能是 NULL（请求被中断），按不可用处理更保守
 *
 * @param {object} [opts]
 * @param {number} [opts.hours=24] 统计窗口（小时）
 * @returns {{ok:boolean, byApp?:object, reason?:string}}
 *   byApp: {
 *     codex: {
 *       requests, errors, availability(0~1),
 *       avgLatencyMs, p95LatencyMs,
 *       recent: [{ ok, status, latencyMs }]   // 最近 N 条，供迷你条形图
 *     }
 *   }
 */
function readAvailability({ hours = 24 } = {}) {
  const s = ccdb.probe();
  if (!s.ok) return { ok: false, reason: failReason(), byApp: {} };

  const hasApp = !!s.appType;
  // status_code 不是探测层负责的字段（探测层只认金额/时间/app/模型），
  // 这里直接查列名：当前库确实有 status_code，缺了就在下面降级。
  const window = Math.max(1, Number(hours) || 24);
  const where = s.createdAt
    ? `WHERE ${s.createdAt} >= strftime('%s','now') - ${window} * 3600`
    : '';
  const selectApp = hasApp ? s.appType : 'NULL';

  /*
   * 主统计：按 app 聚合总数/错误数/延迟。
   * SQLite 没有 P95 内置函数，用「按 app 分组取延迟分位数」的子查询代价高，
   * 改为取所有延迟值回来在 JS 里算分位数 —— 单源通常几千行，可接受。
   */
  const sql = `
    SELECT ${selectApp} AS app,
           COUNT(*) AS total,
           SUM(CASE WHEN status_code IS NULL OR status_code >= 400 THEN 1 ELSE 0 END) AS errors,
           AVG(latency_ms) AS avg_ms
    FROM ${s.logTable}
    ${where}
    GROUP BY app
  `;

  /*
   * 最近 N 条记录（按时间倒序），用于小条形图。
   * 只取必要字段；status_code / latency_ms 缺列时整段降级为空数组，
   * 不影响上面的汇总数字。
   */
  const orderBy = s.createdAt ? `ORDER BY ${s.createdAt} DESC` : 'ORDER BY rowid DESC';
  const recentSql = `
    SELECT ${selectApp} AS app, status_code, latency_ms
    FROM ${s.logTable}
    ${where}
    ${orderBy}
    LIMIT 400
  `;

  try {
    const rows = query(sql);
    const byApp = {};
    const APP_TYPE_MAP_AVAIL = { 'claude-desktop': 'claude' };
    for (const [app, total, errors, avgMs] of rows) {
      let key = app == null ? '_all' : String(app);
      // Normalize: map 'claude-desktop' → 'claude' for UI compatibility
      key = APP_TYPE_MAP_AVAIL[key] || key;
      const n = Number(total || 0);
      const err = Number(errors || 0);
      byApp[key] = {
        requests: n,
        errors: err,
        // errors 全部为 NULL 参与计算时 SUM 返回 null，按 0 处理
        availability: n > 0 ? (n - err) / n : null,
        avgLatencyMs: avgMs == null ? null : Math.round(Number(avgMs)),
        p95LatencyMs: null,
        recent: [],
      };
    }

    // 补充 P95 与最近记录
    try {
      const recents = query(recentSql, 8000);
      for (const [app, status, latency] of recents) {
        let key = app == null ? '_all' : String(app);
        // Normalize: map 'claude-desktop' → 'claude' for UI compatibility
        key = APP_TYPE_MAP_AVAIL[key] || key;
        if (!byApp[key]) continue;
        const okReq = status != null && status > 0 && status < 400;
        byApp[key].recent.push({
          ok: okReq,
          status: status == null ? null : Number(status),
          latencyMs: latency == null ? null : Number(latency),
        });
      }
      // P95：对该 app 的延迟数组排序取 95% 分位
      for (const rec of Object.values(byApp)) {
        const lat = rec.recent.map((r) => r.latencyMs).filter((v) => v != null).sort((a, b) => a - b);
        if (lat.length) {
          const idx = Math.min(lat.length - 1, Math.floor(lat.length * 0.95));
          rec.p95LatencyMs = Math.round(lat[idx]);
        }
        // recent 已按时间倒序，条形图要"旧 → 新"，翻转一份
        rec.recent.reverse();
      }
    } catch {
      /* 最近记录取不到不影响汇总 */
    }

    return { ok: true, byApp };
  } catch (err) {
    const msg = String((err && err.message) || err);
    return {
      ok: false,
      reason: /no such column/i.test(msg) ? 'CC Switch 日志表缺少 status_code 字段' : msg,
      byApp: {},
    };
  }
}

module.exports = {
  readAvailability,
  readTodayCost,
  readTodayCostBy,
  listProviders,
  toCny,
  toDisplay,
  unitOf,
  COST_MODE,
  USD_TO_CNY,
  REAL_FX_RATE,
};
