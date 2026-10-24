'use strict';

/**
 * 可用性统计与胶囊配色测试（静态防护）。
 *
 * 需求演进：
 *   - 2026-10-21：不可用暗红浮动、正常深绿浮动、主色调仍黑。
 *   - 2026-10-24 第一次：去掉正常态绿底（healthy 回纯黑胶囊）。
 *   - 2026-10-24 第二次（现行）：**胶囊底色完全不随可用性变化**——暗红底与
 *     两个呼吸动画一并删除；状态只由圆环颜色、图标变色与悬停提示表达。
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

test('胶囊底色完全不随可用性变化（绿/红底与呼吸动画都已移除）', () => {
  const css = stripComments(stylesSrc);
  assert.doesNotMatch(
    css,
    /body\[data-avail='[a-z]+'\]\s*\.bar/,
    '胶囊不得再有任何可用性底色规则（2026-10-24 连暗红底一起删了）'
  );
  assert.doesNotMatch(css, /bar-breathe/, '呼吸动画 keyframes 应全部删除');
  assert.doesNotMatch(css, /rgba\(\s*10,\s*32,\s*22/, '旧绿底 rgba 残留');
  assert.doesNotMatch(css, /rgba\(\s*38,\s*12,\s*12/, '旧暗红底 rgba 残留');
});

test('.bar 保留基础底色（panel-fill + hairline，不是被删空）', () => {
  const css = stripComments(stylesSrc);
  assert.match(css, /\.bar\s*\{[^}]*background:\s*var\(--panel-fill\)/, '.bar 必须保留基础底色');
  assert.match(css, /\.bar\s*\{[^}]*border:\s*1px solid var\(--hairline\)/, '.bar 必须保留细边框');
});

test('悬停提示只对不可用的 mark 生效（状态语义仍在图标层）', () => {
  assert.match(
    stylesSrc,
    /\.mark\[data-state='unavailable'\]:hover::after/,
    '不可用提示必须限定在 unavailable 状态'
  );
});
