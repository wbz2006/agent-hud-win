'use strict';

/**
 * WorkBuddy 积分消耗账本（余额差值法）。
 *
 * 为什么需要它：DSH（WorkBuddy）走的是自家账号，**既不在 CC Switch 账本里**，
 * 也不像 Claude/Codex 那样有按请求计价的本地点数，所以第三个环的金额一直是
 * "—"。但额度路由会返回**剩余积分**（credits.total），于是可以用差值算消耗：
 *
 *   每次采集拿到余额 → 与上一次比较 → 下降的部分累计为"已用积分"。
 *
 * 三个必须处理好的边界（不做就会给出假数字）：
 *   1. **充值/换套餐**：余额会上升。上升绝不能算成"负消耗"，只能视为基线重置，
 *      消耗累计保持不变。
 *   2. **跨天**：本地 0 点把"今日消耗"归零，余额基线随之更新到当天首次读数。
 *   3. **基线时刻**：HUD 往往不是 0 点启动，此时只能统计"自首次读数起"的消耗。
 *      因此结果里带 baselineAt，UI 要如实标注起点，不能冒充"今日 0 点以来"。
 *
 * 状态文件放在 config.json 同级（exe 目录，可写），原子写入。
 */

const fs = require('fs');
const path = require('path');
const config = require('../config');

const STATE_VERSION = 1;

/** 状态文件路径：与 config.json 同目录（打包态 = exe 同级，开发态 = 项目根）。 */
function defaultFile() {
  return path.join(path.dirname(config.CONFIG_FILE), 'dsh-spend.json');
}

function pad2(n) {
  return n < 10 ? '0' + n : String(n);
}

/** 本地日期键 YYYY-MM-DD（与 SQLite 的 localtime 口径一致）。 */
function dayKey(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

function readState(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    if (raw && raw.version === STATE_VERSION) return raw;
  } catch {
    /* 文件不存在/损坏：当作首次运行 */
  }
  return null;
}

function writeState(file, state) {
  const tmp = file + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
    fs.renameSync(tmp, file);
    return true;
  } catch {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* ignore */
    }
    return false;
  }
}

/** 空状态（首次运行或跨日重置后的形态）。 */
function emptyState(day, now) {
  return { version: STATE_VERSION, day, accounts: {}, firstSeenAt: now };
}

/**
 * 记录一次余额快照，返回累计消耗。
 *
 * @param {Array} credits quota.fetchCredits() 的结果（每项 {key, ok, total}）
 * @param {object} [opts]
 * @param {number} [opts.now] 当前时间戳（测试可注入）
 * @param {string} [opts.file] 状态文件路径（测试可注入）
 * @returns {{ok:boolean, unit:'credit', todayCredits:number|null, balance:number|null,
 *            baselineAt:number|null, sinceDayStart:boolean, day:string, reason?:string}}
 */
function track(credits, opts = {}) {
  const now = Number(opts.now) || Date.now();
  const file = opts.file || defaultFile();
  const day = dayKey(now);

  let state = readState(file);
  if (!state) state = emptyState(day, now);

  // 跨日：今日消耗归零；余额基线沿用上一次读数，等这一轮更新
  if (state.day !== day) {
    state.day = day;
    for (const a of Object.values(state.accounts || {})) a.consumedToday = 0;
  }

  let sawAny = false;
  let balance = 0;
  let todayCredits = 0;
  let baselineAt = null;
  let sinceDayStart = true;

  for (const rec of Array.isArray(credits) ? credits : []) {
    if (!rec || rec.ok !== true || typeof rec.total !== 'number' || !Number.isFinite(rec.total)) continue;
    sawAny = true;
    balance += rec.total;

    const key = String(rec.key || 'workbuddy');
    let acc = state.accounts[key];
    if (!acc) {
      // 首次见到这个账号：以当前余额为基线，消耗从 0 开始
      acc = state.accounts[key] = {
        baseline: rec.total,
        last: rec.total,
        consumedToday: 0,
        baselineAt: now,
      };
    }

    if (typeof acc.last === 'number' && Number.isFinite(acc.last)) {
      const delta = acc.last - rec.total;
      if (delta > 0) {
        // 余额下降 = 真实消耗
        acc.consumedToday = round2((acc.consumedToday || 0) + delta);
      }
      // delta < 0：充值/套餐变更，不记消耗，只把基线挪到新值
    }
    acc.last = rec.total;
    acc.baselineAt = acc.baselineAt || now;

    todayCredits += acc.consumedToday || 0;
    if (baselineAt === null || acc.baselineAt < baselineAt) baselineAt = acc.baselineAt;
    // 基线不是当天 0 点 → 只能算「自基线起」，如实告诉 UI
    if (dayKey(acc.baselineAt) !== day || new Date(acc.baselineAt).getHours() !== 0) sinceDayStart = false;
  }

  writeState(file, state);

  if (!sawAny) {
    return {
      ok: false,
      unit: 'credit',
      todayCredits: null,
      balance: null,
      baselineAt: null,
      sinceDayStart,
      day,
      reason: '余额不可用（DSH 未运行或未登录）',
    };
  }

  return {
    ok: true,
    unit: 'credit',
    todayCredits: round2(todayCredits),
    balance: round2(balance),
    baselineAt,
    sinceDayStart,
    day,
  };
}

module.exports = { track, dayKey, defaultFile, STATE_VERSION };
