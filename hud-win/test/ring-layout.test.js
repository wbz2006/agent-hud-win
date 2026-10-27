'use strict';

/**
 * ringLayout（悬浮条圆环集合与顺序）归一化测试。
 *
 * ringLayout 是设置页「悬浮条圆环」勾选 + 排序的落盘结果，键集必须与
 * CC Switch 的 AppType 枚举对齐（claude-desktop 已在账本层归一化进 claude）。
 * 归一化要保证：未知键被滤掉、去重、顺序保持；空/非法输入回退默认三环 ——
 * 配置损坏不能把整个胶囊清没。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { normalizeRingLayout, RING_KEYS, DEFAULTS } = require('../src/main/config');

test('默认配置包含三个基础环', () => {
  assert.deepEqual(DEFAULTS.ringLayout, ['codex', 'claude', 'dsh']);
});

test('合法键原样通过并保持顺序', () => {
  assert.deepEqual(normalizeRingLayout(['claude', 'codex', 'dsh']), ['claude', 'codex', 'dsh']);
  assert.deepEqual(normalizeRingLayout(['gemini', 'kimi', 'codex']), ['gemini', 'kimi', 'codex']);
});

test('未知键被过滤、重复键被去重', () => {
  assert.deepEqual(normalizeRingLayout(['codex', 'bogus', 'gemini', 'codex']), ['codex', 'gemini']);
});

test('空数组 / 非数组回退默认三环', () => {
  assert.deepEqual(normalizeRingLayout([]), DEFAULTS.ringLayout);
  assert.deepEqual(normalizeRingLayout('codex'), DEFAULTS.ringLayout);
  assert.deepEqual(normalizeRingLayout(null), DEFAULTS.ringLayout);
  assert.deepEqual(normalizeRingLayout(['xxx', 'yyy']), DEFAULTS.ringLayout);
});

test('RING_KEYS 覆盖全部已知环且无重复', () => {
  assert.equal(new Set(RING_KEYS).size, RING_KEYS.length);
  // CC Switch AppType 枚举（claude-desktop 并入 claude，不单列）
  for (const k of [
    'claude',
    'codex',
    'gemini',
    'grokbuild',
    'opencode',
    'openclaw',
    'hermes',
    'pi',
    'mcode',
    'kimi',
    'agy',
    'omp',
  ]) {
    assert.ok(RING_KEYS.includes(k), `RING_KEYS 缺少 ${k}`);
  }
});

/*
 * 静态对齐断言：渲染层（renderer.js 的 SOURCE_VENDOR + CC_APP_RINGS）与
 * 设置页（settings.js 的 RING_DEFS）的键集必须与 config RING_KEYS 一致，
 * 否则设置页能勾出渲染层不认识的环（或反过来，有环设置页却勾不了）。
 * 两边都不报错，只能静态对齐。
 */
const ROOT = path.join(__dirname, '..');

test('renderer 圆环元数据覆盖全部 RING_KEYS', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'renderer.js'), 'utf8');
  for (const k of RING_KEYS) {
    assert.match(src, new RegExp(`\\b${k}: \\{ vendor: `), `renderer.js 缺少环 ${k}`);
  }
});

test('settings RING_DEFS 与 config RING_KEYS 键集一致', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'settings.js'), 'utf8');
  const noComment = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const m = noComment.match(/const RING_DEFS = \{([\s\S]*?)\n\};/);
  assert.ok(m, 'settings.js 里找不到 RING_DEFS 定义');
  const keys = [...m[1].matchAll(/^\s{2}([a-z]+):\s*\{/gm)].map((x) => x[1]);
  assert.deepEqual(keys.sort(), [...RING_KEYS].sort());
});

test('设置页把勾选结果写进 ringLayout 字段', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'settings.js'), 'utf8');
  assert.match(src, /ringLayout:\s*ringRows\.filter/);
  const html = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'settings.html'), 'utf8');
  assert.match(html, /id="ringList"/);
});

/*
 * 监测状态适配（2026-10-27 用户反馈"数据源监测只有前三环"）：
 * 会话源与 CC Switch app 环的数据来源不同，状态口径也不同 ——
 * 会话源显示会话数；app 环显示账本今日请求与金额。设置页圆环列表
 * 每行回填状态，让"app 环有没有被监测到"直接可见。
 */
test('每环监测状态：preload 暴露 getDataStats，设置页按口径回填', () => {
  const preload = fs.readFileSync(path.join(ROOT, 'src', 'main', 'settings-preload.js'), 'utf8');
  assert.match(preload, /getDataStats:\s*\(\)\s*=>\s*ipcRenderer\.invoke\('hud:get-data-stats'\)/);
  const mainSrc = fs.readFileSync(path.join(ROOT, 'src', 'main', 'main.js'), 'utf8');
  assert.match(mainSrc, /ipcMain\.handle\('hud:get-data-stats'/);
  const settingsSrc = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'settings.js'), 'utf8');
  // 两类口径都存在
  assert.match(settingsSrc, /kind: 'source'/);
  assert.match(settingsSrc, /kind: 'app'/);
  assert.match(settingsSrc, /async function fillRingStats\(\)/);
  assert.match(settingsSrc, /今日 \$\{a\.requests \|\| 0\} 次 · \$\{unit\}/, 'app 环状态 = 今日请求与金额');
  assert.match(settingsSrc, /今日无请求/);
  assert.match(settingsSrc, /账本不可用/);
  // 列表行有状态占位节点（按 key 回填）
  assert.match(settingsSrc, /data-count="\$\{esc\(r\.key\)\}"/);
});
