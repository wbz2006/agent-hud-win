'use strict';

/**
 * DSH 环的金额显示方式（2026-10-25 用户要求）。
 *
 * 原第三个环显示的是 DeepSeek **账户余额**（"还剩多少钱"），而 Claude / Codex
 * 两个环显示的是 **今日已使用金额**。用户要求 DSH 也统一成后者。
 *
 * 数据侧本来就有这个值：小鲸鱼账本的 `todayUsage`（余额观测法，账本自己记一天内
 * 的余额差值，单位已是账户本币）。`deepseek-balance.js` 三级通道里：
 *   · whale-ledger：date 不是今天 → todayUsage 置 null（跨天账本不能当今日用）
 *   · whale-http ：直接取路由给的 todayUsage
 *   · api（官方余额接口）：拿不到今日值 → 固定 null
 * 所以渲染层必须处理「今日值缺失」的退路：退回显示余额，而不是显示 0。
 *
 * 这里做静态断言（渲染层无 DOM，行为级验证见 _ringcheck.js 实机脚本）。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

function stripComments(s) {
  return s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

const RENDERER = stripComments(fs.readFileSync(path.join(ROOT, 'src/renderer/renderer.js'), 'utf8'));
const BAL_SRC = stripComments(fs.readFileSync(path.join(ROOT, 'src/main/sources/deepseek-balance.js'), 'utf8'));

test('DSH 环金额取 todayUsage（今日已用），不再取余额当主显示', () => {
  assert.match(RENDERER, /const dsToday = dsOk && typeof dsBal\.todayUsage === 'number'/, 'dsToday 必须来自 dsBal.todayUsage 且判过数字');
  // 主标签是"今日 …"，"余额 …"只作为兜底分支存在
  assert.match(RENDERER, /dsToday != null\s*\?\s*`今日 \$\{dsSym\}\$\{fmtMoney\(dsToday\)\}`/, '金额标签应给「今日 <符号><金额>」');
  assert.match(RENDERER, /:\s*`余额 \$\{dsSym\}\$\{fmtMoney\(dsBal\.total\)\}`/, '没有今日值时才退回余额');
  // 余额信息不能丢：进悬停提示
  assert.match(RENDERER, /DeepSeek 余额 \$\{dsSym\}\$\{fmtMoney\(dsBal\.total\)\}/, '提示里必须还能看到余额');
  assert.match(RENDERER, /今日已用 \$\{dsSym\}\$\{fmtMoney\(dsToday\)\}/, '提示里必须写今日已用');
});

test('DSH 的今日值要喂进统一的花费通道（环弧与￥标签共用）', () => {
  // 环弧与 ¥ 标签读的是 todayCny，DSH 不进 CC Switch 账本，只能显式注入
  assert.match(RENDERER, /if \(key === 'dsh' && dsTodayIsCny\) todayCny = dsToday;/, 'DSH 今日花费必须注入 todayCny');
  assert.match(RENDERER, /let todayCny =/, 'todayCny 必须是 let（否则无法注入）');
  // 币种门控：非 CNY 不能塞进写死 ￥ 的那条路径
  assert.match(
    RENDERER,
    /const dsTodayIsCny = dsToday != null && String\(dsBal\.currency \|\| 'CNY'\)\.toUpperCase\(\) === 'CNY'/,
    '必须有 CNY 门控：USD 账户走「余额 $…」，不许把美元数字标成￥'
  );
});

test('取数侧三条通道对 todayUsage 的口径（缺失即 null，不许造 0）', () => {
  assert.match(BAL_SRC, /TODAY_KEYS\s*=\s*\[[^\]]*todayUsage/, '今日值字段名必须含 todayUsage');
  assert.match(BAL_SRC, /const todayUsage = isToday \? firstNum\(doc, TODAY_KEYS\) : null;/, '账本跨天时今日值必须置 null');
  assert.match(BAL_SRC, /todayUsage:\s*null/, '官方余额接口拿不到今日值 → 明确 null，不能猜');
});
