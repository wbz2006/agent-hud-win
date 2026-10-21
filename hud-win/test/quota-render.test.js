'use strict';

/**
 * 额度区接线测试（静态防护）。
 *
 * 起点是一个真实 bug（2026-10-21）：worker 早就算好了 relayBalance，
 * 但 renderer 从头到尾没读过它，所以「Codex 中转站余额」永远不显示，
 * 用户看到的是 WorkBuddy 的积分行 —— 数据算出来却不显示，等于没有。
 *
 * 另一个同类 bug 是「渲染函数写了但 render() 没调用它」（见 renderer-wiring.test.js）。
 * 这类问题的共同点是：**代码不报错、页面不崩、只是少了一块内容**，
 * 只能靠静态断言兜住。
 *
 * 跑法：node --test test/quota-render.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const RENDERER = path.join(__dirname, '..', 'src', 'renderer', 'renderer.js');
const QUOTA = path.join(__dirname, '..', 'src', 'main', 'sources', 'quota.js');
const WORKER = path.join(__dirname, '..', 'src', 'main', 'sources', 'worker.js');
const HTML = path.join(__dirname, '..', 'src', 'renderer', 'index.html');

const rendererSrc = fs.readFileSync(RENDERER, 'utf8');
const quotaSrc = fs.readFileSync(QUOTA, 'utf8');
const workerSrc = fs.readFileSync(WORKER, 'utf8');
const htmlSrc = fs.readFileSync(HTML, 'utf8');

/** 只剥注释，保留字符串字面量（剥字符串会让断言假通过，踩过这个坑）。 */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}
const rendererCode = stripComments(rendererSrc);
const quotaCode = stripComments(quotaSrc);
const workerCode = stripComments(workerSrc);

test('worker 必须把 relayBalance 放进 summary（数据源头）', () => {
  assert.match(workerCode, /summary\.relayBalance\s*=/, 'summary 上必须挂 relayBalance');
  assert.match(workerCode, /relay\.fetchRelayBalance\(/, '必须真的调用中转站余额接口');
});

test('renderer 必须读取 summary.relayBalance（防「算了不显示」回归）', () => {
  assert.match(
    rendererCode,
    /summary\.relayBalance/,
    'renderer 从未读取 relayBalance —— 中转站余额会算出却不显示，这正是本次修的 bug'
  );
});

test('Codex Tab 必须显示中转站余额（showRelay 覆盖 codex）', () => {
  assert.match(rendererCode, /showRelay/, '必须有 showRelay 判定');
  assert.match(
    rendererCode,
    /activeSource\s*===\s*'codex'[\s\S]{0,80}relay|relay[\s\S]{0,80}activeSource\s*===\s*'codex'/,
    'showRelay 必须包含 codex 源'
  );
});

test('renderQuotas 支持分段渲染（credits / relay 可分别关闭）', () => {
  assert.match(rendererCode, /function renderQuotas\(summary,\s*opts/, 'renderQuotas 必须接受 opts');
  assert.match(rendererCode, /opts\.credits/, '必须能关闭积分段');
  assert.match(rendererCode, /opts\.relay/, '必须能开启中转站段');
});

test('额度区角标不再写死「离线」', () => {
  assert.ok(
    !/'离线'/.test(rendererCode),
    'quotaNote 不应再输出「离线」——该状态已按用户要求删除'
  );
});

test('时间戳只有在真的拿到数据时才写', () => {
  assert.match(
    rendererCode,
    /creditShown\s*\|\|\s*relayShown/,
    '只要中转站有数据也该显示时间戳，不能只看 creditShown'
  );
});

test('DSH 端口不能写死 —— 必须走 findDshPort 探测', () => {
  assert.match(quotaCode, /async function findDshPort/, '必须有端口探测函数');
  assert.ok(
    !/127\.0\.0\.1:\$\{DSH_WEB_PORT\}/.test(quotaCode),
    'fetchCredits 里不得再直接拼接写死的 DSH_WEB_PORT'
  );
  assert.match(
    quotaCode,
    /const port = await findDshPort\(\)/,
    'fetchCredits 必须先探测端口'
  );
});

test('端口探测结果要缓存，避免每轮都扫端口', () => {
  assert.match(quotaCode, /PROBE_CACHE_MS/, '必须有缓存时长常量');
  assert.match(quotaCode, /probeCache/, '必须有探测结果缓存');
});

test('探测判据必须接受 401/403（端口对但未带鉴权也算命中）', () => {
  assert.match(
    quotaCode,
    /401/,
    '只认 200 会漏判：有些端口对插件路由返回 401，但端口本身是正确的'
  );
});

test('导出的 API 完整（worker 依赖 fetchCredits / findDshPort）', () => {
  const m = quotaSrc.match(/module\.exports\s*=\s*\{([\s\S]*?)\};/);
  assert.ok(m, '必须有 module.exports');
  const exported = m[1];
  for (const name of ['fetchCredits', 'aggregateByProvider', 'findDshPort', 'loadRates', 'PROVIDER_LABELS']) {
    assert.ok(exported.includes(name), `必须导出 ${name}`);
  }
});

test('index.html 的额度区块结构仍存在', () => {
  for (const id of ['quotaSection', 'quotas', 'quotaNote']) {
    assert.ok(htmlSrc.includes(`id="${id}"`), `index.html 必须保留 #${id}`);
  }
});
