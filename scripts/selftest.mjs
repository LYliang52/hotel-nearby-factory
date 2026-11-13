#!/usr/bin/env node
/**
 * 自检 + 生成演示数据
 *   node scripts/selftest.mjs
 *
 * 1) 跑一遍纯函数（品牌识别、酒店判别、打分）的断言
 * 2) 生成 data/demo-plan.json —— key 还没配好时，页面「先看演示效果」用的完整数据
 *
 * 演示数据里除坐标是合成的，其余字段结构与真实查询结果完全一致。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

import { buildHotelList, createBrandMatcher, isProperHotel, starLabel } from '../lib/hotels.mjs';
import { buildPriceLinks } from '../lib/ctrip.mjs';
import { buildPlan, PlanError } from '../lib/plan.mjs';
import { createAmapClient } from '../lib/amap.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SUZHOU_CTRIP_CITY_ID = 14; // https://hotels.ctrip.com/hotels/list?city=14 实测为苏州

const CENTER = { lng: 120.7, lat: 31.31 }; // 苏州工业园区星湖街一带

/** 以某点为圆心按米/角度推算坐标 */
function offset(center, meters, angleDeg) {
  const rad = (angleDeg * Math.PI) / 180;
  const dLat = (meters * Math.cos(rad)) / 111320;
  const dLng = (meters * Math.sin(rad)) / (111320 * Math.cos((center.lat * Math.PI) / 180));
  return { lng: center.lng + dLng, lat: center.lat + dLat };
}

/* ============ 1. 纯函数断言 ============ */
async function runAssertions(config) {
  const match = createBrandMatcher(config.brands || []);
  const cases = [
    ['桔子水晶苏州园区酒店', '桔子/华住中高端', 2],
    ['桔子酒店（苏州店）', '桔子/华住中高端', 2],
    ['希尔顿欢朋酒店（苏州园区店）', '希尔顿系', 1],
    ['苏州希尔顿酒店', '希尔顿系', 1],
    ['智选假日酒店（独墅湖店）', '假日/洲际系', 1],
    ['皇冠假日酒店（苏州园区）', '假日/洲际系', 1],
    ['华美达酒店（苏州）', '温德姆系', 1],
    ['温德姆花园酒店（苏州园区）', '温德姆系', 1],
    ['全季酒店（苏州独墅湖店）', '全季', 1],
    ['亚朵S酒店（苏州店）', '亚朵', 1],
    ['维也纳国际酒店（园区店）', '国内中高端连锁', 2],
    ['汉庭酒店（独墅湖店）', '经济型连锁', 3]
  ];
  for (const [name, group, tier] of cases) {
    const hit = match(name);
    assert.ok(hit, `品牌识别失败：${name}`);
    assert.equal(hit.group, group, `「${name}」应归入 ${group}，实际 ${hit.group}`);
    assert.equal(hit.tier, tier, `「${name}」tier 应为 ${tier}，实际 ${hit.tier}`);
  }
  assert.equal(match('星湖饭店'), null, '非连锁不应被识别成品牌');

  assert.equal(isProperHotel({ name: '某某民宿', typecode: '100100' }), false, '民宿应被判为非常规酒店');
  assert.equal(isProperHotel({ name: '某某青年旅舍', typecode: '100201' }), false, '青年旅舍应被过滤');
  assert.equal(isProperHotel({ name: '全季酒店', typecode: '100100' }), true, '连锁酒店应保留');

  console.log(`✓ 品牌识别与酒店判别断言全部通过（${cases.length + 4} 项）`);

  // 星级标签
  assert.equal(starLabel('100102'), '四星级');
  assert.equal(starLabel('100104'), '经济型');
  assert.equal(starLabel('141400|100000'), '住宿', '复合 typecode 也要能读');
  assert.equal(starLabel('100100'), '酒店');

  // 高德 URL 参数守卫：对象直接塞进 URLSearchParams 会变成 [object Object]，
  // 这个坑真实踩过（aroundSearch 曾把 location 对象直接传下去，高德只回 INVALID_PARAMS）
  const client = createAmapClient({ key: 'test', minRequestGapMs: 0 });
  await assert.rejects(
    () => client.call('/v3/place/around', { location: { lng: 120.7, lat: 31.3 } }),
    (e) => e.infocode === 'BAD_PARAM',
    '对象参数应立刻报 BAD_PARAM，而不是发出去变成 [object Object]'
  );
  console.log('✓ 星级标签与参数守卫断言通过');
}

/* ============ 2. 主流程编排（用假的高德客户端，不需要真 key） ============ */
function poi(id, name, lng, lat, distance, cost, extra = {}) {
  return {
    id,
    name,
    type: '住宿服务;宾馆酒店',
    typecode: '100100',
    address: '苏州工业园区某路 1 号',
    lng,
    lat,
    distance,
    tel: '0512-1234 5678',
    cityname: '苏州市',
    adname: '工业园区',
    pname: '江苏省',
    adcode: '320594',
    citycode: '0512',
    rating: 4.5,
    cost,
    costSource: cost != null ? 'amap' : null,
    businessArea: '',
    photos: [],
    ...extra
  };
}

const FACTORY = { id: 'FACTORY1', name: '某某精密制造（苏州）有限公司', address: '苏州工业园区星湖街 88 号', cityname: '苏州市', adname: '工业园区', lng: 120.7, lat: 31.31, typecode: '170000' };

function createFakeAmap({ emptySearch = false } = {}) {
  const calls = [];
  return {
    calls,
    async textSearch({ keywords, city }) {
      calls.push(['textSearch', keywords, city]);
      if (emptySearch) return [];
      return [
        { ...FACTORY, cityname: '苏州市', adname: '工业园区' },
        { ...FACTORY, id: 'FACTORY2', name: '某某精密制造 二厂', lng: 120.72, lat: 31.33 }
      ];
    },
    async aroundSearch({ location, radius, maxPages }) {
      calls.push(['aroundSearch', location.lng, location.lat, radius, maxPages]);
      return {
        reportedCount: 42,
        hotels: [
          poi('H1', '全季酒店（苏州独墅湖店）', 120.7005, 31.3105, 320, 379),
          poi('H2', '亚朵酒店（苏州园区店）', 120.701, 31.312, 900, 459),
          poi('H3', '汉庭酒店（独墅湖店）', 120.705, 31.315, 1500, 168),
          poi('H4', '某某民宿（演示）', 120.702, 31.311, 700, 288, { typecode: '100200', type: '住宿服务;旅馆招待所' }),
          poi('H5', '星程酒店（苏州店）', 120.712, 31.32, 3200, null),
          // 超出半径，必须被过滤掉
          poi('H6', '远处希尔顿', 120.9, 31.5, 25000, 800)
        ]
      };
    },
    async geocode({ address }) {
      calls.push(['geocode', address]);
      return [{ formatted: '上海市人民广场', city: '上海市', lng: 121.4737, lat: 31.2304, citycode: '021' }];
    },
    async regeo({ location }) {
      calls.push(['regeo', location]);
      return { formatted: '苏州工业园区星湖街 88 号', city: '苏州市', district: '工业园区', citycode: '0512' };
    },
    async driving() {
      calls.push(['driving']);
      return [{ distance: 92000, durationMin: 78, tolls: 45, trafficLights: 22, strategy: '距离优先' }];
    },
    async transitIntegrated({ city1, city2 }) {
      calls.push(['transit', city1, city2]);
      return [{ distance: 88000, durationMin: 92, cost: 45, legs: [{ mode: 'train', name: 'G7008 上海虹桥 → 苏州园区' }] }];
    }
  };
}

function createFakeStore(seed = {}) {
  const prices = { ...seed };
  return {
    async loadPrices() {
      return prices;
    },
    async setPrice(id, v) {
      prices[id] = { price: Number(v.price), note: v.note || '', source: v.source || '' };
      return prices[id];
    },
    async removePrice(id) {
      delete prices[id];
      return true;
    }
  };
}

async function testPlanPipeline(config) {
  const ctripCityMap = JSON.parse(await fs.readFile(path.join(ROOT, 'data', 'ctrip-city-map.json'), 'utf8'));


  /* --- 正常路径 --- */
  const amap = createFakeAmap();
  const plan = await buildPlan({
    amap,
    config,
    params: { factory: '某某精密制造', city: '苏州', from: '上海', radiusKm: 10, priceMin: 300, priceMax: 600 },
    store: createFakeStore({ H3: { price: 388, source: '携程', note: '含早' } }),
    ctripCityMap
  });

  assert.equal(plan.ok, true);
  assert.equal(plan.factory.name, FACTORY.name);
  assert.equal(plan.factory.city, '苏州市', 'city 应取自 POI 的 cityname');
  assert.equal(plan.factory.district, '工业园区', 'district 应取自 POI 的 adname');
  assert.equal(plan.candidates.length, 2, '应返回全部候选地点');
  assert.equal(plan.query.radiusKm, 10);

  assert.equal(plan.hotels.length, 5, `半径内应为 5 家（10km 过滤掉 H6），实际 ${plan.hotels.length}`);
  assert.ok(!plan.hotels.some((h) => h.id === 'H6'), '超出半径的酒店不该出现');

  const dists = plan.hotels.map((h) => h.distance);
  assert.deepEqual(dists, [...dists].sort((a, b) => a - b), '酒店应按距离升序');

  const h1 = plan.hotels.find((h) => h.id === 'H1');
  assert.equal(h1.brand.group, '全季');
  assert.equal(h1.brand.tier, 1);
  assert.equal(h1.inBudget, true);
  assert.ok(h1.score.total > 0);
  assert.ok(h1.links.ctrip.includes('city=14'), '核价链接应带携程城市 id');

  const h3 = plan.hotels.find((h) => h.id === 'H3');
  assert.equal(h3.price, 388, '人工补录价格应覆盖高德人均');
  assert.equal(h3.priceSource, 'manual');

  const h5 = plan.hotels.find((h) => h.id === 'H5');
  assert.equal(h5.price, null, '没有价格时应为 null');
  assert.equal(h5.inBudget, null);
  assert.ok(h5.links.ctripFallback, '没有城市 id 时也要有兜底链接');

  assert.equal(plan.hotels.find((h) => h.id === 'H4').isProper, false, '民宿应被标记 isProper=false');

  assert.ok(plan.travel.driving.length > 0);
  assert.ok(plan.travel.transit.length > 0);
  assert.equal(plan.travel.transit[0].legs[0].mode, 'train');
  assert.ok(plan.travel.straightKm > 0);

  assert.ok(plan.hotels.filter((h) => h.inBudget).length >= 2, '应有预算内酒店');
  assert.ok(plan.warnings.some((w) => w.includes('42')), '取得比总数少时应提示');

  /* --- 坐标直给路径 --- */
  const amap2 = createFakeAmap();
  const plan2 = await buildPlan({
    amap: amap2,
    config,
    params: { factoryLng: 120.7, factoryLat: 31.31, factoryName: '手选地点', radiusKm: 5 },
    store: createFakeStore(),
    ctripCityMap
  });
  assert.equal(plan2.factory.name, '手选地点');
  assert.equal(plan2.factory.city, '苏州市');
  assert.ok(!amap2.calls.some((c) => c[0] === 'textSearch'), '给了坐标就不该再搜关键字');
  assert.equal(plan2.travel, null, '没填出发地就不算交通');

  /* --- 找不到厂家 --- */
  await assert.rejects(
    () =>
      buildPlan({
        amap: createFakeAmap({ emptySearch: true }),
        config,
        params: { factory: '不存在的工厂 XYZ', city: '苏州' },
        store: createFakeStore(),
        ctripCityMap
      }),
    (e) => e instanceof PlanError && e.code === 'FACTORY_NOT_FOUND',
    '找不到厂家时应抛 FACTORY_NOT_FOUND'
  );

  /* --- 缺参数 --- */
  await assert.rejects(
    () => buildPlan({ amap: createFakeAmap(), config, params: {}, store: createFakeStore(), ctripCityMap }),
    (e) => e instanceof PlanError && e.code === 'MISSING_FACTORY'
  );

  console.log('✓ 主流程编排断言通过（正常路径 / 坐标直给 / 找不到厂家 / 缺参数）');
}

/* ============ 3. 生成演示数据 ============ */
const DEMO_RAW = [
  { name: '全季酒店（苏州独墅湖高教区店）', d: 320, a: 20, price: 379, rating: 4.6, tel: '0512-8888 0001', addr: '苏州工业园区星湖街 128 号' },
  { name: '亚朵酒店（苏州园区星湖街店）', d: 540, a: 74, price: 459, rating: 4.8, tel: '0512-8888 0002', addr: '苏州工业园区星湖街 199 号' },
  { name: '希尔顿欢朋酒店（苏州园区店）', d: 880, a: 140, price: 528, rating: 4.7, tel: '0512-8888 0003', addr: '苏州工业园区苏虹东路 18 号' },
  { name: '某村精品民宿（演示）', d: 1050, a: 200, price: 288, rating: 4.2, tel: '0512-8888 0004', addr: '苏州工业园区某村 12 号', type: '住宿服务;旅馆招待所', typecode: '100200' },
  { name: '智选假日酒店（苏州独墅湖店）', d: 1250, a: 255, price: 428, rating: 4.4, tel: '0512-8888 0005', addr: '苏州工业园区独墅湖大道 66 号' },
  { name: '桔子水晶苏州园区酒店', d: 1520, a: 310, price: 398, rating: 4.6, tel: '0512-8888 0006', addr: '苏州工业园区星港街 8 号' },
  { name: '维也纳国际酒店（苏州园区店）', d: 1880, a: 12, price: 318, rating: 4.3, tel: '0512-8888 0007', addr: '苏州工业园区东延路 100 号' },
  { name: '某某青年旅舍（演示）', d: 2180, a: 48, price: 88, rating: 4.0, tel: '0512-8888 0008', addr: '苏州工业园区某巷 3 号', type: '住宿服务;旅馆招待所', typecode: '100201' },
  { name: '温德姆花园酒店（苏州园区）', d: 2420, a: 95, price: 568, rating: 4.5, tel: '0512-8888 0009', addr: '苏州工业园区苏虹中路 288 号' },
  { name: '全季酒店（苏州月亮湾店）', d: 2780, a: 132, price: 365, rating: 4.5, tel: '0512-8888 0010', addr: '苏州工业园区月亮湾路 15 号' },
  { name: '美居酒店（苏州独墅湖店）', d: 3120, a: 176, price: 432, rating: 4.4, tel: '0512-8888 0011', addr: '苏州工业园区仁爱路 99 号' },
  { name: '丽枫酒店（苏州园区星湖街店）', d: 3580, a: 222, price: 286, rating: 4.2, tel: '0512-8888 0012', addr: '苏州工业园区星湖街 588 号' },
  { name: '皇冠假日酒店（苏州园区）', d: 4180, a: 268, price: 688, rating: 4.7, tel: '0512-8888 0013', addr: '苏州工业园区中新大道东 1 号' },
  { name: '亚朵S酒店（苏州独墅湖店）', d: 4760, a: 300, price: 562, rating: 4.9, tel: '0512-8888 0014', addr: '苏州工业园区独墅湖高教区 22 号' },
  { name: '汉庭酒店（苏州独墅湖店）', d: 5320, a: 340, price: 186, rating: 4.1, tel: '0512-8888 0015', addr: '苏州工业园区娄葑街道 66 号' },
  { name: '如家酒店（苏州园区店）', d: 5860, a: 25, price: 168, rating: 3.9, tel: '0512-8888 0016', addr: '苏州工业园区金鸡湖大道 200 号' },
  { name: '希尔顿酒店（苏州园区店）', d: 6420, a: 62, price: 728, rating: 4.8, tel: '0512-8888 0017', addr: '苏州工业园区苏州大道东 88 号' },
  { name: '全季酒店（苏州尹山湖店）', d: 7180, a: 118, price: null, rating: 4.4, tel: '0512-8888 0018', addr: '苏州吴中区尹山湖路 9 号' },
  { name: '维也纳酒店（苏州郭巷店）', d: 7920, a: 168, price: 258, rating: 4.0, tel: '0512-8888 0019', addr: '苏州吴中区郭巷街道 51 号' },
  { name: '星程酒店（苏州独墅湖店）', d: 8540, a: 214, price: null, rating: 4.3, tel: '0512-8888 0020', addr: '苏州工业园区车坊街道 12 号' }
];

async function buildDemo(config) {
  const radiusKm = 10;
  const radiusMeters = radiusKm * 1000;
  const priceMin = config.defaults?.priceMin ?? 300;
  const priceMax = config.defaults?.priceMax ?? 600;

  const pois = DEMO_RAW.map((r, i) => {
    const p = offset(CENTER, r.d, r.a);
    return {
      id: `DEMO${String(i + 1).padStart(2, '0')}`,
      name: r.name,
      type: r.type || '住宿服务;宾馆酒店',
      typecode: r.typecode || '100100',
      address: r.addr,
      lng: Number(p.lng.toFixed(6)),
      lat: Number(p.lat.toFixed(6)),
      distance: r.d,
      tel: r.tel,
      cityname: '苏州市',
      adname: '工业园区',
      pname: '江苏省',
      adcode: '320594',
      citycode: '0512',
      rating: r.rating ?? null,
      cost: r.price ?? null,
      costSource: r.price != null ? 'amap' : null,
      businessArea: '',
      photos: []
    };
  });

  const matchBrand = createBrandMatcher(config.brands || []);
  const hotels = buildHotelList({
    pois,
    center: CENTER,
    radiusMeters,
    priceMin,
    priceMax,
    matchBrand,
    manualPrices: {},
    includeNonHotel: true,
    requirePrice: false,
    haversine: () => null
  });

  const withLinks = hotels.map((h) => ({
    ...h,
    links: buildPriceLinks({
      templates: config.priceCheck || {},
      hotel: h,
      city: '苏州市',
      ctripCityId: SUZHOU_CTRIP_CITY_ID
    })
  }));

  const plan = {
    ok: true,
    demo: true,
    query: { city: '苏州市', factory: '示例精密制造（苏州）有限公司', from: '上海', radiusKm, priceMin, priceMax },
    factory: {
      id: 'DEMO_FACTORY',
      name: '示例精密制造（苏州）有限公司',
      address: '苏州工业园区星湖街 88 号（演示坐标为合成值）',
      lng: CENTER.lng,
      lat: CENTER.lat,
      city: '苏州市',
      district: '工业园区',
      typecode: '170000'
    },
    candidates: [],
    hotels: withLinks,
    travel: {
      from: '上海',
      to: '苏州市',
      straightKm: 68,
      fromPoint: { name: '上海市人民广场', city: '上海市', lng: 121.4737, lat: 31.2304 },
      driving: [
        { distance: 92000, durationMin: 78, tolls: 45, trafficLights: 22, strategy: '距离优先' },
        { distance: 98000, durationMin: 82, tolls: 50, trafficLights: 18, strategy: '时间优先' }
      ],
      transit: [
        {
          distance: 88000,
          durationMin: 92,
          cost: 45,
          legs: [
            { mode: 'train', name: 'G7008 上海虹桥 → 苏州园区', departure: '上海虹桥', arrival: '苏州园区' },
            { mode: 'bus', name: '地铁 1 号线 苏州园区站 → 星湖街站' }
          ]
        }
      ],
      notes: ['演示数据：真实值由高德路径规划接口返回（含驾车与跨城综合交通）。'],
      links: {
        train: config.priceCheck?.train12306 || 'https://www.12306.cn/index/',
        flight: config.priceCheck?.flight || ''
      }
    },
    warnings: [
      '这是演示数据：酒店名称取自常见连锁品牌，坐标是围绕厂家合成的，用于展示查询结果的样子。',
      '高德 key 配好后，同样的界面会显示真实酒店、真实距离和高德返回的人均价格。'
    ],
    fetchedAt: new Date().toISOString()
  };

  const out = path.join(ROOT, 'data', 'demo-plan.json');
  await fs.mkdir(path.dirname(out), { recursive: true });
  await fs.writeFile(out, `${JSON.stringify(plan, null, 2)}\n`, 'utf8');
  return { plan, out };
}

/* ============ 3. 主流程 ============ */
async function main() {
  let config = {};
  for (const name of ['config.json', 'config.example.json']) {
    try {
      config = JSON.parse((await fs.readFile(path.join(ROOT, name), 'utf8')).replace(/^\uFEFF/, ''));
      break;
    } catch {
      /* 试下一个 */
    }
  }

  await runAssertions(config);
  await testPlanPipeline(config);

  const { plan, out } = await buildDemo(config);
  console.log(`✓ 演示数据已生成：${path.relative(ROOT, out)}`);
  const inBudget = plan.hotels.filter((h) => h.inBudget).length;
  const preferred = plan.hotels.filter((h) => h.brand?.tier === 1).length;
  const nearest = plan.hotels.find((h) => h.brand?.tier === 1) || plan.hotels[0];
  console.log(`  范围内 ${plan.hotels.length} 家（含旅馆/民宿 2 家），预算内 ${inBudget} 家，常住品牌 ${preferred} 家`);
  console.log(`  最近常住品牌：${nearest?.name} ${nearest?.distance} m`);

  // 简单校验 demo 结构完整
  assert.ok(plan.hotels.length >= 18, '演示酒店数量偏少');
  assert.ok(plan.hotels.some((h) => h.inBudget), '演示数据里没有预算内酒店');
  assert.ok(plan.hotels.every((h) => Number.isFinite(h.lng) && Number.isFinite(h.lat)), '演示酒店坐标缺失');
  console.log('✓ 演示数据结构校验通过');
}

main().catch((e) => {
  console.error('✗ 自检失败:', e.message);
  process.exit(1);
});
