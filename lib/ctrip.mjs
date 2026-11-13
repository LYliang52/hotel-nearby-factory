/**
 * 携程城市 id 映射 + 各平台核价链接生成
 *
 * 携程酒店列表必须带 city=<数字 id> 才会真正按城市搜索，否则只是落地页。
 * 这个 id 是高德 citycode 之外的独立体系，无法直接换算，
 * 所以由 scripts/build-ctrip-citymap.mjs 实测抓一份映射落到 data/ctrip-city-map.json，
 * 查不到时前端会退化成"关键词搜索"链接。
 */
import fs from 'node:fs/promises';
import path from 'node:path';

const CITY_ALIASES = [
  // 显示名/常见简称 -> 用于匹配的规范名
  ['北京市', '北京'],
  ['上海市', '上海'],
  ['天津市', '天津'],
  ['重庆市', '重庆']
];

function normalizeCityName(name) {
  let n = String(name || '').trim();
  for (const [full, short] of CITY_ALIASES) {
    if (n === full) return short;
  }
  return n.replace(/市$/, '');
}

export async function loadCtripCityMap(dataDir) {
  const file = path.join(dataDir, 'ctrip-city-map.json');
  try {
    const raw = await fs.readFile(file, 'utf8');
    const parsed = JSON.parse(raw.replace(/^\uFEFF/, ''));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export function lookupCtripCityId(cityMap, cityName) {
  const key = normalizeCityName(cityName);
  if (!key) return null;
  const usable = (name) => name && !name.includes('_del');
  const hit = cityMap[key];
  if (usable(key) && Number.isFinite(hit)) return hit;
  if (usable(key) && hit && Number.isFinite(hit.id)) return hit.id;
  // 退化：允许"苏州工业园区"这类带后缀的输入命中"苏州"
  const entries = Object.keys(cityMap)
    .filter(usable)
    .sort((a, b) => b.length - a.length);
  for (const name of entries) {
    if (name.length >= 2 && key.includes(name)) {
      const v = cityMap[name];
      return Number.isFinite(v) ? v : v?.id ?? null;
    }
  }
  return null;
}

function fillTemplate(template, vars) {
  return String(template || '').replace(/\{(\w+)\}/g, (_, k) => encodeURIComponent(vars[k] ?? ''));
}

/** 生成"去核价"链接集合 */
export function buildPriceLinks({ templates, hotel, city, ctripCityId }) {
  const vars = {
    name: hotel.name,
    city: normalizeCityName(city),
    query: `${normalizeCityName(city)}${hotel.name}`,
    id: hotel.id,
    ctripCityId: ctripCityId ?? ''
  };
  const out = {
    // 高德 POI 详情页：一定打得开，含电话、图片、点评，可以直接打电话问房价
    amapPoi: hotel.id ? fillTemplate(templates.amapPoi, vars) : null,
    ctrip: null,
    ctripFallback: fillTemplate(templates.ctripNoCity, vars)
  };
  if (ctripCityId) out.ctrip = fillTemplate(templates.ctrip, vars);
  return out;
}

export { normalizeCityName };
