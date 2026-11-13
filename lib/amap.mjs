/**
 * 高德地图 Web 服务 API 封装（零依赖，只用 Node 内置 fetch）
 *
 * 注意：这里用的是「Web服务」类型 key。
 * 如果你拿 JS API / Android / iOS 的 key 来调，会得到 USERKEY_PLAT_NOMATCH(10009)。
 */

const ENDPOINT = 'https://restapi.amap.com';

/** 高德错误码 -> 人话 + 该怎么办 */
export const AMAP_ERRORS = {
  '10001': 'key 无效或已过期。请到高德控制台重新确认 key。',
  '10003': '当日调用量已超限。个人 key 每日额度很小，等第二天或换 key。',
  '10004': '调用过于频繁（QPS 超限）。已自动降速，请稍等重试。',
  '10005': 'IP 白名单校验未通过。请把本机公网 IP 加到 key 的白名单，或把白名单置空。',
  '10009': 'key 平台类型不匹配。你的 key 不是「Web服务」类型——高德 key 类型创建后不可修改，请新建一个「Web服务」key 后填进 config.json 的 amapKey。',
  '10010': '该 key 未开通此接口权限（例如路径规划需要单独申请）。',
  '10012': '账号权限不足或已受限。',
  '10044': '账号当日调用量达上限。',
  '20000': '请求参数不正确。',
  '20001': '缺少必填参数。',
  '20800': '路径规划失败：两点太远或不可达。',
  '20801': '规划点超出服务范围。',
  '20802': '规划点不在中国境内。',
  '20803': '规划点附近没有可规划的道路。'
};

class AmapError extends Error {
  constructor(info, infocode, endpoint) {
    const hint = AMAP_ERRORS[String(infocode)] || '';
    super(`${info || '高德接口返回失败'}${infocode ? `（infocode=${infocode}）` : ''}${hint ? ` — ${hint}` : ''}`);
    this.name = 'AmapError';
    this.info = info;
    this.infocode = String(infocode || '');
    this.endpoint = endpoint;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 个人 key 并发很低，做串行限速，避免 10004 */
function createThrottle(minGapMs) {
  let tail = Promise.resolve();
  let last = 0;
  return function throttle() {
    const p = tail.then(async () => {
      const wait = minGapMs - (Date.now() - last);
      if (wait > 0) await sleep(wait);
      last = Date.now();
    });
    tail = p.catch(() => {});
    return p;
  };
}

/** 高德对空字段返回 []，对缺失返回 undefined，统一成字符串 */
function str(v) {
  if (v === undefined || v === null) return '';
  if (Array.isArray(v)) return '';
  return String(v).trim();
}

/** biz_ext.cost 可能是 "268.00" / "￥268" / [] */
function parseCost(v) {
  const s = str(v).replace(/[^\d.]/g, '');
  if (!s) return null;
  const n = Number.parseFloat(s);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** amap location 字符串 "120.1,30.2" -> {lng, lat} */
function parseLocation(loc) {
  const s = str(loc);
  const [lng, lat] = s.split(',').map(Number);
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null;
  return { lng, lat };
}

/** 两点球面直线距离（米），高德返回值缺失时兜底 */
export function haversine(a, b) {
  const R = 6371008.8;
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(s)));
}

/** POI 归一化：高德各接口字段形状不完全一致，统一成前端好用的结构 */
function normalizePoi(p) {
  const loc = parseLocation(p.location);
  if (!loc) return null;
  const biz = p.biz_ext && typeof p.biz_ext === 'object' && !Array.isArray(p.biz_ext) ? p.biz_ext : {};
  const photos = Array.isArray(p.photos)
    ? p.photos.map((ph) => str(ph?.url)).filter(Boolean).slice(0, 3)
    : [];
  const rating = Number.parseFloat(str(biz.rating));
  const distance = Number.parseFloat(str(p.distance));
  const cost = parseCost(biz.cost);
  return {
    id: str(p.id),
    name: str(p.name),
    type: str(p.type),
    typecode: str(p.typecode),
    address: str(p.address),
    lng: loc.lng,
    lat: loc.lat,
    distance: Number.isFinite(distance) ? Math.round(distance) : null,
    tel: str(p.tel),
    cityname: str(p.cityname),
    adname: str(p.adname),
    pname: str(p.pname),
    adcode: str(p.adcode),
    citycode: str(p.citycode),
    rating: Number.isFinite(rating) ? rating : null,
    cost,
    costSource: cost ? 'amap' : null,
    businessArea: str(p.business_area),
    photos
  };
}

export function createAmapClient({ key, minRequestGapMs = 350 } = {}) {
  const throttle = createThrottle(Math.max(0, minRequestGapMs));

  async function call(path, params = {}) {
    if (!key) {
      throw new AmapError('config.json 里没有配置 amapKey', '', path);
    }
    const usp = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined || v === null || v === '') continue;
      // 对象参数说明调用方忘了拼成 "lng,lat"，直接塞进去会变成 [object Object]，
      // 高德只会回一个莫名其妙的 INVALID_PARAMS，不如在这里就炸掉
      if (typeof v === 'object') {
        throw new AmapError(`参数 ${k} 是对象，需要先拼成字符串（例如 "120.7,31.3"）`, 'BAD_PARAM', path);
      }
      usp.set(k, String(v));
    }
    usp.set('key', key);

    let lastErr;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await throttle();
      try {
        const res = await fetch(`${ENDPOINT}${path}?${usp}`, {
          headers: { 'user-agent': 'hotel-near-factory/1.0 (+node)' },
          signal: AbortSignal.timeout(20000)
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();
        if (String(json.status) === '1') return json;
        const err = new AmapError(str(json.info), str(json.infocode), path);
        // 频控类错误重试，其它（key 错、参数错）直接抛
        if (err.infocode === '10004' || err.infocode === '10021') {
          lastErr = err;
          await sleep(800 * (attempt + 1));
          continue;
        }
        throw err;
      } catch (e) {
        if (e instanceof AmapError) throw e;
        lastErr = new AmapError(e.message, 'NETWORK', path);
        await sleep(500 * (attempt + 1));
      }
    }
    throw lastErr;
  }

  /** 地址/地名 -> 坐标 */
  async function geocode({ address, city }) {
    const json = await call('/v3/geocode/geo', { address, city });
    const list = Array.isArray(json.geocodes) ? json.geocodes : [];
    return list
      .map((g) => {
        const loc = parseLocation(g.location);
        if (!loc) return null;
        return {
          formatted: str(g.formatted_address),
          level: str(g.level),
          lng: loc.lng,
          lat: loc.lat,
          city: str(g.city),
          province: str(g.province),
          district: str(g.district),
          adcode: str(g.adcode),
          citycode: str(g.citycode)
        };
      })
      .filter(Boolean);
  }

  /** 坐标 -> 地址/城市（用于只给了经纬度时反推城市） */
  async function regeo({ location }) {
    const json = await call('/v3/geocode/regeo', {
      location,
      extensions: 'base'
    });
    const rc = json.regeocode || {};
    const comp = rc.addressComponent || {};
    const city = Array.isArray(comp.city) ? '' : str(comp.city);
    const province = Array.isArray(comp.province) ? '' : str(comp.province);
    return {
      formatted: str(rc.formatted_address),
      city: city || province,
      province,
      district: Array.isArray(comp.district) ? '' : str(comp.district),
      adcode: str(comp.adcode),
      citycode: Array.isArray(comp.citycode) ? '' : str(comp.citycode)
    };
  }

  /** 关键字搜索（定位厂家用），extensions=all 才带评分/人均 */
  async function textSearch({ keywords, city, citylimit = false, page = 1, offset = 25 }) {
    const json = await call('/v3/place/text', {
      keywords,
      city,
      citylimit: citylimit ? 'true' : 'false',
      page,
      offset,
      extensions: 'all',
      sortrule: city ? 'weight' : 'weight'
    });
    const list = Array.isArray(json.pois) ? json.pois : [];
    return list.map(normalizePoi).filter(Boolean);
  }

  /** 周边搜索（酒店），按距离排序，自动翻页 */
  async function aroundSearch({ location, radius, types = '100000', keywords = '', maxPages = 4 }) {
    const out = [];
    const seen = new Set();
    let count = 0;
    // location 允许传 {lng, lat} 或 "lng,lat"；直接丢对象给 URLSearchParams 会变成 [object Object]
    const locStr = typeof location === 'string' ? location : `${location.lng},${location.lat}`;
    for (let page = 1; page <= maxPages; page += 1) {
      const json = await call('/v3/place/around', {
        location: locStr,
        radius,
        types,
        keywords,
        page,
        offset: 25,
        extensions: 'all',
        sortrule: 'distance'
      });
      const list = Array.isArray(json.pois) ? json.pois : [];
      count = Number.parseInt(str(json.count), 10) || count;
      if (!list.length) break;
      for (const raw of list) {
        const poi = normalizePoi(raw);
        if (!poi || seen.has(poi.id)) continue;
        seen.add(poi.id);
        out.push(poi);
      }
      // count 拿到 0（接口未返回）时不能当成"已取完"，否则第一页就退出了
      if (count > 0 && out.length >= count) break;
      // 高德周边搜索单类型最多返回 1000 条，取够页数就停
      if (out.length >= maxPages * 25) break;
    }
    return { hotels: out, reportedCount: count };
  }

  /** 驾车方案 */
  async function driving({ origin, destination }) {
    const json = await call('/v5/direction/driving', {
      origin: `${origin.lng},${origin.lat}`,
      destination: `${destination.lng},${destination.lat}`,
      show_fields: 'cost,navi',
      strategy: 10, // 多备选 / 距离优先
      alternatives: 'base'
    });
    const route = json.route || {};
    const paths = Array.isArray(route.paths) ? route.paths : [];
    return paths.slice(0, 3).map((p) => {
      const cost = p.cost || {};
      return {
        distance: Number.parseInt(str(p.distance), 10) || 0,
        durationMin: Math.round((Number.parseInt(str(cost.duration), 10) || 0) / 60),
        tolls: Number.parseInt(str(cost.tolls), 10) || 0,
        trafficLights: Number.parseInt(str(cost.traffic_lights), 10) || 0,
        strategy: str(p.strategy || '')
      };
    });
  }

  /**
   * 跨城综合交通（火车/城际/地铁/公交的组合方案）
   * 注意：city1 / city2 必须是城市 adcode/citycode（如 021、0512），
   * 传城市名（"上海市"）会直接 INVALID_PARAMS —— 这点和 v3 的 city/cityd 不一样。
   */
  async function transitIntegrated({ origin, destination, city1, city2 }) {
    const json = await call('/v5/direction/transit/integrated', {
      origin: `${origin.lng},${origin.lat}`,
      destination: `${destination.lng},${destination.lat}`,
      city1,
      city2,
      show_fields: 'cost'
    });
    const route = json.route || {};
    const transits = Array.isArray(route.transits) ? route.transits : [];
    return transits.slice(0, 3).map((t) => {
      const cost = t.cost || {};
      const segments = Array.isArray(t.segments) ? t.segments : [];
      const legs = [];
      for (const seg of segments) {
        const walking = seg.walking;
        const bus = seg.bus && (seg.bus.buslines || []);
        const railway = seg.railway;
        if (railway) {
          legs.push({
            mode: 'train',
            name: str(railway.name || railway.trip) || '火车',
            departure: str(railway.departure_stop?.name),
            arrival: str(railway.arrival_stop?.name)
          });
        } else if (Array.isArray(bus) && bus.length) {
          const line = bus[0] || {};
          legs.push({
            mode: 'bus',
            name: str(line.name) || str(seg.bus.buslines?.[0]?.name) || '公交/地铁',
            departure: str(line.departure_stop?.name),
            arrival: str(line.arrival_stop?.name)
          });
        } else if (walking && Number.parseInt(str(walking.distance), 10) > 300) {
          legs.push({ mode: 'walk', name: `步行 ${walking.distance} 米` });
        }
        if (legs.length >= 6) break;
      }
      return {
        distance: Number.parseInt(str(t.distance), 10) || 0,
        durationMin: Math.round((Number.parseInt(str(cost.duration), 10) || 0) / 60),
        cost: Number.parseFloat(str(cost.transit_fee)) || 0,
        legs
      };
    });
  }

  /** key 自检 */
  async function checkKey() {
    try {
      const json = await call('/v3/ip', {});
      return { ok: true, note: 'key 可用（Web服务）', ip: str(json.province) ? `${str(json.province)} ${str(json.city)}` : '' };
    } catch (e) {
      return { ok: false, infocode: e.infocode || '', error: e.message };
    }
  }

  return { call, geocode, regeo, textSearch, aroundSearch, driving, transitIntegrated, checkKey };
}
