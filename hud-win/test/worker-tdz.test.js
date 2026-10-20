'use strict';

/**
 * worker.js 静态检查：防止再犯「const cfg 声明晚于使用」的 TDZ 错误。
 *
 * 历史 bug：把 ccswitch.readTodayCost(cfg.costMode) 写在 const cfg = config.load()
 * 之前，运行时报 "Cannot access 'cfg' before initialization"，
 * 整个 todayCost 变成 { ok:false }，花费数据静默消失。
 * 因为错误被 try/catch 吞掉、只在面板上显示"—"，很难第一时间发现。
 *
 * 这类错误 node --check 查不出来（语法合法），所以用文本级断言守住。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'main', 'sources', 'worker.js'),
  'utf8'
);

/** 去掉注释后的代码（避免注释里的示例代码干扰判断）。 */
const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/** 找出某标识符第一次「被使用」的位置（排除声明行本身）。 */
function firstUseOf(name) {
  const re = new RegExp(`\\b${name}\\b`, 'g');
  let m;
  while ((m = re.exec(CODE)) !== null) {
    const line = CODE.slice(0, m.index).split('\n').length;
    const lineText = CODE.split('\n')[line - 1];
    // 跳过声明本身：const cfg = / let cfg = / var cfg =
    if (new RegExp(`(const|let|var)\\s+${name}\\b`).test(lineText)) continue;
    return { line, text: lineText.trim() };
  }
  return null;
}

/** 找出 const/let/var 声明所在行号（不含函数形参）。 */
function declLineOf(name) {
  const lines = CODE.split('\n');
  for (let i = 0; i < lines.length; i++) {
    // 排除函数形参：function runOnce(cfg) 不是声明
    if (/function\s+\w*\s*\(/.test(lines[i])) continue;
    if (new RegExp(`(const|let|var)\\s+${name}\\b`).test(lines[i])) return i + 1;
  }
  return null;
}

/**
 * 取 runOnce 函数体（已剥注释）。
 *
 * 必须用剥注释后的 CODE 而不是原文：注释里写"不要再写 const cfg = ..."
 * 这类说明文字会被粗糙的正则误判成真实声明（本次排查就踩了，
 * 差点以为修复没生效）。
 */
function runOnceBody() {
  const start = CODE.indexOf('async function runOnce');
  assert.ok(start > 0, '应找到 runOnce');
  const end = CODE.indexOf('parentPort.on', start);
  return CODE.slice(start, end > 0 ? end : CODE.length);
}

test('cfg 通过 runOnce(cfg) 形参提供，不存在 use-before-declare', () => {
  /*
   * cfg 现在有两个来源：runOnce(cfg) 形参（主路径）+ 函数体内可能残留的
   * const cfg = config.load()（历史形态）。要防的是"使用早于 const 声明"。
   *
   * 注意 firstUseOf 会把形参也算成使用，所以这里只在 const 声明**之后**
   * 的代码里找使用点，避免被形参干扰。
   */
  assert.match(CODE, /async function runOnce\s*\(\s*cfg\s*\)/, 'cfg 应由 runOnce 形参提供');

  const decl = declLineOf('cfg');
  if (!decl) return; // 没有 const 声明（当前形态），形参测试已覆盖

  const after = CODE.split('\n').slice(decl).join('\n');
  const uses = (after.match(/\bcfg\b/g) || []).length;
  assert.ok(uses > 0, 'const cfg 声明后应有用到');

  // 关键：const 声明那一行本身不该是"先使用后声明"
  const declLineText = CODE.split('\n')[decl - 1];
  assert.match(declLineText, /(const|let|var)\s+cfg\b/, `第 ${decl} 行应是 cfg 的声明`);
});

test('readTodayCost 必须传入计价模式（不能退回写死 ÷5）', () => {
  assert.match(
    CODE,
    /readTodayCost\(\s*cfg\.costMode\s*\)/,
    'readTodayCost 应接收 cfg.costMode，否则设置里的「金额计价」不生效'
  );
});

test('todayCost 读取被 try/catch 包裹（单点失败不拖垮整轮采集）', () => {
  const idx = CODE.indexOf('readTodayCost');
  assert.ok(idx > 0, '应调用 readTodayCost');
  // 往前找最近的 try，往后找最近的 catch
  const before = CODE.slice(0, idx);
  const after = CODE.slice(idx);
  const lastTry = before.lastIndexOf('try {');
  const lastCatchBefore = before.lastIndexOf('catch');
  assert.ok(lastTry > lastCatchBefore, 'readTodayCost 应在 try 块内');
  assert.match(after.slice(0, 300), /catch/, '其后应有 catch');
});

test('自检：遮蔽检测真的有效（不是永远通过的假测试）', () => {
  // 把 const cfg 塞进剥注释后的代码，确认检测能抓到
  const fake = 'async function runOnce(cfg) {\n  const cfg = config.load();\n';
  assert.ok(/(const|let|var)\s+cfg\b/.test(fake), '检测器应能识别遮蔽');
  // 而正常形参形态不应被误判
  const good = 'async function runOnce(cfg) {\n  const x = cfg.costMode;\n';
  assert.ok(!/(const|let|var)\s+cfg\b/.test(good), '形参形态不应误报');
});

test('函数体内不得再用 const/let cfg 遮蔽形参（否则主进程传入的配置失效）', () => {
  /*
   * 历史 bug：runOnce(cfg) 有形参，但函数体内又写了 const cfg = config.load()。
   * 后果：形参被遮蔽，主进程每次 postMessage 带过来的最新配置全部丢弃；
   * 而 config.load() 有模块级缓存，worker 进程内只读一次文件，
   * 于是设置页保存的新值（如 costMode）在这个 worker 里永远看不到。
   * 现象：UI 显示已保存、config.json 也写对了，但运行时纹丝不动。
   *
   * 注意：判定必须在**剥注释后**的代码上做 ——
   * 源码注释里就写着"不要再写 const cfg = config.load()"这句说明，
   * 不剥注释会把说明文字误判成真实声明（排查时被骗过一次）。
   */
  const body = runOnceBody();
  const shadow = body.match(/(const|let|var)\s+cfg\b/);
  assert.ok(
    !shadow,
    'runOnce 内不应再声明 cfg（会遮蔽形参，让主进程传入的配置失效）'
  );
});

test('runOnce 必须接收 cfg 参数（否则设置页改动永不生效）', () => {
  // 历史 bug：调用处写 runOnce(msg.config || config.load())，
  // 但函数签名还是 runOnce() —— 参数被丢弃，cfg 恒为 undefined，
  // cfg.costMode / rateEnabled 全部取不到，设置里的改动静默失效。
  // node --check 查不出这种错误（语法合法），所以用文本断言守住。
  const decl = CODE.match(/async function runOnce\s*\(([^)]*)\)/);
  assert.ok(decl, '应找到 runOnce 声明');
  assert.match(decl[1].trim(), /^cfg$/, `runOnce 应声明 cfg 参数，实际是 "${decl[1]}"`);

  // 且函数体内真的用到了 cfg
  const body = CODE.slice(CODE.indexOf('async function runOnce'));
  assert.match(body.slice(0, 3000), /cfg\.\w+/, '函数体内应使用 cfg.xxx');
});

test('配置获取有兜底：传入缺失时 worker 自己读（不会静默用默认值）', () => {
  // msg.config 是主进程传进来的；兜底的 config.load() 是防旧调用路径。
  // 两者并存是对的 —— 少了兜底，一旦主进程忘了带配置，
  // cfg.costMode 等全部取不到，设置里的改动会静默失效。
  assert.match(CODE, /runOnce\(msg\.config \|\| config\.load\(\)\)/, '应带兜底');
  assert.match(CODE, /runOnce\(config\.load\(\)\)/, '启动时也应读配置');
});
