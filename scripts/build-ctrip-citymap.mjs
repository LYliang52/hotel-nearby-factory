#!/usr/bin/env node
/**
 * 生成携程城市 id 映射（data/ctrip-city-map.json）
 *   node scripts/build-ctrip-citymap.mjs            抓 id 1..120
 *   node scripts/build-ctrip-citymap.mjs --max 300  抓更多
 *
 * 为什么需要它：携程酒店列表 https://hotels.ctrip.com/hotels/list?city=<数字>
 * 只有带上正确的数字 id 才会按城市搜索，high德 citycode 与它不是一个体系，
 * 所以这里用"请求列表页 → 从 <title> 里读城市名"的方式反查，一次性落盘缓存。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'data', 'ctrip-city-map.json');

const argv = process.argv.slice(2);
const maxId = Number(argv[argv.indexOf('--max') + 1]) || 130;
const fromId = Number(argv[argv.indexOf('--from') + 1]) || 1;
const CONCURRENCY = 4;

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

/** 明显不是城市的标题 */
const NOT_CITY = new Set(['海外', '国际', '国外', '全球', '周边', '热门', '特价', '酒店']);

function extractCity(html) {
  const m = html.match(/<title[^>]*>([\s\S]{0,200}?)<\/title>/i);
  if (!m) return null;
  const title = m[1].trim();
  // 形如 "苏州酒店,苏州酒店预订查询,苏州宾馆住宿【携程酒店】"
  const first = title.split(/[,，]/)[0].trim();
  const hit = first.match(/^(.+?)酒店/);
  if (!hit) return null;
  const city = hit[1].trim();
  if (!city || city.length < 2 || city.length > 8) return null;
  // 携程的下线记录，形如 _del_贵溪 —— 留着会让"贵溪"误命中废弃 id
  if (city.includes('_del')) return null;
  if (NOT_CITY.has(city)) return null;
  if (/预订|查询|推荐|住宿|宾馆|排行|列表/.test(city)) return null;
  // 再确认标题里确实出现了"<城市>酒店预订"这种模式
  if (!title.includes(`${city}酒店`)) return null;
  return city;
}

async function probe(id) {
  const url = `https://hotels.ctrip.com/hotels/list?city=${id}`;
  try {
    const res = await fetch(url, {
      headers: { 'user-agent': UA, 'accept-language': 'zh-CN,zh;q=0.9' },
      signal: AbortSignal.timeout(15000)
    });
    if (!res.ok) return null;
    // 只需要 <title>，读前 20KB 就够，不用把整页拉下来
    const reader = res.body.getReader();
    let buf = '';
    let bytes = 0;
    while (bytes < 20000) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.length;
      buf += Buffer.from(value).toString('utf8');
      if (/<\/title>/i.test(buf)) break;
    }
    reader.cancel().catch(() => {});
    return extractCity(buf);
  } catch {
    return null;
  }
}

async function main() {
  console.log(`探测携程 city id ${fromId}..${maxId}…`);
  const map = {};
  const ids = Array.from({ length: Math.max(0, maxId - fromId + 1) }, (_, i) => i + fromId);

  for (let i = 0; i < ids.length; i += CONCURRENCY) {
    const batch = ids.slice(i, i + CONCURRENCY);
    const results = await Promise.all(batch.map((id) => probe(id)));
    results.forEach((city, k) => {
      const id = batch[k];
      if (!city) return;
      // 同一城市可能有多个 id，保留较小的那个
      if (map[city] && map[city] <= id) return;
      map[city] = id;
    });
    const done = Math.min(i + CONCURRENCY, ids.length);
    process.stdout.write(`\r  ${done}/${ids.length}  已识别 ${Object.keys(map).length} 个城市  `);
  }
  process.stdout.write('\n');

  if (!Object.keys(map).length) {
    console.log('一个都没识别出来，可能是被风控了或者页面结构变了。稍后重试或手工维护 data/ctrip-city-map.json。');
    process.exitCode = 2;
    return;
  }

  // 合并已有映射（手工补充的不要丢）
  let existing = {};
  try {
    existing = JSON.parse((await fs.readFile(OUT, 'utf8')).replace(/^\uFEFF/, ''));
  } catch {
    /* 没有就算了 */
  }
  const merged = { ...existing, ...map };

  await fs.mkdir(path.dirname(OUT), { recursive: true });
  await fs.writeFile(OUT, `${JSON.stringify(merged, null, 2)}\n`, 'utf8');

  console.log(`✓ 写入 ${path.relative(ROOT, OUT)}，共 ${Object.keys(merged).length} 个城市`);
  console.log('  示例：', Object.entries(map).slice(0, 8).map(([c, id]) => `${c}=${id}`).join('  '));
}

main().catch((e) => {
  console.error('失败:', e.message);
  process.exit(1);
});
