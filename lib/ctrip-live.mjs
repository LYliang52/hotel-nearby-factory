/**
 * 携程实时房价。
 *
 * 走的是"在列表页搜索框里真的搜"这条路，不是拼 URL 参数（携程 SSR 不认参数）。
 *
 * 实测走通的完整动作链（少一步都不行）：
 *   1. 找到 placeholder 是「位置/品牌/酒店」的输入框（页面上有两个 #destinationInput，不能按 id 找）
 *   2. 真实键盘输入地址
 *   3. 跳过下拉里那条"你输入的原词回显"，点第一个真实地点
 *   4. 再点一次「搜索」按钮 —— 选中候选只是填词，不点搜索不会筛
 *   5. 往下滚几次把懒加载的卡片拉出来
 *
 * 实测：苏州星湖街 218 号 → 40 家目标酒店能匹配上 21 家（53%），抓到 98 家带价，耗时约 48 秒。
 */
import path from 'node:path';
import { launchBrowser, serialize, sleep } from './cdp.mjs';

const CTrip_LIST = 'https://hotels.ctrip.com/hotels/list';
const LOGIN_COOKIES = ['cticket', 'cticket_cn', '_ctTicket'];

export function defaultDates() {
  // 用本地时间算，别用 toISOString（那是 UTC，会比北京时间早一天）
  const fmt = (d) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return {
    checkin: fmt(new Date(Date.now() + 86400000)),
    checkout: fmt(new Date(Date.now() + 2 * 86400000))
  };
}

export function profileDir(rootDir) {
  return path.join(rootDir, 'data', 'chrome-profile');
}

/** 登录态是否就绪（Chrome 96 起 Cookies 在 Default/Network/Cookies） */
export async function isProfileReady(dir) {
  const fs = await import('node:fs/promises');
  for (const rel of ['Default/Network/Cookies', 'Default/Cookies', 'Cookies']) {
    try {
      const st = await fs.stat(path.join(dir, rel));
      if (st.size > 0) return true;
    } catch {
      /* 试下一个 */
    }
  }
  return false;
}

/** 从页面提酒店名 + 价格。结构见文件头注释里那条 xpath 说明 */
const EXTRACT_SCRIPT = `(() => {
  const clean = (s) => String(s || '')
    .replace(/\\s*(已订完|满房|暂无|售罄|促销|广告)\\s*$/g, '')
    .replace(/^广告\\s*/g, '')
    .trim();
  const pickPrice = (card) => {
    const line = card.querySelector('.price-line');
    if (!line) return null;
    const nums = [...line.querySelectorAll('*')]
      .filter((el) => el.children.length === 0)
      .map((el) => ({ cls: String(el.className || ''), text: (el.textContent || '').trim() }))
      .filter((x) => /^[¥￥]\\s?\\d{2,5}$/.test(x.text) && !/delete|del|origin|through/i.test(x.cls));
    if (!nums.length) return null;
    const n = Number(nums[nums.length - 1].text.replace(/[^\\d]/g, ''));
    return n >= 30 && n <= 20000 ? n : null;
  };
  // 「起价」对应的是哪个房型 —— 这个必须抓出来，
  // 否则用户会以为 ¥222 就是他想要的房间，实际那是「经济单人房」且仅剩 3 间
  const pickRoom = (card) => {
    const lines = (card.innerText || '').split('\\n').map((s) => s.trim()).filter(Boolean);
    for (const l of lines) {
      if (l.length > 22) continue;
      // 引号开头的是住客点评，不是房型（"房间设施设备齐全，体验感不错"）
      if (/^["“”'「]/.test(l)) continue;
      // 营销语 / 状态标签 / 设施描述
      if (/体验感|设施|服务很|环境不错|安静的房间|免费取消|查看|仅剩|热卖|优惠|早餐|取消|地图|点评|广告|推荐|位置好|交通便利|干净|方便/.test(l)) continue;
      if (/(房|套房|标间|单人间|双人房|大床|双床|床位)/.test(l)) return l;
    }
    return '';
  };
  const items = [];
  for (const card of document.querySelectorAll('.right-card')) {
    const lines = (card.innerText || '').split('\\n').map((s) => s.trim()).filter(Boolean);
    const name = clean(lines[0]);
    if (!name || name.length < 3 || name.length > 60) continue;
    const price = pickPrice(card);
    if (price) items.push({ name, price, room: pickRoom(card) });
  }
  const txt = document.body ? document.body.innerText : '';
  return JSON.stringify({
    items,
    totalLine: (txt.match(/找到[\\d,]+家酒店/) || [''])[0],
    needLogin: (txt.match(/登录以查看/g) || []).length
  });
})()`;

/** 名字相似度：括号里的门店名保留参与比较，太长的说明混了地名 */
function normName(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[（(【\[]/g, ' ')
    .replace(/[）)】\]]/g, ' ')
    .replace(/[\s·・\-—_.,，。:：'"“”]/g, '');
}
function bigrams(s) {
  const set = new Set();
  for (let i = 0; i < s.length - 1; i += 1) set.add(s.slice(i, i + 2));
  if (s.length === 1) set.add(s);
  return set;
}
export function nameSimilarity(a, b) {
  const x = normName(a);
  const y = normName(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  const bx = bigrams(x);
  const by = bigrams(y);
  let hit = 0;
  for (const g of bx) if (by.has(g)) hit += 1;
  if (!hit) return 0;
  const maxN = Math.max(bx.size, by.size);
  const minN = Math.min(bx.size, by.size);
  return Math.min(1, (hit / maxN) * 0.6 + (hit / minN) * (minN / maxN) * 0.4);
}

/** 取「酒店/宾馆…」之前那截当品牌标识，太长说明混了地名，返回 null */
function brandPrefix(name) {
  const n = normName(name);
  const m = n.match(/^(.*?)(酒店|宾馆|公寓|客栈|饭店|旅馆)/);
  if (!m) return null;
  const p = m[1];
  return p.length >= 1 && p.length <= 6 ? p : null;
}

export function matchPrices(hotels, items, { minScore = 0.82 } = {}) {
  const used = new Set();
  const result = [];
  for (const hotel of hotels) {
    const hotelBrand = brandPrefix(hotel.name);
    let best = null;
    for (const item of items) {
      if (used.has(item.name)) continue;
      let score = nameSimilarity(hotel.name, item.name);

      // 品牌词不同（悦宿美居 vs 汉庭、桔子 vs 悦朵）直接压掉。
      // 贪心匹配时这一步很关键：真正那家不在携程列表里时，它就会抓个次相似的凑数。
      const itemBrand = brandPrefix(item.name);
      if (hotelBrand && itemBrand && hotelBrand !== itemBrand) score *= 0.2;

      if (!best || score > best.score) best = { item, score };
    }
    if (best && best.score >= minScore) {
      used.add(best.item.name);
      result.push({
        id: hotel.id,
        name: hotel.name,
        matchedName: best.item.name,
        price: best.item.price,
        room: best.item.room || '',
        score: Math.round(best.score * 100) / 100
      });
    }
  }
  return result;
}

/* ---------------- 缓存：同一片区域 10 分钟内不重复查 ---------------- */
const CACHE_TTL_MS = 10 * 60 * 1000;
const cache = new Map();

function cacheKey(cityId, address, checkin, checkout) {
  // 日期必须进 key：同一家酒店不同日期价格差很多，不能复用
  return `${cityId}|${String(address).trim().toLowerCase()}|${checkin}|${checkout}`;
}

export function clearCache() {
  cache.clear();
}

/**
 * 查携程实时房价
 * @param {object} opts
 * @param {string} opts.profileDir 登录态目录
 * @param {number} opts.cityId     携程城市 id
 * @param {string} opts.address    搜索用的地址 / 商圈名
 * @param {string} opts.checkin
 * @param {string} opts.checkout
 * @param {Array}  opts.hotels     高德酒店（用来匹配）
 * @param {number} opts.scrolls    滚动次数（每次约 2.5 秒，拉的卡片越多覆盖越好）
 */
export function fetchLivePrices(opts) {
  // 串行：同时开两个 Chrome 会互相锁 profile
  return serialize(() => doFetch(opts));
}

async function doFetch({ profileDir: dir, cityId, address, checkin, checkout, hotels, scrolls = 8 }) {
  const key = cacheKey(cityId, address, checkin, checkout);

  const cached = cache.get(key);
  const now = Date.now();
  if (cached && now - cached.at < CACHE_TTL_MS) {
    const matched = matchPrices(hotels, cached.items);
    return {
      cached: true,
      address,
      checkin: cached.checkin,
      checkout: cached.checkout,
      scraped: cached.items.length,
      matched,
      elapsedMs: 0,
      cacheAgeMs: now - cached.at
    };
  }

  const session = await launchBrowser({ userDataDir: dir, headless: true });
  const { cdp } = session;
  const started = Date.now();

  try {
    // 登录态检查
    const cookies = await cdp.cookies(['https://hotels.ctrip.com', 'https://www.ctrip.com']);
    const names = cookies.map((c) => c.name);
    if (!LOGIN_COOKIES.some((n) => names.includes(n))) {
      const err = new Error('携程登录态失效，需要重新登录');
      err.code = 'CTRIP_NOT_LOGGED_IN';
      throw err;
    }

    const listUrl = `${CTrip_LIST}?city=${cityId}&checkin=${checkin}&checkout=${checkout}`;
    await cdp.goto(listUrl);
    await sleep(11000);

    // 1. 按 placeholder 找输入框（页面上有两个 #destinationInput）
    const inputs = JSON.parse(
      await cdp.eval(`JSON.stringify(
        [...document.querySelectorAll('input')]
          .map((el, i) => {
            const r = el.getBoundingClientRect();
            return { i, id: el.id, ph: el.placeholder, type: el.type, w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.x), y: Math.round(r.y) };
          })
          .filter((x) => x.type === 'text' && x.w > 80 && x.h > 10)
      )`)
    );
    const input = inputs.find((x) => /位置|品牌/.test(x.ph || ''));
    if (!input) throw new Error('没找到携程列表页的搜索框（页面结构可能变了）');

    // 2. 点进输入框 + 真实输入
    await cdp.click(input.x + input.w / 2, input.y + input.h / 2);
    await sleep(600);
    await cdp.type(address);
    await sleep(3000);

    // 3. 选第一个"真实地点"候选（跳过回显输入词的那条）
    const pickRaw = await cdp.eval(`(() => {
      const kw = ${JSON.stringify(String(address))};
      const cands = [...document.querySelectorAll('li, div')].filter((n) => {
        const r = n.getBoundingClientRect();
        if (r.width < 120 || r.height < 18 || r.height > 80 || r.top < 0) return false;
        const t = (n.innerText || '').trim();
        return t && t.length > 3 && t.length < 45 && /酒店|宾馆|路|街|号|广场|园区|区/.test(t);
      });
      const real = cands.filter((el) => (el.innerText || '').trim().split('\\n')[0] !== kw);
      const el = real[0] || cands[0];
      if (!el) return 'none';
      const r = el.getBoundingClientRect();
      return JSON.stringify({ text: (el.innerText || '').trim().split('\\n')[0], x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) });
    })()`);
    if (pickRaw === 'none') throw new Error(`搜「${address}」没出候选，换个更具体的地址试试`);
    const pick = JSON.parse(pickRaw);
    await cdp.click(pick.x, pick.y);
    await sleep(1500);

    // 4. 点「搜索」才真正筛选（选中候选只是把词填进框）
    const btnRaw = await cdp.eval(`(() => {
      const cands = [...document.querySelectorAll('button, [role="button"], div, span, a')].filter((el) => {
        const t = (el.innerText || '').trim();
        const r = el.getBoundingClientRect();
        return t === '搜索' && r.width > 40 && r.width < 220 && r.height > 20 && r.height < 70 && r.top > 0;
      });
      if (!cands.length) return 'none';
      const r = cands[0].getBoundingClientRect();
      return JSON.stringify({ x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) });
    })()`);
    if (btnRaw === 'none') {
      await cdp.pressEnter();
    } else {
      const btn = JSON.parse(btnRaw);
      await cdp.click(btn.x, btn.y);
    }
    await sleep(10000);

    // 5. 滚动把懒加载的卡片拉出来
    for (let i = 0; i < scrolls; i += 1) {
      await cdp.eval('window.scrollBy(0, document.body.scrollHeight)');
      await sleep(2500);
    }

    const parsed = JSON.parse((await cdp.eval(EXTRACT_SCRIPT)) || '{}');
    const items = parsed.items || [];

    if (!items.length && parsed.needLogin > 0) {
      const err = new Error('携程登录态失效，需要重新登录');
      err.code = 'CTRIP_NOT_LOGGED_IN';
      throw err;
    }

    cache.set(key, { at: Date.now(), items, checkin, checkout });

    return {
      cached: false,
      address,
      pickedSuggestion: pick.text,
      checkin,
      checkout,
      scraped: items.length,
      totalLine: parsed.totalLine,
      matched: matchPrices(hotels, items),
      elapsedMs: Date.now() - started
    };
  } finally {
    await session.close();
  }
}

/* ---------------- 登录（扫码，弹真实窗口） ---------------- */
const LOGIN_PAGE = 'https://passport.ctrip.com/user/login';

async function hasTicket(cdp) {
  try {
    const cookies = await cdp.cookies([
      'https://hotels.ctrip.com',
      'https://www.ctrip.com',
      'https://passport.ctrip.com'
    ]);
    const names = cookies.map((x) => x.name);
    return LOGIN_COOKIES.some((n) => names.includes(n));
  } catch {
    return false;
  }
}

/**
 * 扫码登录：弹一个真实的 Chrome 窗口让用户扫码，登录态直接写进 opts.profileDir。
 * 最多等 5 分钟。和查价共用 serialize 队列，避免两个 Chrome 同时开互锁 profile。
 */
export function loginCtrip({ profileDir: dir }) {
  return serialize(() => doLogin(dir));
}

async function doLogin(dir) {
  const session = await launchBrowser({ userDataDir: dir, headless: false });
  try {
    await session.cdp.goto(LOGIN_PAGE);
    const start = Date.now();
    while (Date.now() - start < 5 * 60 * 1000) {
      await sleep(2000);
      if (await hasTicket(session.cdp)) return { ok: true };
    }
    return { ok: false };
  } finally {
    await session.close();
  }
}

/* ---------------- 网页扫码登录（服务器无显示：headless 截图二维码给前端展示） ---------------- */

// 携程登录页的二维码元素选择器：真二维码是 SVG 渲染的，在 .qrcode-box 里
const QRCODE_SELECTORS = [
  '.qrcode-box',
  '.lg_loginbox_qrcode',
  'div[class*="qrcode"] svg',
  '.qrcode-img',
  'img[class*="qrcode"]',
  'img[class*="qr-code"]',
  '.login-qrcode img',
  '#qrcode img'
];

// 同一时刻只有一个扫码登录流程（Chrome 实例很重，且和查价共用 profile）
let webLogin = null; // { cdp, session, startedAt }
const WEB_LOGIN_TTL_MS = 5 * 60 * 1000;

/** 点击「扫码登录」标签，把登录页切到二维码登录（携程默认可能是账号密码/短信 tab） */
async function ensureQrTab(cdp) {
  const target = await cdp.eval(`(() => {
    const nodes = [...document.querySelectorAll('li, div, a, span, button, [role="tab"], [class*="tab"]')];
    let best = null;
    for (const el of nodes) {
      const t = (el.innerText || el.textContent || '').trim();
      if (!t || t.length > 10) continue;
      if (!t.includes('扫码') && !t.includes('二维码')) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 20 || r.height < 12) continue;
      if (!best || r.width * r.height < best.w * best.h) {
        best = { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), w: r.width, h: r.height };
      }
    }
    return best ? { x: best.x, y: best.y } : null;
  })()`);
  if (target) {
    await cdp.click(target.x, target.y);
    await sleep(1500);
    return true;
  }
  return false;
}

/** 在登录页里定位二维码元素的区域 */
async function findQrRect(cdp) {
  const rect = await cdp.eval(`(() => {
    const sels = ${JSON.stringify(QRCODE_SELECTORS)};
    // 排除背景图、示意图片、logo（真二维码不含这些关键词）
    const bad = /scan|logo|bg|background|icon|app/i;
    let el = null;
    for (const s of sels) {
      const cand = document.querySelector(s);
      if (cand && !bad.test((cand.src || '') + ' ' + (cand.className || ''))) { el = cand; break; }
    }
    if (!el) {
      const imgs = [...document.querySelectorAll('img')].filter((i) =>
        i.complete && i.naturalWidth >= 100 && i.naturalHeight >= 100 &&
        !bad.test((i.src || '') + ' ' + (i.className || ''))
      );
      // 二维码是正方形，优先最方的那张
      el = imgs.sort((a, b) => {
        const sq = (i) => Math.abs(i.naturalWidth - i.naturalHeight);
        return sq(a) - sq(b) || (b.naturalWidth * b.naturalHeight) - (a.naturalWidth * a.naturalHeight);
      })[0] || null;
    }
    if (!el) return null;
    // 滚到视口中央，消除页面滚动带来的截图坐标偏移
    el.scrollIntoView({ block: 'center', inline: 'center' });
    const r = el.getBoundingClientRect();
    if (r.width < 100 || r.height < 100) return null;
    return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) };
  })()`);
  return rect;
}

async function captureQr(cdp) {
  // 用截图方式拿二维码（携程的二维码不是标准 img，拿 src 会命中背景图/示意图片）
  const rect = await findQrRect(cdp);
  if (!rect) return null;
  await sleep(400); // 等滚动和布局稳定后再截图
  const data = await cdp.screenshot(rect);
  return data ? `data:image/png;base64,${data}` : null;
}

async function closeWebLogin() {
  if (!webLogin) return;
  const s = webLogin;
  webLogin = null;
  try {
    await s.session.close();
  } catch {
    /* ignore */
  }
}

/** 启动网页扫码登录：打开登录页并返回二维码（data URI），已有流程则返回当前新二维码 */
export function startWebLogin({ profileDir: dir }) {
  return serialize(() => doStartWebLogin(dir));
}

async function doStartWebLogin(dir) {
  if (webLogin) {
    const qr = await captureQr(webLogin.cdp);
    return { ok: true, qrcode: qr };
  }
  const session = await launchBrowser({ userDataDir: dir, headless: true });
  webLogin = { cdp: session.cdp, session, startedAt: Date.now() };
  try {
    await session.cdp.goto(LOGIN_PAGE);
    await sleep(2500); // 等页面基本渲染
    await ensureQrTab(session.cdp); // 点「扫码登录」切到二维码 tab
    await sleep(2500); // 等二维码渲染出来
    const qr = await captureQr(session.cdp);
    return { ok: true, qrcode: qr };
  } catch (e) {
    await closeWebLogin();
    throw e;
  }
}

/** 刷新二维码（旧的过期后重取） */
export function refreshWebLoginQr() {
  return serialize(() => doRefreshWebLoginQr());
}

async function doRefreshWebLoginQr() {
  if (!webLogin) return { ok: false, error: '登录流程未启动' };
  await webLogin.cdp.goto(LOGIN_PAGE);
  await sleep(2500);
  await ensureQrTab(webLogin.cdp);
  await sleep(2500);
  const qr = await captureQr(webLogin.cdp);
  return { ok: true, qrcode: qr };
}

/** 检查是否已登录；登录成功或超时会自动关掉浏览器 */
export function checkWebLogin() {
  return serialize(() => doCheckWebLogin());
}

async function doCheckWebLogin() {
  if (!webLogin) return { loggedIn: false, loggingIn: false };
  if (Date.now() - webLogin.startedAt > WEB_LOGIN_TTL_MS) {
    await closeWebLogin();
    return { loggedIn: false, loggingIn: false, expired: true };
  }
  const ok = await hasTicket(webLogin.cdp);
  if (ok) {
    await closeWebLogin();
    return { loggedIn: true, loggingIn: false };
  }
  return { loggedIn: false, loggingIn: true };
}

/** 查价前先确认没有登录流程占着 profile（否则两个 Chrome 互锁） */
export function isWebLoginActive() {
  return Boolean(webLogin);
}
