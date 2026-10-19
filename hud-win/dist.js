'use strict';

/**
 * 生成发布包：先打包，再把产物压成 zip 放进 dist/。
 *
 * 为什么单独一个脚本而不是塞进 pack.js：
 *   pack.js 要频繁用来验证功能（每次改代码都跑），压 zip 对它是多余开销。
 *   dist.js = pack + 压缩，只在要发版时跑。
 *
 * 用法：npm run dist
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const PACKAGE_VERSION = require(path.join(ROOT, 'package.json')).version;
const APP_DIR = path.join(ROOT, 'build', 'AgentHUD-win32-x64');
const DIST_DIR = path.join(ROOT, 'dist');
const ZIP_NAME = `AgentHUD-${PACKAGE_VERSION}-win32-x64.zip`;
const ZIP_PATH = path.join(DIST_DIR, ZIP_NAME);

/** 用 PowerShell 的 Compress-Archive 压目录（Windows 自带，无需额外依赖）。 */
function zipDir(srcDir, zipPath) {
  // -Path "srcDir\*" 压的是目录内容而不是目录本身，解压后不会多一层嵌套
  const ps =
    `Compress-Archive -Path "${srcDir}\\*" -DestinationPath "${zipPath}" -Force -CompressionLevel Optimal`;
  execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], {
    stdio: 'inherit',
  });
}

/** 生成 SHA256（发布页放校验值，用户可核对下载完整性）。 */
function sha256(file) {
  const out = execFileSync('powershell', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    `(Get-FileHash -Algorithm SHA256 -Path "${file}").Hash`,
  ]);
  return out.toString().trim();
}

function human(bytes) {
  if (bytes >= 1024 * 1024 * 1024) return (bytes / 1024 / 1024 / 1024).toFixed(2) + ' GB';
  if (bytes >= 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + ' MB';
  return (bytes / 1024).toFixed(0) + ' KB';
}

(async () => {
  // 1) 打包
  console.log('==> 1/3 打包应用');
  execFileSync(process.execPath, [path.join(ROOT, 'pack.js')], { stdio: 'inherit', cwd: ROOT });

  if (!fs.existsSync(path.join(APP_DIR, 'AgentHUD.exe'))) {
    console.error('!! 打包产物缺失：' + path.join(APP_DIR, 'AgentHUD.exe'));
    process.exit(1);
  }

  // 2) 压缩
  console.log('\n==> 2/3 压缩为 ' + ZIP_NAME);
  fs.mkdirSync(DIST_DIR, { recursive: true });
  if (fs.existsSync(ZIP_PATH)) fs.unlinkSync(ZIP_PATH);
  zipDir(APP_DIR, ZIP_PATH);

  // 3) 校验值
  const size = fs.statSync(ZIP_PATH).size;
  const hash = sha256(ZIP_PATH);
  console.log('\n==> 3/3 完成');
  console.log('  文件: dist\\' + ZIP_NAME);
  console.log('  大小: ' + human(size));
  console.log('  SHA256: ' + hash);
  console.log('\n把上面三行贴进 GitHub Release 说明即可。');
})().catch((e) => {
  console.error('发布包生成失败:', e.message);
  process.exit(1);
});
