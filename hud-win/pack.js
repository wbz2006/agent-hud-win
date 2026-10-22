'use strict';

/**
 * 打包脚本。
 *
 * 用 API 而不是命令行，是因为命令行传 `--asar '{"unpack":"..."}'` 在
 * Windows 的 cmd/PowerShell 里 JSON 转义极易出错（踩过一次：参数被解析成
 * 字符串字面量，unpack 静默失效，app.asar.unpacked 根本没生成）。
 *
 * 关键：`asar: { unpack: 'src/main/sources/**' }`
 *   worker_threads **无法在 asar 内加载脚本**（new Worker 会抛
 *   `Cannot find module .../app.asar/src/main/sources/worker.js`），
 *   表现为悬浮条上常驻一个红色「采集失败：Cannot…」提示框。
 *   把 sources 整个解包到 app.asar.unpacked，Node 才会去真实磁盘上读它。
 *   main.js 里的 resolveSourcesDir() 负责把 __dirname 里的 app.asar 段替换掉。
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = __dirname;

/** 版本号唯一真源：package.json。打包与 Release 都从这里取，避免多处不同步。 */
const PACKAGE_VERSION = require(path.join(ROOT, 'package.json')).version;

(async () => {
  // @electron/packager v20 是 ESM，导出名为 packager（没有 default）
  const mod = await import('@electron/packager');
  const packager = mod.packager || mod.default || mod;

  /*
   * 输出目录：默认 build/，可用环境变量 HUD_OUT 覆盖。
   *
   * 为什么留这个开关：Windows 上旧产物偶尔会被残留句柄锁住
   * （EBUSY: unlink app.asar 失败），此时换一个目录就能立刻打包，
   * 不必去猜是哪个进程占着（实测逐个删文件也只能定位到 asar 本体，
   * 而 tasklist/Get-Process 里已看不到任何相关进程）。
   *
   *   $env:HUD_OUT = "build2"; node pack.js
   */
  const outDir = process.env.HUD_OUT
    ? path.resolve(ROOT, process.env.HUD_OUT)
    : path.join(ROOT, 'build');

  const outPath = await packager({
    dir: ROOT,
    out: outDir,
    overwrite: true,
    platform: 'win32',
    arch: 'x64',
    // 输出目录名与 exe 名都取这个（package.json 的 name 是 npm 包名
    // agent-hud-win，直接用它会让产物变成 agent-hud-win-win32-x64/
    // agent-hud-win.exe，不够整洁）。产物固定为 AgentHUD-win32-x64/AgentHUD.exe。
    name: 'AgentHUD',
    appVersion: PACKAGE_VERSION,
    electronVersion: '33.4.11',
    // 把整个 src 解包到 asar 外。
    //
    // 踩过的坑：只解包 src/main/sources 时，worker.js 虽然能被 worker_threads
    // 加载（它不能从 asar 内加载脚本），但它内部 require('../config') 指向的
    // config.js 还在 asar 里 —— 解包目录里找不到，于是抛
    //   Cannot find module '../config'
    // 悬浮条上就常驻一个「采集失败：Cannot…」红框。
    // 整目录解包后，main / sources / renderer 全在真实磁盘上，不存在跨边界 require。
    asar: { unpackDir: 'src' },
    // exe 文件图标（资源管理器 / 任务栏 / 开始菜单里显示的 AgentHUD.exe）
    icon: path.join(ROOT, 'src', 'renderer', 'assets', 'app-icon.ico'),
    // 渲染层的品牌 logo 也要真实文件（img src 指向 assets/），一并解包更稳
    ignore: [
      /*
       * build / build2 / build3 … 全系列都排除，不能只写 build/。
       *
       * 踩过的坑：早先只排除了 `build/`（以及当前输出目录），于是用
       * HUD_OUT=build6 打包时，build2–build5 里的历史产物被整个打进 asar，
       * 产物逐轮膨胀：build2 287MB → build3 574MB → build4 1.06GB →
       * build5 2.03GB → build6 3.97GB（app.asar 本体 3.7GB）。
       * 这里用前缀匹配覆盖全部 buildN，同时排除 dist 与输出目录本身。
       */
      /^[/\\]build\d*[/\\]/,
      /^[/\\]dist[/\\]/,
      // 用 HUD_OUT 换目录时，也要把该目录本身排除在打包内容之外，
      // 否则会把上一次的产物打进 asar（体积翻倍且可能导致递归复制）
      new RegExp(`^[/\\\\]${path.basename(outDir).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[/\\\\]`),
      /^[/\\]shot-.*\.png$/,
      /^[/\\]_.*\.(js|ps1|py)$/,
      /^[/\\]anim[/\\]/,
    ],
  });

  const target = outPath[0];
  console.log('Wrote new app to:', target);

  // 写入 ASCII-only 的启动器（中文注释在 GBK 代码页下会被当命令执行）
  const launcher = [
    '@echo off',
    'rem Agent HUD launcher. Clears ELECTRON_RUN_AS_NODE so the exe does not',
    'rem degrade to plain Node when launched from an Electron host terminal.',
    'rem Keep ASCII-only: non-ASCII comments break under some code pages.',
    'cd /d "%~dp0"',
    'if not exist "%~dp0AgentHUD.exe" (',
    '  echo [ERROR] AgentHUD.exe not found next to this launcher.',
    '  pause',
    '  exit /b 1',
    ')',
    'set ELECTRON_RUN_AS_NODE=',
    '"%~dp0AgentHUD.exe" --no-sandbox',
    '',
  ].join('\r\n');
  fs.writeFileSync(path.join(target, 'Run-AgentHUD.cmd'), launcher, 'ascii');

  // 配置文件放到 exe 同级（main.js 的 resolveConfigFile 会指向这里）
  const src = path.join(ROOT, 'config.json');
  if (fs.existsSync(src)) {
    fs.copyFileSync(src, path.join(target, 'config.json'));
    console.log('config.json copied to exe directory');
  }

  // 自检：worker.js 与它依赖的 config.js 都必须解包到 asar 外。
  // 只解包 sources 会导致 worker 里 require('../config') 找不到文件。
  const base = path.join(target, 'resources', 'app.asar.unpacked', 'src', 'main');
  const need = [path.join(base, 'sources', 'worker.js'), path.join(base, 'config.js')];
  const missing = need.filter((f) => !fs.existsSync(f));
  if (missing.length === 0) {
    console.log('OK  src 已完整解包（worker + config 均在 asar 外）');
  } else {
    console.error('!! 解包不完整，缺失：');
    missing.forEach((f) => console.error('   ' + f));
    process.exitCode = 1;
  }

  /*
   * 代码签名（可选）。
   *
   * 只在 .certs/ 里有证书时才执行 —— 没证书也不能让打包失败，
   * 因为开发和 CI 环境通常没有私钥。
   *
   * 签名必须在**打包完成后**做，且 exe 不能被占用（HUD 正在跑时签名会报
   * "The file is being used by another process"）。所以这里先检查进程再签。
   */
  const pfx = path.join(ROOT, '.certs', 'AgentHUD-Dev.pfx');
  if (fs.existsSync(pfx)) {
    console.log('\n==> 代码签名');
    try {
      execFileSync(
        'powershell',
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(ROOT, 'scripts', 'sign.ps1'),
         '-Exe', path.join(target, 'AgentHUD.exe')],
        { stdio: 'inherit' }
      );
    } catch (e) {
      // 签名失败不影响产物可用，只是 SmartScreen 会更吓人，所以只警告不退出
      console.warn('!! 签名失败（产物仍可用，但会提示未知发布者）');
      console.warn('   常见原因：AgentHUD.exe 正在运行，请先退出再打包');
    }
  } else {
    console.log('\n跳过代码签名（.certs/AgentHUD-Dev.pfx 不存在）');
    console.log('  如需签名：powershell -ExecutionPolicy Bypass -File scripts\\make-cert.ps1');
  }
})().catch((e) => {
  console.error('打包失败:', e);
  process.exit(1);
});