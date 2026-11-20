#!/usr/bin/env node
/**
 * 已知环境问题修复脚本。
 *
 * 在部分较新的 Node.js 版本（本机验证：Node v26.x）上，electron npm 包自带的
 * install.js 调用 extract-zip 解压后，extract() 返回的 Promise 不会 resolve
 * （底层 yauzl 的 zipfile 'close' 事件与 Promise executor 之间出现竞态），
 * 导致 electron/path.txt 从未被写入，`require('electron')` 抛出
 * "Electron failed to install correctly"。
 *
 * 此脚本在检测到该情况时，直接用系统自带的解压工具完成一次性修复：
 * 1. 找到 @electron/get 已经下载好的缓存 zip（无需重新联网下载）。
 * 2. 用 unzip（POSIX）或 PowerShell Expand-Archive（Windows）解压到
 *    node_modules/electron/dist。
 * 3. 补写 path.txt，使其与 electron 包内 install.js 的约定一致。
 *
 * 幂等：已安装正确时直接退出，不做任何事。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

function resolveElectronPkgDir() {
  try {
    const pkgJsonPath = require.resolve('electron/package.json', { paths: [process.cwd()] });
    return path.dirname(pkgJsonPath);
  } catch {
    return null;
  }
}

function getPlatformPath(platform) {
  switch (platform) {
    case 'darwin':
      return 'Electron.app/Contents/MacOS/Electron';
    case 'linux':
      return 'electron';
    case 'win32':
      return 'electron.exe';
    default:
      throw new Error('不支持的平台: ' + platform);
  }
}

function isInstalled(pkgDir, version, platformPath) {
  try {
    const diskVersion = fs.readFileSync(path.join(pkgDir, 'dist', 'version'), 'utf8').replace(/^v/, '').trim();
    if (diskVersion !== version) return false;
    const diskPathTxt = fs.readFileSync(path.join(pkgDir, 'path.txt'), 'utf8').trim();
    if (diskPathTxt !== platformPath) return false;
    return fs.existsSync(path.join(pkgDir, 'dist', platformPath));
  } catch {
    return false;
  }
}

function findCachedZip(version) {
  const cacheRoot = process.env.electron_config_cache ||
    path.join(os.homedir(), 'Library', 'Caches', 'electron');
  const altRoot = path.join(os.homedir(), '.cache', 'electron');
  const roots = [cacheRoot, altRoot].filter((p, i, arr) => arr.indexOf(p) === i);
  const needle = `electron-v${version}-`;
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    for (const hashDir of fs.readdirSync(root)) {
      const dir = path.join(root, hashDir);
      if (!fs.statSync(dir).isDirectory()) continue;
      for (const file of fs.readdirSync(dir)) {
        if (file.startsWith(needle) && file.endsWith('.zip')) {
          return path.join(dir, file);
        }
      }
    }
  }
  return null;
}

function extractZip(zipPath, destDir) {
  fs.rmSync(destDir, { recursive: true, force: true });
  fs.mkdirSync(destDir, { recursive: true });
  if (process.platform === 'win32') {
    execFileSync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${destDir}' -Force`
    ], { stdio: 'inherit' });
  } else {
    execFileSync('unzip', ['-q', '-o', zipPath, '-d', destDir], { stdio: 'inherit' });
  }
}

function main() {
  const pkgDir = resolveElectronPkgDir();
  if (!pkgDir) {
    console.log('[fix-electron-install] 未找到 electron 包，跳过（请先 pnpm install）。');
    return;
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));
  const version = pkg.version;
  const platformPath = getPlatformPath(process.platform);

  if (isInstalled(pkgDir, version, platformPath)) {
    console.log(`[fix-electron-install] electron@${version} 已正确安装，无需修复。`);
    return;
  }

  console.log(`[fix-electron-install] 检测到 electron@${version} 未正确安装，尝试本地修复...`);
  const zip = findCachedZip(version);
  if (!zip) {
    console.error('[fix-electron-install] 未找到本地缓存的 zip，无法离线修复。请检查网络后重新执行 `pnpm install`，' +
      '或手动运行一次 `node node_modules/electron/install.js` 以触发下载。');
    process.exitCode = 1;
    return;
  }

  console.log('[fix-electron-install] 使用缓存文件:', zip);
  extractZip(zip, path.join(pkgDir, 'dist'));
  fs.writeFileSync(path.join(pkgDir, 'path.txt'), platformPath);

  if (isInstalled(pkgDir, version, platformPath)) {
    console.log('[fix-electron-install] 修复完成，electron 可正常使用。');
  } else {
    console.error('[fix-electron-install] 修复后校验仍未通过，请人工检查 ' + pkgDir);
    process.exitCode = 1;
  }
}

main();
