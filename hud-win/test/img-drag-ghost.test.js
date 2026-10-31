'use strict';

/**
 * 拖动胶囊时的系统拖拽幻影（2026-10-31 用户反馈）：
 * 右键拖动圆环时，环里的模型 logo（HTML img 默认可拖）被当成拖拽源，
 * 出现"把模型图标拖到桌面"的幻影。两道防线都必须在：
 *   1. styles.css 全局 img { -webkit-user-drag: none; }
 *   2. renderer.js document 级 dragstart preventDefault（兜底非 img 元素）
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const css = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'styles.css'), 'utf8');
const src = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'renderer.js'), 'utf8');

test('styles.css 全局禁掉 img 原生拖拽', () => {
  assert.match(css, /img\s*\{[^}]*-webkit-user-drag:\s*none/, 'img 缺少 -webkit-user-drag: none');
});

test('renderer.js 有 document 级 dragstart preventDefault 兜底', () => {
  assert.match(
    src,
    /addEventListener\('dragstart',\s*\(e\) => e\.preventDefault\(\)\)/,
    '缺少 dragstart 全局拦截'
  );
});
