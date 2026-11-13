#!/usr/bin/env node
/**
 * 打包成单文件 exe（免安装，自带 Node 运行时）
 *
 *   node scripts/build-exe.mjs
 *
 * 用的是 Node 官方的 SEA（Single Executable Application），不需要 electron / pkg 这类第三方打包器。
 * 产物：dist/出差小助手.exe（约 90MB，双击即用）
 *
 * 依赖：postject（只在这一步用，不进项目依赖）
 *   如果没装，脚本会自动装到系统临时目录
 *
 * 注意：exe 里内嵌了当前的 config.json，也就是你的高德 key 会在里面。
 * 自己用没问题，别随手发给别人。
 */
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const BUILD = path.join(ROOT, '.build');
const EXE_NAME = 'hotel-near-factory.exe';
const SEA_FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';

const c = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`
};

/** 底座 Node 版本：SEA blob 必须和底座的版本严格一致 */
const BASE_NODE_VERSION = 'v22.23.5';

/**
 * 找底座 node.exe。
 * 为什么不用当前进程的 node：Node 25 的二进制里 SEA sentinel 出现了多次，
 * postject 会报 "Multiple occurences of sentinel"，注入失败。Node 22 LTS 没这个问题。
 *
 * 优先级：--base 参数 > 环境变量 > 缓存 > 自动下载
 */
async function resolveBaseNode() {
  const argIdx = process.argv.indexOf('--base');
  if (argIdx > 0 && process.argv[argIdx + 1]) {
    const p = path.resolve(process.argv[argIdx + 1]);
    if (!existsSync(p)) throw new Error(`--base 指定的文件不存在：${p}`);
    return p;
  }
  if (process.env.HNF_BASE_NODE && existsSync(process.env.HNF_BASE_NODE)) {
    return process.env.HNF_BASE_NODE;
  }

  const cache = path.join(os.tmpdir(), 'hnf-base');
  const cached = path.join(cache, `node-${BASE_NODE_VERSION}.exe`);
  if (existsSync(cached)) return cached;

  // 当前 Node 正好是要用的版本，直接用
  if (process.versions.node === BASE_NODE_VERSION.replace('v', '')) return process.execPath;

  console.log(`  ${c.dim(`没找到底座，下载 Node ${BASE_NODE_VERSION}（约 34MB）…`)}`);
  await fs.mkdir(cache, { recursive: true });
  const url = `https://registry.npmmirror.com/-/binary/node/${BASE_NODE_VERSION}/node-${BASE_NODE_VERSION}-win-x64.zip`;
  const zipPath = path.join(cache, 'node.zip');

  if (!existsSync(zipPath)) {
    const res = await fetch(url, { signal: AbortSignal.timeout(300000) });
    if (!res.ok) throw new Error(`下载失败 ${res.status}，可以手动指定：--base <node22的exe路径>`);
    await fs.writeFile(zipPath, Buffer.from(await res.arrayBuffer()));
  }

  // 用 PowerShell 解压（Node 没有内置 zip）
  const unzipDir = path.join(cache, 'unzip');
  await fs.rm(unzipDir, { recursive: true, force: true });
  await fs.mkdir(unzipDir, { recursive: true });
  const r = spawnSync(
    'powershell',
    ['-NoProfile', '-Command', `Expand-Archive -Path '${zipPath}' -DestinationPath '${unzipDir}' -Force`],
    { stdio: 'inherit' }
  );
  if (r.status !== 0) throw new Error('解压底座失败');

  const dirs = await fs.readdir(unzipDir);
  const inner = dirs.find((d) => d.startsWith('node-'));
  if (!inner) throw new Error('解压目录结构不对');
  const extracted = path.join(unzipDir, inner, 'node.exe');
  if (!existsSync(extracted)) throw new Error('解压后没找到 node.exe');

  await fs.copyFile(extracted, cached);
  await fs.rm(unzipDir, { recursive: true, force: true });
  console.log(`  ${c.dim(`底座已缓存：${cached}`)}`);
  return cached;
}

/** 要打进 exe 的文件（相对路径，用 / 分隔） */
async function collectAssets() {
  const assets = [];

  async function walk(rel) {
    const abs = path.join(ROOT, rel);
    const entries = await fs.readdir(abs, { withFileTypes: true });
    for (const e of entries) {
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        // 构建产物、用户登录态不进包；assets 里只打包 icon.ico 和 tray.ps1（源图 logo.jpg 在下面单独排除）
        if (['node_modules', 'dist', '.build', '.reasonix'].includes(e.name)) continue;
        if (e.name === 'chrome-profile') continue;
        await walk(childRel);
      } else {
        if (e.name.endsWith('.exe')) continue;
        if (e.name === 'config.example.json') continue;
        // 入口文件已经是 exe 本体，不用再当资源解压一份
        if (e.name === 'boot.cjs') continue;
        // 用户自己补录的价格不进包，否则会覆盖掉对方的
        if (childRel === 'data/prices.json') continue;
        // 图标源图（大 jpg）不进包，图标已经写进 exe 资源、ico 单独打包
        if (childRel === 'assets/logo.jpg') continue;
        assets.push(childRel);
      }
    }
  }

  await walk('');
  return assets.filter((f) => f && !f.startsWith('.'));
}

/**
 * 移除 PE 的数字签名。
 * node.exe 自带签名，postject 注入前必须先去掉，否则会报
 * "The signature seems corrupted"，而且 sentinel 定位也会错乱。
 * 官方做法是 signtool remove，但 signtool 要装 Windows SDK，
 * 这里直接改 PE 头：把 DataDirectory 里 Certificate Table 的地址和长度清零。
 */
async function stripPeSignature(exePath) {
  const buf = await fs.readFile(exePath);

  const peOffset = buf.readUInt32LE(0x3c);
  if (buf.toString('latin1', peOffset, peOffset + 4) !== 'PE\0\0') {
    throw new Error('不是有效的 PE 文件');
  }
  const coffOffset = peOffset + 4;
  const optOffset = coffOffset + 20;
  const magic = buf.readUInt16LE(optOffset);
  // PE32+ 是 0x20b，PE32 是 0x10b，两者 DataDirectory 起点不同
  const dataDirOffset = optOffset + (magic === 0x20b ? 112 : 96);
  const certDirOffset = dataDirOffset + 4 * 8; // 第 5 项 = Certificate Table

  const addr = buf.readUInt32LE(certDirOffset);
  const size = buf.readUInt32LE(certDirOffset + 4);
  if (!addr && !size) return { removed: false };

  buf.writeUInt32LE(0, certDirOffset);
  buf.writeUInt32LE(0, certDirOffset + 4);
  await fs.writeFile(exePath, buf);
  return { removed: true, addr, size };
}

/**
 * 中和 blob 里的 fuse 字符串。
 *
 * postject 的流程是：先把 blob 注入 exe，再在**注入后的 buffer** 里找 sentinel 并改成 :1。
 * 而 Node 22 生成的 blob 里恰好也有一份 fuse 字符串，于是它数出 2 个，直接报
 * "Multiple occurences of sentinel" 拒绝工作（postject 1.0.0-alpha.6 的兼容 bug）。
 *
 * 这里把 blob 里那份替换成等长的 0，注入后 exe 里就只剩原始的那一个了。
 * 长度保持不变，不会破坏 blob 的结构。
 */
async function neutralizeBlobFuse(blobPath, fuse) {
  const buf = await fs.readFile(blobPath);
  const replacement = Buffer.alloc(fuse.length, 0x30); // 全 '0'，长度一致
  let count = 0;
  let idx = 0;
  while ((idx = buf.indexOf(fuse, idx)) !== -1) {
    replacement.copy(buf, idx);
    idx += fuse.length;
    count += 1;
  }
  if (count) await fs.writeFile(blobPath, buf);
  return count;
}

/** 确保 postject 可用，返回它的 CLI 路径 */
async function ensurePostject() {
  const local = path.join(ROOT, 'node_modules', 'postject', 'dist', 'cli.js');
  if (existsSync(local)) return local;

  const cache = path.join(os.tmpdir(), 'sea-tools');
  const cached = path.join(cache, 'node_modules', 'postject', 'dist', 'cli.js');
  if (existsSync(cached)) return cached;

  console.log(`  ${c.dim('postject 没装，装到临时目录…')}`);
  await fs.mkdir(cache, { recursive: true });
  const r = spawnSync('npm', ['install', 'postject', '--no-audit', '--no-fund', '--loglevel=error'], {
    cwd: cache,
    shell: true,
    stdio: 'inherit'
  });
  if (r.status !== 0) throw new Error('postject 安装失败，检查网络或手动 npm i -D postject');
  if (!existsSync(cached)) throw new Error('postject 装完了但找不到 cli.js');
  return cached;
}

/** 确保 rcedit 可用，返回它的 exe 路径（用来给 exe 换图标） */
async function ensureRcedit() {
  const local = path.join(ROOT, 'node_modules', 'rcedit', 'bin', 'rcedit.exe');
  if (existsSync(local)) return local;

  const cache = path.join(os.tmpdir(), 'sea-tools');
  const cached = path.join(cache, 'node_modules', 'rcedit', 'bin', 'rcedit.exe');
  if (existsSync(cached)) return cached;

  console.log(`  ${c.dim('rcedit 没装，装到临时目录…')}`);
  await fs.mkdir(cache, { recursive: true });
  const r = spawnSync('npm', ['install', 'rcedit', '--no-audit', '--no-fund', '--loglevel=error'], {
    cwd: cache,
    shell: true,
    stdio: 'inherit'
  });
  if (r.status !== 0) throw new Error('rcedit 安装失败，检查网络');
  if (!existsSync(cached)) throw new Error('rcedit 装完了但找不到 rcedit.exe');
  return cached;
}

/**
 * 把 exe 的 PE 子系统从 console(3) 改成 GUI(2)，双击不再弹黑色控制台窗口。
 * PE32 和 PE32+ 的 Subsystem 字段都在 Optional Header 偏移 68 处。
 * 必须放在 postject 注入之后（rcedit 等工具会重建 PE 覆盖这里）。
 */
async function setWindowsSubsystem(exePath, subsystem = 2) {
  const buf = await fs.readFile(exePath);
  const peOffset = buf.readUInt32LE(0x3c);
  if (buf.toString('latin1', peOffset, peOffset + 4) !== 'PE\0\0') {
    throw new Error('不是有效的 PE 文件');
  }
  const optOffset = peOffset + 24;
  const magic = buf.readUInt16LE(optOffset);
  if (magic !== 0x20b && magic !== 0x10b) throw new Error('未知的 PE 格式');
  const subOffset = optOffset + 68;
  buf.writeUInt16LE(subsystem, subOffset);
  await fs.writeFile(exePath, buf);
  return subsystem;
}

async function main() {
  console.log('');
  console.log(c.bold('  打包 exe（Node SEA）'));
  console.log(c.dim('  ────────────────────────────────'));

  const major = Number(process.versions.node.split('.')[0]);
  if (major < 20) {
    console.log(`  ${c.red('✗')} Node ${process.versions.node} 太旧，SEA 需要 20 以上`);
    process.exit(1);
  }
  console.log(`  Node ${process.versions.node}（打包用）`);

  // 0. 配置检查
  if (!existsSync(path.join(ROOT, 'config.json'))) {
    console.log(`  ${c.red('✗')} 没有 config.json，先在项目里配好高德 key 再打包`);
    process.exit(1);
  }

  // 底座
  const baseNode = await resolveBaseNode();
  const baseVer = execFileSync(baseNode, ['--version'], { encoding: 'utf8' }).trim();
  console.log(`  底座 ${baseVer}（blob 必须和它版本一致）`);
  if (baseVer !== BASE_NODE_VERSION) {
    console.log(`  ${c.yellow('•')} 底座版本是 ${baseVer}，脚本按 ${BASE_NODE_VERSION} 预期，继续但不保证兼容`);
  }

  await fs.mkdir(DIST, { recursive: true });
  await fs.rm(BUILD, { recursive: true, force: true });
  await fs.mkdir(BUILD, { recursive: true });

  // 1. 收集资源
  const assets = await collectAssets();
  console.log(`  资源文件 ${assets.length} 个`);

  // 2. config.json 改个名当默认配置（避免和运行时那份混淆）
  const configJson = JSON.parse(await fs.readFile(path.join(ROOT, 'config.json'), 'utf8'));
  const configDefault = path.join(BUILD, 'config.default.json');
  await fs.writeFile(configDefault, `${JSON.stringify(configJson, null, 2)}\n`, 'utf8');

  // 3. sea-config.json
  const assetsMap = {};
  for (const rel of assets) assetsMap[rel] = path.join(ROOT, rel);
  assetsMap['config.default.json'] = configDefault;

  const seaConfig = {
    main: path.join(ROOT, 'boot.cjs'),
    output: path.join(BUILD, 'sea-prep.blob'),
    disableExperimentalSEAWarning: true,
    useSnapshot: false,
    useCodeCache: false,
    assets: assetsMap
  };
  const seaConfigPath = path.join(BUILD, 'sea-config.json');
  await fs.writeFile(seaConfigPath, JSON.stringify(seaConfig, null, 2), 'utf8');

  // 4. 生成 blob（必须用底座那个 Node，版本要对得上）
  console.log(`  ${c.dim('生成 SEA blob…')}`);
  execFileSync(baseNode, ['--experimental-sea-config', seaConfigPath], { stdio: 'inherit' });
  const blob = await fs.stat(seaConfig.output);
  console.log(`  blob ${(blob.size / 1024).toFixed(0)} KB`);

  // 4.5 中和 blob 里的 fuse（否则 postject 会误判 sentinel 出现多次）
  const neutralized = await neutralizeBlobFuse(seaConfig.output, SEA_FUSE);
  if (neutralized) {
    console.log(`  ${c.dim(`已中和 blob 内的 ${neutralized} 处 fuse 副本`)}`);
  }

  // 5. 复制底座 node.exe
  const exePath = path.join(DIST, EXE_NAME);
  await fs.copyFile(baseNode, exePath);
  console.log(`  ${c.dim(`底座 ${path.basename(baseNode)} 已复制`)}`);

  // 6. 注入前先去掉 node.exe 的数字签名
  //    注意：只清零证书表指针而不截断证书数据，可能让 PE 结构不一致（postject 会报 Couldn't write executable），
  //    所以这里做成可关闭的，默认尝试不加签名处理也能注入。
  if (!process.argv.includes('--keep-signature')) {
    const sig = await stripPeSignature(exePath);
    if (sig.removed) {
      console.log(`  ${c.dim(`已移除底座签名（证书表 ${sig.size} 字节）`)}`);
    }
  }

  // 6.5 换图标（必须在 postject 注入之前：rcedit 会重建 PE 并丢弃文件末尾的 overlay，会砸掉 blob）
  const iconPath = path.join(ROOT, 'assets', 'icon.ico');
  if (existsSync(iconPath)) {
    const rcedit = await ensureRcedit();
    console.log(`  ${c.dim('写入 exe 图标…')}`);
    execFileSync(rcedit, [exePath, '--set-icon', iconPath], { stdio: 'inherit' });
    console.log(`  ${c.green('✓')} 图标已设置（assets\\icon.ico）`);
  } else {
    console.log(`  ${c.yellow('•')} 没有 assets\\icon.ico，跳过换图标（保留默认图标）`);
  }

  // 7. postject 注入
  const postject = await ensurePostject();
  console.log(`  ${c.dim('注入 blob…（大文件，慢一点）')}`);
  execFileSync(
    process.execPath,
    [postject, exePath, 'NODE_SEA_BLOB', seaConfig.output, '--sentinel-fuse', SEA_FUSE],
    { stdio: 'inherit' }
  );

  // 7.5 隐藏控制台：把子系统改成 GUI，双击不再弹黑色窗口（必须在注入之后，别的工具可能重建 PE 头）
  await setWindowsSubsystem(exePath, 2);
  console.log(`  ${c.dim('已改为 GUI 子系统（双击不再弹控制台窗口）')}`);

  // 8. 收尾
  await fs.rm(BUILD, { recursive: true, force: true });
  const final = await fs.stat(exePath);
  console.log('');
  console.log(c.dim('  ────────────────────────────────'));
  console.log(`  ${c.green('✓ 打包完成')}`);
  console.log(`  产物：dist\\${EXE_NAME}  (${(final.size / 1024 / 1024).toFixed(1)} MB)`);
  console.log('');
  console.log(c.dim('  双击就能用，不需要装 Node。'));
  console.log(c.dim('  首次运行会在 %LOCALAPPDATA%\\hotel-near-factory\\ 下解压代码并生成 config.json。'));
  console.log(`  ${c.yellow('注意')}：exe 里内嵌了你当前的 config.json（含高德 key），别随手发给别人。`);
  console.log('');
}

main().catch((e) => {
  console.error(`  ${c.red('✗')} 打包失败:`, e.message);
  process.exit(1);
});
