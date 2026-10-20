'use strict';

/**
 * 热键录制：keydown → Electron accelerator 的转换测试。
 *
 * 这段逻辑容易出错的地方：
 *   - 只按修饰键就生成 "Control+Shift" 这种不完整热键
 *   - 用 e.key 而不是 e.code，中文输入法/大写锁定时结果漂移
 *   - 特殊键名字与 Electron 的 accelerator 命名对不上
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

/**
 * 从 settings.js 里抽出三个热键函数并在沙箱里执行。
 *
 * 直接 require 不行 —— settings.js 顶层就访问 document，
 * 在 Node 里会立刻抛错。所以只截取函数定义段。
 */
function loadFunctions() {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'renderer', 'settings.js'),
    'utf8'
  );
  const start = src.indexOf('const HOTKEY_MODIFIERS');
  const end = src.indexOf('/** 安装热键录制行为');
  assert.ok(start > 0 && end > start, '应能在 settings.js 里找到热键函数段');
  const code = src.slice(start, end);

  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(code + '\nthis.keyEventToAccelerator = keyEventToAccelerator;', sandbox);
  return sandbox.keyEventToAccelerator;
}

const toAccel = loadFunctions();

/** 造一个 keydown 事件的形状。 */
function ev({ ctrl, alt, shift, meta, code, key }) {
  return { ctrlKey: !!ctrl, altKey: !!alt, shiftKey: !!shift, metaKey: !!meta, code, key: key || '' };
}

test('Ctrl+Shift+H → Control+Shift+H（Electron 格式）', () => {
  assert.equal(toAccel(ev({ ctrl: true, shift: true, code: 'KeyH' })), 'Control+Shift+H');
});

test('Ctrl+Alt+1 → Control+Alt+1', () => {
  assert.equal(toAccel(ev({ ctrl: true, alt: true, code: 'Digit1' })), 'Control+Alt+1');
});

test('Win 键映射为 Super，且在修饰键最后（Electron 惯例顺序）', () => {
  // 修饰键固定输出 Control → Alt → Shift → Super，
  // 顺序必须稳定，否则同一组合会生成两种字符串、被当成两个热键。
  assert.equal(toAccel(ev({ meta: true, shift: true, code: 'KeyZ' })), 'Shift+Super+Z');
  assert.equal(toAccel(ev({ ctrl: true, shift: true, meta: true, code: 'KeyZ' })), 'Control+Shift+Super+Z');
});

test('修饰键顺序稳定：同样按键集合永远产出同一字符串', () => {
  const a = toAccel(ev({ alt: true, ctrl: true, code: 'KeyQ' }));
  const b = toAccel(ev({ ctrl: true, alt: true, code: 'KeyQ' }));
  assert.equal(a, b, '按键的检测顺序不应影响输出');
  assert.equal(a, 'Control+Alt+Q');
});

test('只按修饰键返回 null（不产生半截热键）', () => {
  assert.equal(toAccel(ev({ ctrl: true, code: 'ControlLeft', key: 'Control' })), null);
  assert.equal(toAccel(ev({ shift: true, code: 'ShiftLeft', key: 'Shift' })), null);
  assert.equal(toAccel(ev({ ctrl: true, shift: true, code: 'ShiftLeft', key: 'Shift' })), null);
});

test('没有修饰键返回 null（避免与普通输入冲突）', () => {
  assert.equal(toAccel(ev({ code: 'KeyA', key: 'a' })), null);
});

test('功能键 F1..F12 原样输出', () => {
  assert.equal(toAccel(ev({ ctrl: true, code: 'F1' })), 'Control+F1');
  assert.equal(toAccel(ev({ alt: true, code: 'F12' })), 'Alt+F12');
});

test('用 e.code 而非 e.key：大小写/输入法不影响结果', () => {
  // 即便 key 是小写 a，也该输出 A
  assert.equal(toAccel(ev({ ctrl: true, code: 'KeyA', key: 'a' })), 'Control+A');
  // 中文输入法下 key 可能是 "Process"，但 code 仍是物理键
  assert.equal(toAccel(ev({ ctrl: true, code: 'KeyB', key: 'Process' })), 'Control+B');
});

test('特殊键按 Electron 命名映射', () => {
  assert.equal(toAccel(ev({ ctrl: true, code: 'Space', key: ' ' })), 'Control+Space');
  assert.equal(toAccel(ev({ ctrl: true, code: 'ArrowUp', key: 'ArrowUp' })), 'Control+Up');
  assert.equal(toAccel(ev({ ctrl: true, code: 'Enter', key: 'Enter' })), 'Control+Return');
  assert.equal(toAccel(ev({ ctrl: true, code: 'Comma', key: ',' })), 'Control+,');
});

test('数字小键盘映射为 numN', () => {
  assert.equal(toAccel(ev({ ctrl: true, code: 'Numpad1' })), 'Control+num1');
});

test('settings.js 里确实装了录制器并按 Esc 取消', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'renderer', 'settings.js'),
    'utf8'
  );
  assert.match(src, /function setupHotkeyRecorder/, '应有 setupHotkeyRecorder');
  assert.match(src, /setupHotkeyRecorder\(\)/, '应被调用');
  assert.match(src, /'Escape'/, '应处理 Esc 取消');
  assert.match(src, /mousedown/, '应支持单击开始录制');
});

test('热键输入框是 readonly（防止手打半截格式）', () => {
  const html = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'renderer', 'settings.html'),
    'utf8'
  );
  const m = html.match(/<input[^>]*id="toggleHotkey"[^>]*>/);
  assert.ok(m, '应找到热键输入框');
  assert.match(m[0], /readonly/, '热键输入框应为 readonly');
});
