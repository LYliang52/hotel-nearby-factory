/**
 * 本地数据持久化：人工补录的房价、以及可选的接口缓存
 * 刻意用文件而不是数据库 —— 单机小工具，能直接打开看、能手工改。
 */
import fs from 'node:fs/promises';
import path from 'node:path';

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

async function readJson(file, fallback) {
  try {
    const raw = await fs.readFile(file, 'utf8');
    const trimmed = raw.replace(/^\uFEFF/, '').trim();
    if (!trimmed) return fallback;
    return JSON.parse(trimmed);
  } catch {
    return fallback;
  }
}

async function writeJsonAtomic(file, value) {
  await ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await fs.rename(tmp, file);
}

export function createStore(dataDir) {
  const pricesFile = path.join(dataDir, 'prices.json');
  let cache = null;

  async function loadPrices() {
    if (cache) return cache;
    const raw = await readJson(pricesFile, {});
    cache = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    return cache;
  }

  /** 记录/更新一家酒店的实际房价 */
  async function setPrice(poiId, { price, note = '', source = '携程', name = '' }) {
    if (!poiId) {
      const err = new Error('缺少酒店 id');
      err.statusCode = 400;
      throw err;
    }
    const num = Number(price);
    if (!Number.isFinite(num) || num <= 0 || num > 100000) {
      const err = new Error('价格必须是一个正数（元/晚）');
      err.statusCode = 400;
      throw err;
    }
    const prices = await loadPrices();
    prices[poiId] = {
      price: Math.round(num),
      note: String(note || '').slice(0, 200),
      source: String(source || '携程').slice(0, 40),
      name: String(name || '').slice(0, 120),
      updatedAt: new Date().toISOString()
    };
    await writeJsonAtomic(pricesFile, prices);
    return prices[poiId];
  }

  async function removePrice(poiId) {
    const prices = await loadPrices();
    if (!prices[poiId]) return false;
    delete prices[poiId];
    await writeJsonAtomic(pricesFile, prices);
    return true;
  }

  return { loadPrices, setPrice, removePrice, pricesFile };
}
