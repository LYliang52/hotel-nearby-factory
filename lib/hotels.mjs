/**
 * 酒店侧逻辑：品牌识别、价格核算、距离分级、综合打分、筛选
 */

/** 视作"不是商务连锁酒店"的类型码前缀（旅馆招待所 1002xx / 青年旅舍等） */
const LOW_QUALITY_TYPECODE_PREFIXES = ['1002'];
// 除了民宿公寓这类，还要排掉高德 POI 里的「XX酒店大堂 / 停车场 / XX酒店有限公司」这些附属点
const LOW_QUALITY_NAME_PATTERN =
  /民宿|公寓|农家|招待所|青年旅舍|青旅|客栈|日租|短租|洗浴|会所|KTV|别墅|自习室|大堂|停车场|前台|会议室|宴会厅|有限公司/i;
/** typecode 100000（住宿服务相关）这类模糊分类，只能靠名字猜是不是正经酒店 */
const HOTEL_LIKE_NAME = /酒店|宾馆|饭店|度假|hotel|inn/i;

/** 从高德 typecode 里读星级，作为"没有价格时的价位参考" */
const STAR_BY_TYPECODE = {
  '100101': '五星级',
  '100102': '四星级',
  '100103': '三星级',
  '100104': '经济型',
  '100105': '公寓式酒店',
  '100100': '酒店',
  '100000': '住宿'
};

export function starLabel(typecode) {
  const code = String(typecode || '');
  // typecode 可能是 "141400|100000" 这种复合值
  for (const part of code.split('|')) {
    if (STAR_BY_TYPECODE[part]) return STAR_BY_TYPECODE[part];
  }
  const m = code.match(/1001(0[1-5])/);
  return m ? STAR_BY_TYPECODE[`1001${m[1]}`] || '' : '';
}

/** 品牌识别器：长关键词优先，避免"桔子"抢走"桔子水晶" */
export function createBrandMatcher(brandConfig = []) {
  const flat = [];
  for (const group of brandConfig) {
    for (const kw of group.keywords || []) {
      const needle = String(kw).toLowerCase().trim();
      if (!needle) continue;
      flat.push({ needle, group: group.group, tier: Number(group.tier) || 3 });
    }
  }
  flat.sort((a, b) => b.needle.length - a.needle.length);

  return function matchBrand(name) {
    const n = String(name || '').toLowerCase();
    if (!n) return null;
    for (const item of flat) {
      if (n.includes(item.needle)) {
        return { group: item.group, tier: item.tier, matched: item.needle };
      }
    }
    return null;
  };
}

/** 距离分级，用于地图配色 */
function distanceBand(meters, radiusMeters) {
  if (!Number.isFinite(meters)) return 'unknown';
  const ratio = radiusMeters > 0 ? meters / radiusMeters : 1;
  if (ratio <= 0.2) return 'r1';
  if (ratio <= 0.4) return 'r2';
  if (ratio <= 0.6) return 'r3';
  if (ratio <= 0.8) return 'r4';
  return 'r5';
}

/**
 * 综合打分（满分 100）
 *   距离 40 分：越近越高
 *   品牌 35 分：tier1=35 / tier2=22 / tier3=10 / 非连锁=0
 *   价格 20 分：落在区间内满分，超区间递减
 *   口碑  5 分：高德评分/5*5
 */
export function scoreHotel(hotel, { radiusMeters, priceMin, priceMax }) {
  const d = Number.isFinite(hotel.distance) ? hotel.distance : radiusMeters;
  const distScore = 40 * Math.max(0, 1 - Math.min(d, radiusMeters) / Math.max(radiusMeters, 1));

  let brandScore = 0;
  if (hotel.brand) {
    brandScore = hotel.brand.tier === 1 ? 35 : hotel.brand.tier === 2 ? 22 : 10;
  }

  let priceScore = 8; // 价格未知给中性偏低分
  if (Number.isFinite(hotel.price)) {
    if (hotel.price >= priceMin && hotel.price <= priceMax) priceScore = 20;
    else if (hotel.price < priceMin) priceScore = 14;
    else {
      const over = (hotel.price - priceMax) / Math.max(priceMax, 1);
      priceScore = over <= 0.2 ? 12 : over <= 0.5 ? 6 : 2;
    }
  }

  const ratingScore = Number.isFinite(hotel.rating) ? (hotel.rating / 5) * 5 : 0;

  return {
    total: Math.round((distScore + brandScore + priceScore + ratingScore) * 10) / 10,
    distScore: Math.round(distScore * 10) / 10,
    brandScore,
    priceScore,
    ratingScore: Math.round(ratingScore * 10) / 10
  };
}

/**
 * 是否像一间正经商务酒店（前端「含旅馆·民宿」开关会用它过滤）
 * 判据：typecode 分类 + 名字兜底，因为高德对不少 POI 只给一个模糊的 100000
 */
export function isProperHotel(poi) {
  const name = String(poi.name || '');
  const parts = String(poi.typecode || '').split('|');

  if (LOW_QUALITY_NAME_PATTERN.test(name)) return false;
  if (parts.some((c) => LOW_QUALITY_TYPECODE_PREFIXES.some((p) => c.startsWith(p)))) return false;
  // 100100~100105：明确的宾馆酒店分类，含星级 / 经济型 / 公寓式
  if (parts.some((c) => c.startsWith('1001'))) return true;
  // 100000「住宿服务相关」：高德自己也分不清，只能看名字像不像酒店
  if (parts.some((c) => c.startsWith('1000'))) return HOTEL_LIKE_NAME.test(name);
  return false;
}

/**
 * 组装最终酒店列表：打品牌标签、合并人工补录价格、打分、过滤、排序
 */
export function buildHotelList({
  pois,
  center,
  radiusMeters,
  priceMin,
  priceMax,
  matchBrand,
  manualPrices = {},
  includeNonHotel = false,
  requirePrice = false,
  haversine = () => null
}) {
  const rows = [];
  for (const poi of pois) {
    const distance = Number.isFinite(poi.distance) ? poi.distance : haversine(center, { lng: poi.lng, lat: poi.lat });
    if (!Number.isFinite(distance) || distance > radiusMeters) continue;
    const proper = isProperHotel(poi);
    if (!includeNonHotel && !proper) continue;

    const manual = manualPrices[poi.id];
    const price = manual && Number.isFinite(Number(manual.price)) ? Number(manual.price) : poi.cost;
    const priceSource = manual ? 'manual' : poi.cost != null ? 'amap' : null;

    const brand = matchBrand(poi.name);
    const row = {
      ...poi,
      distance,
      price,
      priceSource,
      priceNote: manual?.note || '',
      brand,
      isProper: proper,
      star: starLabel(poi.typecode),
      inBudget: Number.isFinite(price) ? price >= priceMin && price <= priceMax : null,
      band: distanceBand(distance, radiusMeters)
    };
    row.score = scoreHotel(row, { radiusMeters, priceMin, priceMax });
    rows.push(row);
  }

  const filtered = requirePrice ? rows.filter((r) => Number.isFinite(r.price)) : rows;
  filtered.sort((a, b) => a.distance - b.distance);
  return filtered;
}
