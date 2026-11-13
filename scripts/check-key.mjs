#!/usr/bin/env node
/**
 * 高德 key 自检
 *   node scripts/check-key.mjs
 * 依次试：IP 定位、地理编码、关键字搜索、周边搜索，定位出到底哪一步不通。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAmapClient, AMAP_ERRORS } from '../lib/amap.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function main() {
  let config = {};
  try {
    config = JSON.parse((await fs.readFile(path.join(ROOT, 'config.json'), 'utf8')).replace(/^\uFEFF/, ''));
  } catch {
    console.error('读不到 config.json');
    process.exit(1);
  }

  const key = process.env.AMAP_KEY || config.amapKey || '';
  console.log(`key: ${key ? `${key.slice(0, 6)}…${key.slice(-4)}（长度 ${key.length}）` : '未配置'}`);
  if (!key) process.exit(1);

  const amap = createAmapClient({ key, minRequestGapMs: Number(config.server?.minRequestGapMs ?? 350) });

  const steps = [
    ['IP 定位        /v3/ip', () => amap.call('/v3/ip', {})],
    ['地理编码        /v3/geocode/geo', () => amap.geocode({ address: '上海市人民广场' })],
    ['关键字搜索 /v3/place/text', () => amap.textSearch({ keywords: '全季酒店', city: '上海' })],
    ['周边搜索     /v3/place/around', () => amap.aroundSearch({ location: { lng: 121.4737, lat: 31.2304 }, radius: 2000, maxPages: 1 })]
  ];

  const failed = [];
  for (const [label, run] of steps) {
    try {
      const r = await run();
      const n = Array.isArray(r) ? r.length : Array.isArray(r?.hotels) ? r.hotels.length : 1;
      console.log(`✓ ${label}  →  返回 ${n} 条`);
    } catch (e) {
      console.log(`✗ ${label}  →  ${e.info || e.message}${e.infocode ? ` (${e.infocode})` : ''}`);
      failed.push(e);
    }
  }

  if (!failed.length) {
    console.log('\n全部通过，可以正常使用。');
    return;
  }

  // 同一类错误只解释一次
  const infocodes = [...new Set(failed.map((e) => e.infocode).filter(Boolean))];
  for (const code of infocodes) {
    if (code === '10009') {
      console.log(`
这条 key 的平台类型不是「Web服务」，而 geocode / place 这些接口只认 Web服务 类型的 key。
高德 key 创建后平台类型不可修改，只能新建一个：

  1. 打开 https://console.amap.com  →  「应用管理」
  2. 新建应用（或选中已有应用）→「添加 Key」
  3. 服务平台选「Web 服务」（不要选 JavaScript API / Android / iOS / 小程序）
  4. 把新 key 填进 config.json 的 amapKey，重启 node server.mjs

在此之前，页面点「先看演示效果」可以看到完整的界面和交互。`);
    } else if (AMAP_ERRORS[code]) {
      console.log(`\n${code}：${AMAP_ERRORS[code]}`);
    }
  }

  process.exitCode = 2;
}

main();
