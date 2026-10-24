'use strict';

/**
 * 可用性统计与胶囊配色测试（静态防护）。
 *
 * 需求：
 *   - 2026-10-21：不可用时胶囊底色变暗红并浮动，悬停图标显示不可用提示；
 *     正常时胶囊底色为深绿并浮动；主色调仍是黑色（只做淡叠加）。
 *   - 2026-10-24 用户改口：**去掉正常态的绿色底色**（连同它的呼吸动画），
 *     healthy 回到纯黑胶囊；暗红告警保留。
 *
 * 这类视觉状态容易出现「CSS 写了但 JS 没挂类」或「类挂了但 CSS 选择器对不上」，
 * 两边都不报错，只能静态对齐断言。「已删除」类断言一律在剥离注释后的文本上判。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const RENDERER = path.join(__dirname, '..', 'src', 'renderer', 'renderer.js');
const STYLES = path.join(__dirname, '..', 'src', 'renderer', 'styles.css');
const CCSWITCH = path.join(__dirname, '..', 'src', 'main', 'sources', 'ccswitch.js');
const WORKER = path.join(__dirname, '..', 'src', 'main', 'sources', 'worker.js');

const rendererSrc = fs.readFileSync(RENDERER, 'utf8');
const stylesSrc = fs.readFileSync(STYLES, 'utf8');
const ccswitchSrc = fs.readFileSync(CCSWITCH, 'utf8');
const workerSrc = fs.readFileSync(WORKER, 'utf8');

function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}
const rendererCode = stripComments(rendererSrc);
const workerCode = stripComments(workerSrc);

test('ccswitch 提供 readAvailability 统计接口', () => {
  assert.match(ccswitchSrc, /function readAvailability\(/, '必须有 readAvailability 函数');
  const m = ccswitchSrc.match(/module\.exports\s*=\s*\{([\s\S]*?)\};/);
  assert.ok(m && m[1].includes('readAvailability'), '必须导出 readAvailability');
});

test('可用率口径：status_code >= 400 或无状态码算失败', () => {
  assert.match(
    ccswitchSrc,
    /status_code\s+IS\s+NULL\s+OR\s+status_code\s*>=\s*400/i,
    '失败判定必须覆盖 NULL 与 >=400 两种，否则中断的请求会被当成成功'
  );
});

test('worker 必须把 availability 放进 summary', () => {
  assert.match(workerCode, /summary\.availability\s*=/, 'summary 上必须挂 availability');
  assert.match(workerCode, /ccswitch\.readAvailability\(/, '必须真的调用可用性统计');
});

test('可用性统计失败不能拖垮整轮采集', () => {
  assert.match(
    workerCode,
    /availability\s*=\s*ccswitch\.readAvailability[\s\S]{0,200}catch/,
    '必须有 try/catch 包裹，单项失败只降级自己'
  );
});

test('renderer 读取 summary.availability 并判定 degraded', () => {
  assert.match(rendererCode, /summary\.availability/, 'renderer 必须读取 availability');
  assert.match(rendererCode, /degraded/, '必须有 degraded 判定');
});

test('样本太少时不下结论（防一两次偶发失败导致闪烁）', () => {
  assert.match(rendererCode, /MIN_SAMPLE/, '必须有最小样本量门槛');
});

test('mark 挂上状态类与 data-state', () => {
  assert.match(rendererCode, /mark--\$\{barState\}/, 'mark 必须有状态类');
  assert.match(rendererCode, /data-state="\$\{barState\}"/, 'mark 必须有 data-state 属性');
});

test('body 汇总写出 data-avail', () => {
  assert.match(rendererCode, /document\.body\.dataset\.avail/, '必须把聚合状态写到 body');
});

test('聚合只看有样本的 mark（否则一项无样本就永远不变色）', () => {
  assert.match(
    rendererCode,
    /filter\(\(s\)\s*=>\s*s\s*!==\s*'unknown'\)/,
    '必须排除 unknown 再判断，实测踩到过：Codex 有数据但 Claude/DSH 无样本时整条永远黑色'
  );
});

test('不可用态有底色规则；正常态不再染色（2026-10-24 去掉绿底）', () => {
  const css = stripComments(stylesSrc);
  assert.match(css, /body\[data-avail='unavailable'\]\s*\.bar/, '缺 unavailable 底色规则');
  assert.doesNotMatch(
    css,
    /body\[data-avail='healthy'\]\s*\.bar/,
    'healthy 不得再有底色规则（绿底已按用户要求删除）'
  );
});

test('只有不可用态保留呼吸动画', () => {
  const css = stripComments(stylesSrc);
  assert.match(css, /@keyframes bar-breathe-bad/, '缺不可用态动画');
  assert.doesNotMatch(css, /bar-breathe-ok/, '正常态动画应随绿底一起删除');
});

test('主色调仍是黑色：不可用底色透明度够高，且绿色残留清干净', () => {
  const css = stripComments(stylesSrc);
  // 旧绿底 rgba(10,32,22,.86) 与绿发光 rgba(61,220,132,*) 都必须不存在
  assert.doesNotMatch(css, /rgba\(\s*10,\s*32,\s*22/, '正常态绿底 rgba 残留');
  assert.doesNotMatch(css, /rgba\(\s*61,\s*220,\s*132/, '绿色发光 rgba(61,220,132) 残留');

  const bad = css.match(/body\[data-avail='unavailable'\]\s*\.bar\s*\{[^}]*background-color:\s*rgba\((\d+),\s*(\d+),\s*(\d+)/);
  assert.ok(bad, '不可用态必须用 rgba 暗红');
  for (const ch of bad.slice(1, 4)) assert.ok(Number(ch) <= 60, `红通道 ${ch} 过高，会失去黑色主调`);
});

test('悬停提示只对不可用的 mark 生效', () => {
  assert.match(
    stylesSrc,
    /\.mark\[data-state='unavailable'\]:hover::after/,
    '不可用提示必须限定在 unavailable 状态'
  );
});

test('尊重系统「减少动态效果」设置', () => {
  assert.match(stylesSrc, /prefers-reduced-motion/, '应在用户关闭动效时停掉呼吸动画');
});
