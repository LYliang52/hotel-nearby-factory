/**
 * 主流程编排：定位厂家 -> 圈周边酒店 -> 打标签/打分 -> 算交通方案
 */
import { haversine } from './amap.mjs';
import { buildHotelList, createBrandMatcher } from './hotels.mjs';
import { buildPriceLinks, lookupCtripCityId } from './ctrip.mjs';

export class PlanError extends Error {
  constructor(message, { code = 'PLAN_FAILED', hint = '' } = {}) {
    super(message);
    this.name = 'PlanError';
    this.code = code;
    this.hint = hint;
  }
}

const COMPANY_WORD = /(厂|工厂|公司|有限|集团|股份|科技|工业|产业园|基地|车间|园区|中心|研究院|研究所|仓库|物流)/;

const norm = (s) =>
  String(s || '')
    .toLowerCase()
    .replace(/[（）()【】\[\]·\-—_,，。.\s]/g, '');

function bigrams(s) {
  const out = new Set();
  for (let i = 0; i < s.length - 1; i += 1) out.add(s.slice(i, i + 2));
  if (s.length === 1) out.add(s);
  return out;
}

/** 用名称相关度给厂家候选排序，避免"苏州工厂"这种输入把无关 POI 排第一 */
function relevance(poi, query) {
  const q = norm(query);
  const n = norm(poi.name);
  if (!q || !n) return 0;
  let score = 0;
  if (n === q) score += 120;
  else if (n.includes(q)) score += 90;
  else if (q.includes(n)) score += 60;
  else {
    const qb = bigrams(q);
    const nb = bigrams(n);
    let hit = 0;
    for (const b of qb) if (nb.has(b)) hit += 1;
    score += qb.size ? Math.round((hit / qb.size) * 55) : 0;
  }
  if (COMPANY_WORD.test(poi.name)) score += 18;
  if (String(poi.typecode || '').startsWith('17')) score += 12; // 公司企业
  if (String(poi.typecode || '').startsWith('12')) score += 6; // 商务住宅
  return score;
}

function clamp(n, min, max) {
  const v = Number(n);
  if (!Number.isFinite(v)) return min;
  return Math.min(max, Math.max(min, v));
}

function toNum(v, fallback = null) {
  if (v === '' || v === null || v === undefined) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * 在半径圆内生成采样点（中心 + 内外两环）。
 * 高德周边搜索按距离排序，单点搜索会「近的挤在一起、远处取不到」，
 * 放大半径后远处依旧空白。用多个采样点覆盖整个圆，合并去重后结果才均匀分布。
 * 半径 < 2km 用中心 1 点；否则中心 + 内环(R/3 处 6 点) + 外环(2R/3 处 6 点)。
 */
function buildSamplePoints(center, radiusMeters) {
  const pts = [{ lng: center.lng, lat: center.lat }];
  if (radiusMeters < 2000) return pts;
  const latPerMeter = 1 / 111320;
  const lngPerMeter = 1 / (111320 * Math.max(0.0001, Math.cos((center.lat * Math.PI) / 180)));
  const rings = [
    { r: 1 / 3, n: 6, start: 0 },
    { r: 2 / 3, n: 6, start: Math.PI / 6 }
  ];
  for (const ring of rings) {
    for (let k = 0; k < ring.n; k += 1) {
      const ang = ring.start + (k / ring.n) * 2 * Math.PI;
      const d = radiusMeters * ring.r;
      pts.push({
        lng: center.lng + d * Math.cos(ang) * lngPerMeter,
        lat: center.lat + d * Math.sin(ang) * latPerMeter
      });
    }
  }
  return pts;
}

/**
 * @param {object} opts
 * @param {ReturnType<import('./amap.mjs').createAmapClient>} opts.amap
 * @param {object} opts.config
 * @param {object} opts.params  { city, from, factory, factoryLng, factoryLat, radiusKm, priceMin, priceMax, includeNonHotel, requirePrice, maxPages }
 * @param {ReturnType<import('./store.mjs').createStore>} opts.store
 * @param {object} opts.ctripCityMap
 */
export async function buildPlan({ amap, config, params, store, ctripCityMap = {} }) {
  const defaults = config.defaults || {};
  const warnings = [];

  const radiusKm = clamp(toNum(params.radiusKm, defaults.radiusKm ?? 10), 0.5, 50);
  const radiusMeters = Math.round(radiusKm * 1000);
  const priceMin = clamp(toNum(params.priceMin, defaults.priceMin ?? 300), 0, 20000);
  const priceMax = clamp(toNum(params.priceMax, defaults.priceMax ?? 600), priceMin, 20000);
  const cityInput = String(params.city || defaults.city || '').trim();
  const fromInput = String(params.from || defaults.from || '').trim();
  const factoryInput = String(params.factory || '').trim();

  /* ---------- 1. 定位目的地厂家 ---------- */
  let factory = null;
  let candidates = [];

  const inputLng = toNum(params.factoryLng);
  const inputLat = toNum(params.factoryLat);

  if (inputLng !== null && inputLat !== null) {
    // 用户直接点了地图/选了候选，坐标已给定
    let label = String(params.factoryName || factoryInput || '目的地厂家');
    let geo = null;
    try {
      geo = await amap.regeo({ location: `${inputLng},${inputLat}` });
      if (geo?.formatted && label === (factoryInput || '目的地厂家')) label = geo.formatted;
    } catch (e) {
      warnings.push(`逆地理编码失败（不影响搜索）：${e.message}`);
    }
    factory = {
      id: String(params.factoryId || ''),
      name: label,
      address: geo?.formatted || '',
      lng: inputLng,
      lat: inputLat,
      city: geo?.city || cityInput,
      district: geo?.district || '',
      citycode: geo?.citycode || ''
    };
  } else {
    if (!factoryInput) {
      throw new PlanError('请先填写目的地厂家名称', {
        code: 'MISSING_FACTORY',
        hint: '例如「博世汽车部件（苏州）有限公司」或「苏州工业园区星湖街218号」'
      });
    }
    let pois = [];
    try {
      pois = await amap.textSearch({ keywords: factoryInput, city: cityInput, citylimit: Boolean(cityInput) });
    } catch (e) {
      throw new PlanError(`厂家定位失败：${e.message}`, { code: 'LOCATE_FAILED', hint: e.info || '' });
    }
    if (!pois.length && cityInput) {
      // 城市限定的关键字搜索有时过窄，放宽再试一次
      try {
        pois = await amap.textSearch({ keywords: factoryInput, city: cityInput, citylimit: false });
      } catch (e) {
        warnings.push(`放宽城市限制重搜失败：${e.message}`);
      }
    }
    if (!pois.length) {
      throw new PlanError(`没找到「${factoryInput}」这个地点`, {
        code: 'FACTORY_NOT_FOUND',
        hint: '换个更完整的写法试试：加上城市名，或改用详细地址；也可以直接在「高级」里手填经纬度。'
      });
    }

    const ranked = pois
      .map((p) => ({ ...p, relevance: relevance(p, factoryInput) }))
      .sort((a, b) => b.relevance - a.relevance);

    factory = ranked[0];
    candidates = ranked.slice(0, 8).map((p) => ({
      id: p.id,
      name: p.name,
      address: p.address,
      cityname: p.cityname,
      lng: p.lng,
      lat: p.lat,
      relevance: p.relevance
    }));
    if (ranked.length > 1 && ranked[1].relevance >= ranked[0].relevance - 5) {
      warnings.push(`「${factoryInput}」匹配到多个地点，当前用的是「${factory.name}」，可按名单切换。`);
    }
  }

  const city = factory.city || factory.cityname || cityInput;

  /* ---------- 2. 圈周边酒店（多中心采样，覆盖整个圆，避免结果都挤在中心） ---------- */
  let pois = [];
  let reportedCount = 0;
  try {
    const seen = new Set();
    const samplePoints = buildSamplePoints({ lng: factory.lng, lat: factory.lat }, radiusMeters);
    // 两轮搜索：
    //   1) types=100100（酒店，含星级/经济型/公寓式）—— 先单独搜一遍，确保常住品牌/连锁酒店
    //      不被海量民宿/旅馆挤掉（用 100000 混着搜，前 N 条几乎全是民宿，正经酒店进不来）；
    //   2) types=100000（住宿服务大类）—— 再搜一遍补齐民宿/公寓，让结果更密集。
    for (const types of ['100100', '100000']) {
      for (const pt of samplePoints) {
        const around = await amap.aroundSearch({
          location: pt,
          radius: Math.round(radiusMeters * 0.5), // 覆盖每个采样点负责的区域
          types,
          maxPages: 1
        });
        reportedCount = Math.max(reportedCount, around.reportedCount);
        for (const h of around.hotels) {
          if (seen.has(h.id)) continue;
          seen.add(h.id);
          // 高德返回的 distance 是相对采样点的，这里统一重算为相对厂家中心的直线距离
          h.distance = haversine({ lng: factory.lng, lat: factory.lat }, { lng: h.lng, lat: h.lat });
          if (h.distance > radiusMeters) continue; // 采样点可能搜到圆外，过滤掉
          pois.push(h);
        }
      }
    }
  } catch (e) {
    throw new PlanError(`周边酒店搜索失败：${e.message}`, { code: 'AROUND_FAILED', hint: e.info || '' });
  }

  if (reportedCount > pois.length) {
    warnings.push(
      `该范围内高德共有约 ${reportedCount} 家住宿，本次取回 ${pois.length} 家（按距离均匀分布）。`
    );
  }

  /* ---------- 3. 打标签 + 打分 ---------- */
  const matchBrand = createBrandMatcher(config.brands || []);
  const manualPrices = await store.loadPrices();
  const hotels = buildHotelList({
    pois,
    center: { lng: factory.lng, lat: factory.lat },
    radiusMeters,
    priceMin,
    priceMax,
    matchBrand,
    manualPrices,
    // 全量返回并打 isProper 标记，由前端「含旅馆·民宿」开关做筛选，
    // 这样切开关不需要再消耗一次高德额度。
    includeNonHotel: true,
    requirePrice: false,
    haversine
  });

  const ctripCityId = lookupCtripCityId(ctripCityMap, city);
  if (!ctripCityId) {
    warnings.push('没有该城市的携程 cityId 缓存，核价链接会退化成长尾搜索页。跑一次 npm run citymap 可补齐。');
  }

  const hotelsOut = hotels.map((h) => ({
    ...h,
    links: buildPriceLinks({
      templates: config.priceCheck || {},
      hotel: h,
      city,
      ctripCityId
    })
  }));

  /* ---------- 4. 怎么去 ---------- */
  let travel = null;
  if (fromInput) {
    travel = { from: fromInput, to: city || factory.city, driving: [], transit: [], notes: [] };
    let fromPoint = null;
    try {
      const geos = await amap.geocode({ address: fromInput });
      if (geos.length) fromPoint = geos[0];
    } catch (e) {
      travel.notes.push(`出发地解析失败：${e.message}`);
    }

    if (fromPoint) {
      travel.fromPoint = {
        name: fromPoint.formatted || fromInput,
        city: fromPoint.city || fromInput,
        lng: fromPoint.lng,
        lat: fromPoint.lat
      };
      const straightKm = Math.round(haversine(fromPoint, { lng: factory.lng, lat: factory.lat }) / 1000);
      travel.straightKm = straightKm;

      // 驾车
      try {
        travel.driving = await amap.driving({ origin: fromPoint, destination: { lng: factory.lng, lat: factory.lat } });
      } catch (e) {
        travel.notes.push(`驾车方案获取失败：${e.message}`);
      }

      // 跨城综合交通（火车/城际 + 市内接驳）
      // v5 这个接口要的是 citycode（021 / 0512），传城市名会 INVALID_PARAMS
      const city1 = fromPoint.citycode || fromPoint.adcode || fromPoint.city || fromInput;
      const city2 = factory.citycode || factory.adcode || city || inputCityFallback(factory);
      try {
        travel.transit = await amap.transitIntegrated({
          origin: fromPoint,
          destination: { lng: factory.lng, lat: factory.lat },
          city1,
          city2: city2 || city1
        });
      } catch (e) {
        travel.notes.push(`火车/公交方案获取失败：${e.message}`);
      }

      const bestDriveKm = travel.driving.length ? Math.min(...travel.driving.map((d) => d.distance)) / 1000 : null;
      if (bestDriveKm !== null && bestDriveKm > 800) {
        travel.notes.push(`驾车单程约 ${Math.round(bestDriveKm)} km，建议改高铁/飞机。`);
      }
    }
    travel.links = {
      train: config.priceCheck?.train12306 || 'https://www.12306.cn/index/',
      flight: config.priceCheck?.flight || ''
    };
  }

  return {
    ok: true,
    query: {
      city,
      factory: factoryInput,
      from: fromInput,
      radiusKm,
      priceMin,
      priceMax
    },
    factory: {
      id: factory.id,
      name: factory.name,
      address: factory.address || factory.formatted || '',
      lng: factory.lng,
      lat: factory.lat,
      city,
      // 高德 POI 用 adname 表示区县，逆地理用 district
      district: factory.district || factory.adname || '',
      typecode: factory.typecode || ''
    },
    candidates,
    hotels: hotelsOut,
    travel,
    warnings,
    fetchedAt: new Date().toISOString()
  };
}

function inputCityFallback(factory) {
  return factory.cityname || factory.city || factory.pname || '';
}
