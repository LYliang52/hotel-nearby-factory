/**
 * 打包成 exe 后的入口。
 *
 * 做的事：
 *   1. 把内嵌在 exe 里的代码和网页解压到 %LOCALAPPDATA%\hotel-near-factory\app\
 *   2. 首次运行时生成一份 config.json（含打包时用的高德 key）
 *   3. 拉起真正的服务（server.mjs），并自动打开浏览器
 *
 * 为什么要解压而不是直接在内存里跑：server.mjs 要用相对路径读 public/ 静态文件，
 * 而且用户的 config.json、补录的价格、携程登录态都得落在磁盘上。
 *
 * 开发时直接 node server.mjs 即可，本文件只在打包后生效。
 */
import { isSea, getAsset, getAssetKeys } from 'node:sea';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

if (!isSea()) {
  console.error('这是给打包后的 exe 用的入口。开发时请运行：node server.mjs');
  process.exit(1);
}

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
  // 配置模板单独处理
  if (key === 'config.default.json') continue;
  const target = path.join(APP_DIR, key);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, Buffer.from(getAsset(key)));
  count += 1;
}
console.log(`  已就绪（${count} 个文件）`);

/* ---- 2. 首次运行生成配置 ---- */
if (!existsSync(CONFIG)) {
  await fs.writeFile(CONFIG, Buffer.from(getAsset('config.default.json')));
  console.log('  已生成 config.json（高德 key 用的打包时的那个，可自己改）');
}

/* ---- 3. 拉起服务 ---- */
process.env.HNF_APP_DIR = APP_DIR;
process.env.HNF_DATA_DIR = BASE;

// 双击 exe 时默认打开浏览器；带 --no-open 可以关掉
if (!process.argv.includes('--no-open')) process.argv.push('--open');

await import(pathToFileURL(path.join(APP_DIR, 'server.mjs')).href);
