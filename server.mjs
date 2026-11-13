#!/usr/bin/env node
/**
 * 出差小助手 —— 本地服务
 *   node server.mjs            启动
 *   node server.mjs --port 8080
 *
 * 零依赖：只用 Node 内置模块。
 */
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { exec, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { createAmapClient } from './lib/amap.mjs';
import { createStore } from './lib/store.mjs';
import { buildPlan, PlanError } from './lib/plan.mjs';
import { loadCtripCityMap, lookupCtripCityId } from './lib/ctrip.mjs';
import { fetchLivePrices, loginCtrip, isProfileReady, profileDir as ctripProfileDir, defaultDates as ctripDates } from './lib/ctrip-live.mjs';

// 目录约定：
//   开发运行时 —— ROOT 就是脚本所在目录，数据和代码在一起
//   打包成 exe 后 —— boot.mjs 会设置 HNF_APP_DIR（解压出来的代码）和 HNF_DATA_DIR（用户数据目录）
//   config.json / data/ 必须落在 DATA_ROOT，exe 自己所在的位置通常是只读的
const SELF_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.HNF_APP_DIR || SELF_DIR;
const DATA_ROOT = process.env.HNF_DATA_DIR || ROOT;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.join(DATA_ROOT, 'data');
const CTRIP_PROFILE_DIR = ctripProfileDir(DATA_ROOT);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2'
};

const argv = process.argv.slice(2);
function argValue(name, fallback) {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
}

/** 用系统默认浏览器打开页面（启动器带 --open 时触发） */
function openBrowser(url) {
  const cmd =
    process.platform === 'win32'
      ? `cmd /c start "" "${url}"`
      : process.platform === 'darwin'
        ? `open "${url}"`
        : `xdg-open "${url}"`;
  exec(cmd, (e) => {
    if (e) console.log(`（自动打开浏览器失败，请手动访问 ${url}）`);
  });
}

/** exe 模式下启动右下角托盘图标：双击/点菜单打开页面，右键退出 */
function startTray(port) {
  if (!process.env.HNF_APP_DIR) return; // 开发模式（node server.mjs）不启动托盘
  const trayScript = path.join(process.env.HNF_APP_DIR, 'assets', 'tray.ps1');
  const iconPath = path.join(process.env.HNF_APP_DIR, 'assets', 'icon.ico');
  try {
    const child = spawn(
      'powershell',
      [
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', trayScript,
        '-MainPid', String(process.pid),
        '-Port', String(port),
        '-IconPath', iconPath
      ],
      { stdio: 'ignore', windowsHide: true }
    );
    child.unref();
    console.log('  已启动右下角托盘图标');
  } catch (e) {
    console.log(`  （启动托盘失败：${e.message}）`);
  }
}

async function loadConfig() {
  // config.json 优先；没有就用 config.example.json，并提示去填 key
  for (const name of ['config.json', 'config.example.json']) {
    try {
      const raw = await fs.readFile(path.join(DATA_ROOT, name), 'utf8');
      const parsed = JSON.parse(raw.replace(/^\uFEFF/, ''));
      return { config: parsed, source: name };
    } catch {
      /* 继续尝试下一个 */
    }
  }
  return { config: { amapKey: '', defaults: {}, brands: [], priceCheck: {} }, source: '内置默认' };
}

function json(res, status, body) {
  const payload = Buffer.from(JSON.stringify(body), 'utf8');
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': payload.length,
    'cache-control': 'no-store'
  });
  res.end(payload);
}

async function readBody(req, limitBytes = 1_000_000) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limitBytes) throw new Error('请求体过大');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw.trim()) return {};
  return JSON.parse(raw);
}

async function serveStatic(res, pathname) {
  const rel = decodeURIComponent(pathname === '/' ? '/index.html' : pathname);
  const target = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!target.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  try {
    const buf = await fs.readFile(target);
    const ext = path.extname(target).toLowerCase();
    res.writeHead(200, {
      'content-type': MIME[ext] || 'application/octet-stream',
      'content-length': buf.length,
      // 本地工具，改完代码刷新就该生效，别让浏览器缓存卡住
      'cache-control': 'no-store'
    });
    res.end(buf);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('Not Found');
  }
}

/** 探测本机端口上是不是已经跑着一个本工具（双击第二次启动器时用） */
async function isAlreadyRunning(p) {
  try {
    const res = await fetch(`http://127.0.0.1:${p}/api/config`, { signal: AbortSignal.timeout(900) });
    if (!res.ok) return false;
    const j = await res.json();
    return Boolean(j && j.ok === true && Array.isArray(j.brands));
  } catch {
    return false;
  }
}

async function main() {
  const CONFIG_FILE = path.join(DATA_ROOT, 'config.json');

  let { config, source } = await loadConfig();
  const wantPort = Number(argValue('port', config.server?.port || 5173));
  const host = argValue('host', '127.0.0.1');
  const shouldOpen = argv.includes('--open');

  // 已经开着一个就别再起第二个，直接把页面打开
  if (host !== '0.0.0.0' && (await isAlreadyRunning(wantPort))) {
    const url = `http://127.0.0.1:${wantPort}`;
    console.log(`出差小助手已经在运行：${url}`);
    if (shouldOpen) openBrowser(url);
    return;
  }

  const PLACEHOLDER_KEY = /在此填入|YOUR_KEY|xxx/i;
  let amap = null;
  let ctripCityMap = {};
  let keyLooksUnset = true;
  let configMtime = 0;

  async function fileMtime(file) {
    try {
      return (await fs.stat(file)).mtimeMs;
    } catch {
      return 0;
    }
  }

  /**
   * 重新读取 config.json。
   * 之前配置只在启动时读一次，用户改完 key 双击启动器、服务还在跑，
   * 就会出现"配置明明改了却还是报错" —— 这里按文件 mtime 自动重载。
   */
  async function reloadConfig() {
    ({ config, source } = await loadConfig());
    const key = process.env.AMAP_KEY || config.amapKey || '';
    amap = createAmapClient({ key, minRequestGapMs: Number(config.server?.minRequestGapMs ?? 350) });
    ctripCityMap = await loadCtripCityMap(DATA_DIR);
    keyLooksUnset = !key || PLACEHOLDER_KEY.test(key);
    configMtime = await fileMtime(CONFIG_FILE);
  }

  async function refreshIfChanged() {
    const m = await fileMtime(CONFIG_FILE);
    if (m === configMtime) return;
    await reloadConfig();
    console.log(`[config] 检测到 config.json 变更，已重新加载（${source}）`);
  }

  await reloadConfig();
  const store = createStore(DATA_DIR);

  // 携程登录：是否有一个扫码窗口正在等（用来给前端轮询状态，也防止重复弹窗）
  let ctripLoginRunning = false;
  let ctripLastLoginOk = null;

  const server = http.createServer(async (req, res) => {
    const started = Date.now();
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const { pathname } = url;

    try {
      if (!pathname.startsWith('/api/')) {
        await serveStatic(res, pathname);
        return;
      }

      // 用户改了 config.json（最常见的是换 key）不用重启服务，这里按 mtime 自动重载
      await refreshIfChanged();

      if (pathname === '/api/config' && req.method === 'GET') {
        json(res, 200, {
          ok: true,
          configSource: source,
          keyConfigured: !keyLooksUnset,
          defaults: config.defaults || {},
          brands: config.brands || [],
          priceCheck: config.priceCheck || {},
          ctripCityCount: Object.keys(ctripCityMap).length
        });
        return;
      }

      if (pathname === '/api/health' && req.method === 'GET') {
        if (keyLooksUnset) {
          json(res, 200, {
            ok: false,
            infocode: 'NO_KEY',
            error: 'config.json 里的 amapKey 还没填',
            hint: '去 https://console.amap.com 新建一个【Web服务】类型的 key，填进 config.json（保存后刷新页面即可生效，不用重启）'
          });
          return;
        }
        const result = await amap.checkKey();
        json(res, 200, result);
        return;
      }

      if (pathname === '/api/plan' && req.method === 'POST') {
        if (keyLooksUnset) {
          json(res, 400, {
            ok: false,
            code: 'NO_KEY',
            error: 'amapKey 未配置',
            hint: '去 https://console.amap.com 新建【Web服务】类型 key，填进 config.json（保存后刷新页面即可生效）'
          });
          return;
        }
        const body = await readBody(req);
        const result = await buildPlan({ amap, config, params: body, store, ctripCityMap });
        json(res, 200, result);
        return;
      }

      if (pathname === '/api/prices' && req.method === 'GET') {
        json(res, 200, { ok: true, prices: await store.loadPrices() });
        return;
      }

      /* ---- 携程实时房价 ---- */

      if (pathname === '/api/ctrip/status' && req.method === 'GET') {
        json(res, 200, {
          ok: true,
          loggedIn: await isProfileReady(CTRIP_PROFILE_DIR),
          loggingIn: ctripLoginRunning
        });
        return;
      }

      if (pathname === '/api/ctrip/login' && req.method === 'POST') {
        if (ctripLoginRunning) {
          json(res, 200, {
            ok: false,
            code: 'LOGIN_IN_PROGRESS',
            loggingIn: true,
            error: '登录窗口已经打开了，请在弹出的 Chrome 窗口里扫码'
          });
          return;
        }
        ctripLoginRunning = true;
        // 先回前端，扫码登录在后台跑（最多 5 分钟），别让这个请求挂 5 分钟
        json(res, 200, { ok: true, started: true, hint: '已打开登录窗口，请在弹出的 Chrome 窗口里扫码登录携程' });
        loginCtrip({ profileDir: CTRIP_PROFILE_DIR })
          .then((r) => {
            ctripLastLoginOk = r.ok;
            console.log(`[ctrip] 登录${r.ok ? '成功' : '超时未完成'}`);
          })
          .catch((e) => {
            ctripLastLoginOk = false;
            console.error('[ctrip] 登录流程出错:', e.message);
          })
          .finally(() => {
            ctripLoginRunning = false;
          });
        return;
      }

      if (pathname === '/api/ctrip/live' && req.method === 'POST') {
        if (!(await isProfileReady(CTRIP_PROFILE_DIR))) {
          json(res, 400, {
            ok: false,
            code: 'CTRIP_NOT_LOGGED_IN',
            error: '还没登录携程',
            hint: '点页面下方的「登录携程」按钮扫码登录，登录一次后实时价就能用'
          });
          return;
        }

        const body = await readBody(req);
        const address = String(body.address || '').trim();
        const hotels = Array.isArray(body.hotels) ? body.hotels : [];
        if (!address) {
          json(res, 400, { ok: false, error: '需要 address（厂家地址或商圈名）' });
          return;
        }
        if (!hotels.length) {
          json(res, 400, { ok: false, error: '没有可匹配的酒店，先查一次酒店' });
          return;
        }

        const city = String(body.city || '').trim();
        const cityId = lookupCtripCityId(ctripCityMap, city) || 14;
        const dates = body.checkin
          ? { checkin: body.checkin, checkout: body.checkout || body.checkin }
          : ctripDates();

        const started = Date.now();
        try {
          console.log(`[ctrip] 查实时价：${address}（${dates.checkin}）`);
          const result = await fetchLivePrices({
            profileDir: CTRIP_PROFILE_DIR,
            cityId,
            address,
            checkin: dates.checkin,
            checkout: dates.checkout,
            hotels,
            scrolls: Number(body.scrolls) || 8
          });
          console.log(
            `[ctrip] ${((Date.now() - started) / 1000).toFixed(0)}s 抓到 ${result.scraped} 家，匹配 ${result.matched.length} 家${result.cached ? '（缓存）' : ''}`
          );
          json(res, 200, { ok: true, ...result });
        } catch (e) {
          if (e.code === 'CTRIP_NOT_LOGGED_IN') {
            json(res, 400, {
              ok: false,
              code: 'CTRIP_NOT_LOGGED_IN',
              error: '携程登录态失效',
              hint: '点页面下方的「登录携程」按钮重新登录'
            });
            return;
          }
          json(res, 500, { ok: false, error: e.message || '携程查价失败' });
        }
        return;
      }

      if (pathname === '/api/prices/apply' && req.method === 'POST') {
        const body = await readBody(req);
        const items = Array.isArray(body.items) ? body.items : [];
        let applied = 0;
        for (const it of items) {
          if (!it.id || !Number.isFinite(Number(it.price))) continue;
          await store.setPrice(it.id, {
            price: it.price,
            name: it.name || '',
            source: it.source || '携程',
            note: it.note || ''
          });
          applied += 1;
        }
        json(res, 200, { ok: true, applied });
        return;
      }

      if (pathname === '/api/price' && req.method === 'POST') {
        const body = await readBody(req);
        const saved = await store.setPrice(body.id, body);
        json(res, 200, { ok: true, saved });
        return;
      }

      if (pathname === '/api/price' && req.method === 'DELETE') {
        const id = url.searchParams.get('id');
        const removed = await store.removePrice(id);
        json(res, 200, { ok: true, removed });
        return;
      }

      if (pathname === '/api/demo' && req.method === 'GET') {
        try {
          const raw = await fs.readFile(path.join(DATA_DIR, 'demo-plan.json'), 'utf8');
          json(res, 200, JSON.parse(raw.replace(/^\uFEFF/, '')));
        } catch {
          json(res, 404, { ok: false, error: '没有演示数据（data/demo-plan.json 缺失）' });
        }
        return;
      }

      json(res, 404, { ok: false, error: `未知接口 ${pathname}` });
    } catch (e) {
      const isPlan = e instanceof PlanError;
      const status = isPlan ? 422 : e.statusCode || 500;
      json(res, status, {
        ok: false,
        code: isPlan ? e.code : 'SERVER_ERROR',
        error: e.message || String(e),
        hint: isPlan ? e.hint : ''
      });
      if (!isPlan) console.error(`[${new Date().toISOString()}] ${req.method} ${pathname} 失败:`, e);
    } finally {
      const ms = Date.now() - started;
      if (ms > 500) console.log(`${req.method} ${pathname} -> ${ms}ms`);
    }
  });

  let port = wantPort;
  let retries = 0;

  const onListening = () => {
    const url = `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${port}`;
    console.log('');
    console.log('  出差小助手已启动');
    console.log(`  打开  ${url}`);
    console.log(`  配置  ${source}`);
    if (keyLooksUnset) {
      console.log('  ⚠ 还没有可用的 amapKey —— 页面会用演示数据展示效果');
    }
    if (!Object.keys(ctripCityMap).length) {
      console.log('  ⚠ 携程城市 id 映射为空，核价链接会退化成搜索页（npm run citymap 可补齐）');
    }
    console.log('');
    console.log('  （这个窗口就是服务本体，关掉它就停了）');
    console.log('');
    if (shouldOpen) openBrowser(url);
    startTray(port);
  };

  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE' && retries < 10) {
      retries += 1;
      port = wantPort + retries;
      console.log(`端口 ${port - 1} 被占用，改用 ${port} …`);
      server.listen(port, host, onListening);
      return;
    }
    if (e.code === 'EADDRINUSE') {
      console.error(`连续 10 个端口都被占用，请手动指定：node server.mjs --port 8080`);
      process.exit(1);
    }
    throw e;
  });

  server.listen(port, host, onListening);
}

main().catch((e) => {
  console.error('启动失败:', e);
  process.exit(1);
});
