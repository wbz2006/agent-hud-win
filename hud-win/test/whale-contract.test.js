'use strict';

/**
 * 鲸鱼插件「契约哨兵」。
 *
 * 背景：HUD 第三环的余额全部由 dsh-whale-widget 写的账本 / 注册的路由提供，
 * 而它是**别人维护、迭代很快**的插件（实测 0.3.9→0.3.18 两周 10 版）。
 * 上游 `lib/accounting.mjs` 把 `ledger.lastBalance / ledger.todayUsage`
 * 注释成 "Compatibility fields for the existing UI and old settings writers" ——
 * 也就是**没有稳定性承诺**。升级把它删掉/改名那天，HUD 会安静地退回兜底，
 * 但如果连兜底字段、路由路径也一起变了，界面就只剩"不可用"。
 *
 * 这个文件在**升级后第一时间**把"契约有没有破"喊出来：
 *   1) 本机装的是哪一版（失败信息里带版本号，方便对照上游 changelog）
 *   2) 上游是否还在写兼容字段、是否还注册 /dsh-whale/balance.json
 *   3) 真实账本文件还能不能解析成 HUD 期望的形状
 *   4) HUD 自己这边没有回退成"写死 ¥"（币种必须跟随 dsBal.currency）
 *
 * 未安装鲸鱼插件的机器上整组跳过（不红），其余断言仍然有效。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');

/** 找本机安装的鲸鱼插件目录（各 profile 的 node_modules + DSH_HOME 根）。 */
function pluginDirs() {
  const found = [];
  try {
    for (const p of fs.readdirSync(path.join(DSH_HOME, 'profiles'))) {
      const d = path.join(DSH_HOME, 'profiles', p, 'node_modules', 'dsh-whale-widget');
      if (fs.existsSync(path.join(d, 'package.json'))) found.push(d);
    }
  } catch {
    /* 没有 profiles 目录：可能只装了一份在别处 */
  }
  const direct = path.join(DSH_HOME, 'node_modules', 'dsh-whale-widget');
  if (fs.existsSync(path.join(direct, 'package.json'))) found.push(direct);
  return found;
}

const PLUGIN_DIR = pluginDirs()[0] || null;
const SKIP = PLUGIN_DIR ? false : `未安装 dsh-whale-widget（查过 ${DSH_HOME}\\profiles\\*）`;

/** 读插件文件；读不到直接失败并说清楚"结构变了"。 */
function readPlugin(rel) {
  const file = path.join(PLUGIN_DIR, rel);
  assert.ok(
    fs.existsSync(file),
    `插件结构变了：找不到 ${rel}（安装于 ${PLUGIN_DIR}）—— 需要重新核对余额取数契约`
  );
  return fs.readFileSync(file, 'utf8');
}

let pkgVersion = '未知';
try {
  pkgVersion = JSON.parse(readPlugin('package.json')).version || '未知';
} catch {
  /* 断言里会给出更具体的原因 */
}

test('鲸鱼插件版本可读（升级后先看这里，再对上游 changelog）', { skip: SKIP }, (t) => {
  t.diagnostic(`dsh-whale-widget ${pkgVersion} @ ${PLUGIN_DIR}`);
  assert.match(pkgVersion, /^\d+\.\d+\.\d+/, 'package.json 里应有语义版本号');
});

test('上游仍在写兼容字段 lastBalance / todayUsage', { skip: SKIP }, (t) => {
  const src = readPlugin(path.join('lib', 'accounting.mjs'));
  assert.match(src, /ledger\.lastBalance\s*=/, 'accounting.mjs 不再写 ledger.lastBalance —— HUD 账本通道失效，需改用其它字段');
  assert.match(src, /ledger\.todayUsage\s*=/, 'accounting.mjs 不再写 ledger.todayUsage —— 今日已用需换来源');
  assert.match(src, /ledger\.date\s*=/, 'accounting.mjs 不再写 ledger.date —— 跨天判断会失效（date 恒为旧值）');

  const ver = /ACCOUNTING_VERSION\s*=\s*(\d+)/.exec(src);
  assert.ok(ver, 'accounting.mjs 里应有 ACCOUNTING_VERSION');
  t.diagnostic(`ACCOUNTING_VERSION=${ver[1]}（HUD 不依赖它，但升版说明账本结构在动）`);
});

test('上游仍注册 /dsh-whale/balance.json 且响应含 totalBalance', { skip: SKIP }, () => {
  const src = readPlugin(path.join('lib', 'index.js'));
  assert.match(src, /['"`]\/dsh-whale\/balance\.json['"`]/, '路由 /dsh-whale/balance.json 不见了 —— HUD 的 HTTP 兜底会失效');
  assert.match(src, /totalBalance/, 'balance 路由响应里没有 totalBalance —— HUD 按该字段取余额');
});

test('真实账本文件仍可解析成 HUD 期望的形状', { skip: SKIP }, (t) => {
  const file = path.join(DSH_HOME, '.dshw-usage.json');
  if (!fs.existsSync(file)) {
    t.diagnostic('本机没有账本文件（插件可能还没取过余额），跳过形状检查');
    return;
  }
  let doc;
  assert.doesNotThrow(() => {
    doc = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  }, '账本不是合法 JSON —— 插件 v860 起会自己备份重建，HUD 也会降级，但值得看一眼');

  assert.equal(typeof doc.date, 'string', '账本应有 date 字段（HUD 用它判断是否跨天）');
  const hasCompat = ['lastBalance', 'balance', 'totalBalance'].some((k) => typeof doc[k] === 'number');
  assert.ok(hasCompat, '账本没有任何可识别的余额字段（lastBalance/balance/totalBalance）—— HUD 账本通道会失败');
  if (doc.accounting) {
    assert.equal(typeof doc.accounting.active, 'string', 'accounting.active 应是 "指纹-币种" 字符串（HUD 从尾部取币种）');
    assert.ok(doc.accounting.books && typeof doc.accounting.books === 'object', 'accounting.books 应是对象');
  }
  t.diagnostic(`账本 date=${doc.date}，余额字段=${['lastBalance', 'balance', 'totalBalance'].filter((k) => doc[k] !== undefined).join(',') || '无'}`);
});

/*
 * 以下为本仓库侧的静态断言：升级只会影响取数，**不许**让界面回退成写死货币符号。
 * 按「自测断言纪律」：所有"某某文本不存在"的判断都在剥离注释后进行。
 */
function stripComments(s) {
  return s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

const RENDERER = stripComments(fs.readFileSync(path.join(ROOT, 'src/renderer/renderer.js'), 'utf8'));
const BALANCE_SRC = stripComments(fs.readFileSync(path.join(ROOT, 'src/main/sources/deepseek-balance.js'), 'utf8'));

test('余额标签的货币符号必须跟随 dsBal.currency（不得写死 ¥）', () => {
  assert.match(RENDERER, /currencySymbol\s*\(\s*dsBal\.currency\s*\)/, 'renderer 应调用 currencySymbol(dsBal.currency)');
  assert.doesNotMatch(RENDERER, /`余额 ¥/, '余额标签不得写死 ¥（USD 账户会被标成人民币）');
  assert.doesNotMatch(RENDERER, /DeepSeek 官方余额 ¥/, '余额提示不得写死 ¥');
  assert.match(RENDERER, /CURRENCY_SYMBOLS\s*=\s*\{[^}]*CNY/, '应保留币种符号表');
});

test('取数链必须同时具备账本与鲸鱼路由两条通道', () => {
  assert.match(BALANCE_SRC, /function readWhaleHttp/, '缺少 HTTP 兜底实现');
  assert.match(BALANCE_SRC, /WHALE_HTTP_PATH\s*=\s*['"`]\/dsh-whale\/balance\.json/, 'HTTP 路径不对');
  assert.match(BALANCE_SRC, /readWhaleHttp\(\{ now \}\)/, 'fetchBalance 必须真的调用 readWhaleHttp');
  assert.match(BALANCE_SRC, /BALANCE_KEYS\s*=\s*\[[^\]]*lastBalance/, '余额字段别名表应包含 lastBalance');
});
