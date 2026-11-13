/**
 * 打包成 exe 后的入口（CommonJS）。
 *
 * 为什么是 CJS 不是 ESM：Node 的 SEA 入口走 embedderRunCjs，还不支持 ESM 入口，
 * 写成 import 会直接报 "Cannot use import statement outside a module"。
 * 所以这里用 require，最后再用动态 import() 拉起真正的 ESM 服务。
 *
 * 做的事：
 *   1. 把内嵌在 exe 里的代码和网页解压到 %LOCALAPPDATA%\hotel-near-factory\app\
 *   2. 首次运行时生成一份 config.json（含打包时用的高德 key）
 *   3. 拉起 server.mjs 并自动打开浏览器
 *
 * 开发时直接 node server.mjs 即可，本文件只在打包后生效。
 */
// exe 被改成 GUI 子系统（双击不弹控制台窗口），此时没有控制台，
// 写 stdout/stderr 会失败并触发 stream 的 'error' 事件，没有监听器会导致进程崩溃。
// 这里先吞掉，避免服务一启动写日志就闪退。开发时（node server.mjs）不受影响。
process.stdout.on('error', () => {});
process.stderr.on('error', () => {});

const { isSea, getAsset, getAssetKeys } = require('node:sea');
const { existsSync } = require('node:fs');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

if (!isSea()) {
  console.error('这是给打包后的 exe 用的入口。开发时请运行：node server.mjs');
  process.exit(1);
}

async function main() {
  const BASE = path.join(process.env.LOCALAPPDATA || os.homedir(), 'hotel-near-factory');
  const APP_DIR = path.join(BASE, 'app');
  const CONFIG = path.join(BASE, 'config.json');

  console.log('');
  console.log('  出差小助手');
  console.log(`  数据目录 ${BASE}`);
  console.log('');

  /* ---- 1. 解压代码和网页 ---- */
  let count = 0;
  for (const key of getAssetKeys()) {
    if (key === 'config.default.json') continue;
    // data/ 下是运行时数据（城市映射、演示数据），要落到数据目录；
    // 其余是代码和网页，落到 app/
    const target = key.startsWith('data/') ? path.join(BASE, key) : path.join(APP_DIR, key);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, Buffer.from(getAsset(key)));
    count += 1;
  }
  console.log(`  已就绪（${count} 个文件）`);

  /* ---- 2. 首次运行生成配置 ---- */
  if (!existsSync(CONFIG)) {
    await fs.writeFile(CONFIG, Buffer.from(getAsset('config.default.json')));
    console.log('  已生成 config.json');
  }

  /* ---- 3. 拉起服务 ---- */
  process.env.HNF_APP_DIR = APP_DIR;
  process.env.HNF_DATA_DIR = BASE;

  // 双击 exe 时默认打开浏览器；带 --no-open 可以关掉
  if (!process.argv.includes('--no-open')) process.argv.push('--open');

  await import(pathToFileURL(path.join(APP_DIR, 'server.mjs')).href);
}

main().catch((e) => {
  console.error('启动失败:', e && e.message ? e.message : e);
  process.exitCode = 1;
});
