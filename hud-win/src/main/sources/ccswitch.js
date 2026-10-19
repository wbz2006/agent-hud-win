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
 * 实测（2026-10-17）：
 *   - 2923 条记录，最新到 2026-10-16 10:40
 *   - provider_id = '_codex_session' 的 1694 条合计 $180.26 —— 走中转站的 Codex 会话
 *   - CC Switch 自己按 model_pricing 表（222 条）算好了金额，**不需要我们再算**
 *   - created_at 是 Unix 秒
 *
 * 为什么用它而不用本地 token 估算：中转站计费规则不公开（倍率按渠道变化），
 * CC Switch 是用户自己实际付费的账本，金额是真实值而非估算。
 *
 * 读法上有个坑：数据库正被 CC Switch 进程占用，必须**只读打开**并设
 * immutable，否则会拿到 "database is locked"。这里用 file: URI + mode=ro。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const HOME = os.homedir();
const CC_DIR = path.join(HOME, '.cc-switch');
const DB = path.join(CC_DIR, 'cc-switch.db');

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
 * 今日（本地时区）各 app_type 的金额与请求数。
 * @returns {{ok:boolean, byApp?:object, totalUsd?:number, totalCny?:number, error?:string}}
 *   byApp: { codex: { usd, cny, requests }, claude: {...}, ... }
 *   界面显示用 cny（人民币）；usd 保留以备核对原始值。
 */
function readTodayCost() {
  if (!fs.existsSync(DB)) {
    return { ok: false, error: '未找到 CC Switch 数据库：' + DB };
  }

  // SQLite 的 date(created_at,'unixepoch','localtime') 会用系统本地时区换算，
  // 与"今日"的直觉一致。
  const sql = `
    SELECT app_type,
           SUM(request_count) AS req,
           SUM(CAST(total_cost_usd AS REAL)) AS usd
    FROM (
      SELECT app_type, 1 AS request_count, total_cost_usd
      FROM proxy_request_logs
      WHERE date(created_at, 'unixepoch', 'localtime') = date('now', 'localtime')
    )
    GROUP BY app_type
  `;

  try {
    // 用 Python 的 sqlite3 读：Node 内置没有 sqlite 模块，而引入 better-sqlite3
    // 会多一个原生依赖（本机打包要走镜像，依赖越少越稳）。
    // 只读模式打开，避免与 CC Switch 抢锁。
    const script = `
import sqlite3, json, sys
c = sqlite3.connect(${JSON.stringify(DB)}, uri=False)
c.execute("PRAGMA query_only = ON")
rows = c.execute(${JSON.stringify(sql)}).fetchall()
out = {}
for app_type, req, usd in rows:
    out[app_type] = {"requests": int(req or 0), "usd": float(usd or 0.0)}
print(json.dumps(out))
`;
    const stdout = execFileSync('python', ['-c', script], {
      encoding: 'utf8',
      timeout: 6000,
      windowsHide: true,
    });
    const byApp = JSON.parse(stdout.trim() || '{}');
    let total = 0;
    for (const v of Object.values(byApp)) {
      v.cny = toCny(v.usd);
      total += v.usd;
    }
    return { ok: true, byApp, totalUsd: total, totalCny: toCny(total) };
  } catch (err) {
    const msg = String((err && err.message) || err);
    return {
      ok: false,
      // 常见：CC Switch 正在写库（database is locked）/ 没装 python
      error: /locked/i.test(msg) ? 'CC Switch 数据库被占用' : msg,
    };
  }
}

/**
 * 今日某个 provider 的金额（用于圆环）。
 * @param {string} providerId CC Switch 的 provider_id；传 null 取全部
 */
function readTodayCostBy(providerId) {
  if (!providerId) {
    const all = readTodayCost();
    return { ...all, usd: all.ok ? all.totalUsd : null, cny: all.ok ? all.totalCny : null };
  }

  if (!fs.existsSync(DB)) {
    return { ok: false, error: '未找到 CC Switch 数据库' };
  }
  const sql = `
    SELECT COUNT(*) AS req, SUM(CAST(total_cost_usd AS REAL)) AS usd
    FROM proxy_request_logs
    WHERE date(created_at, 'unixepoch', 'localtime') = date('now', 'localtime')
      AND provider_id = ${JSON.stringify(providerId)}
  `;
  try {
    const script = `
import sqlite3, json
c = sqlite3.connect(${JSON.stringify(DB)})
c.execute("PRAGMA query_only = ON")
r = c.execute(${JSON.stringify(sql)}).fetchone()
print(json.dumps({"requests": int(r[0] or 0), "usd": float(r[1] or 0.0)}))
`;
    const stdout = execFileSync('python', ['-c', script], {
      encoding: 'utf8',
      timeout: 6000,
      windowsHide: true,
    });
    const o = JSON.parse(stdout.trim());
    return { ok: true, usd: o.usd, cny: toCny(o.usd), requests: o.requests };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
}

/**
 * CC Switch 里的 provider_id 列表（供设置页挑选）。
 * 只列有请求记录的，方便定位"哪个是中转站"。
 */
function listProviders() {
  if (!fs.existsSync(DB)) return { ok: false, error: '未找到 CC Switch 数据库' };
  const sql = `
    SELECT l.provider_id,
           COALESCE(p.name, l.provider_id) AS name,
           p.website_url,
           COUNT(l.request_id) AS req,
           SUM(CAST(l.total_cost_usd AS REAL)) AS usd
    FROM proxy_request_logs l
    LEFT JOIN providers p ON p.id = l.provider_id
    GROUP BY l.provider_id
    ORDER BY usd DESC
  `;
  try {
    const script = `
import sqlite3, json
c = sqlite3.connect(${JSON.stringify(DB)})
c.execute("PRAGMA query_only = ON")
rows = c.execute(${JSON.stringify(sql)}).fetchall()
out = [{"provider_id": r[0], "name": r[1], "url": r[2], "requests": int(r[3] or 0), "usd": float(r[4] or 0.0)} for r in rows]
print(json.dumps(out, ensure_ascii=False))
`;
    const stdout = execFileSync('python', ['-c', script], {
      encoding: 'utf8',
      timeout: 8000,
      windowsHide: true,
    });
    return { ok: true, providers: JSON.parse(stdout.trim() || '[]') };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
}

module.exports = { readTodayCost, readTodayCostBy, listProviders, DB };

