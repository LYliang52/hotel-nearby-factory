/**
 * 极简 CDP 驱动（零依赖，Node 22+ 内置 WebSocket）。
 *
 * 只做查价需要的事：启动 / 导航 / 执行 JS / 模拟鼠标键盘 / 关闭。
 *
 * 两个必须注意的坑（都踩过）：
 *   1. api 走 IPv6 时会和白名单对不上 —— 这里只管本地 Chrome，不涉及
 *   2. 反复启动同一个 profile 会互相锁住 —— 启动前必须清 Singleton* 和 DevToolsActivePort，
 *      关闭时必须等进程真的退出，否则下一次启动会读到旧的端口号
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 常见 Chrome / Edge 安装位置 */
export function findBrowser() {
  // 显式指定优先（服务器部署时用 CHROME_PATH 指向装好的 Chromium）
  if (process.env.CHROME_PATH && existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;

  const list =
    process.platform === 'win32'
      ? [
          'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
          'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
          path.join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe'),
          'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
          'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
        ]
      : process.platform === 'darwin'
        ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
        : [
            '/usr/bin/google-chrome-stable',
            '/usr/bin/google-chrome',
            '/usr/bin/chromium',
            '/usr/bin/chromium-browser',
            '/usr/local/bin/chromium',
            '/usr/bin/chrome',
            '/usr/bin/headless_shell'
          ];
  return list.find((p) => p && existsSync(p)) || null;
}

/** 串行队列：Chrome 实例很重，同时开两个必炸 */
let queue = Promise.resolve();
export function serialize(fn) {
  const run = queue.then(fn, fn);
  queue = run.then(
    () => {},
    () => {}
  );
  return run;
}

function createCdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let nextId = 0;
  const pending = new Map();
  const ready = new Promise((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error('CDP 连接失败'));
  });
  ws.onmessage = (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    const waiter = msg.id && pending.get(msg.id);
    if (!waiter) return;
    pending.delete(msg.id);
    msg.error ? waiter.reject(new Error(msg.error.message || 'CDP 错误')) : waiter.resolve(msg.result);
  };

  return {
    ready,
    send(method, params = {}, timeoutMs = 40000) {
      const id = ++nextId;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, params }));
        setTimeout(() => {
          if (pending.has(id)) {
            pending.delete(id);
            reject(new Error(`${method} 超时`));
          }
        }, timeoutMs);
      });
    },
    async eval(expression, timeoutMs = 40000) {
      const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, timeoutMs);
      if (r.exceptionDetails) {
        const detail =
          r.exceptionDetails.exception?.description || r.exceptionDetails.exception?.value || r.exceptionDetails.text;
        throw new Error(String(detail || '页面脚本出错').split('\n')[0].slice(0, 200));
      }
      return r.result?.value;
    },
    async goto(url, settleMs = 0) {
      await this.send('Page.navigate', { url });
      if (settleMs) await sleep(settleMs);
    },
    /** 真实鼠标点击（React 只认这个，dispatchEvent 骗不过去） */
    async click(x, y) {
      await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
      await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
    },
    /** 真实键盘输入 */
    async type(text) {
      await this.send('Input.insertText', { text });
    },
    async pressEnter() {
      for (const type of ['keyDown', 'keyUp']) {
        await this.send('Input.dispatchKeyEvent', {
          type,
          key: 'Enter',
          code: 'Enter',
          windowsVirtualKeyCode: 13,
          nativeVirtualKeyCode: 13,
          text: type === 'keyDown' ? '\r' : undefined
        });
      }
    },
    /** 读 cookie（判断登录态） */
    async cookies(urls) {
      const r = await this.send('Network.getCookies', { urls });
      return r.cookies || [];
    },
    /** 截取页面指定区域（viewport 坐标），返回 base64 PNG */
    async screenshot(clip) {
      const r = await this.send(
        'Page.captureScreenshot',
        {
          format: 'png',
          fromSurface: true,
          clip: {
            x: Math.round(clip.x),
            y: Math.round(clip.y),
            width: Math.max(1, Math.round(clip.width)),
            height: Math.max(1, Math.round(clip.height)),
            scale: 1
          }
        },
        60000
      );
      return r.data;
    },
    close() {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    }
  };
}

/**
 * 启动浏览器并连上 CDP
 * @param {object} opts
 * @param {string} opts.userDataDir  登录态目录
 * @param {boolean} opts.headless
 */
export async function launchBrowser({ userDataDir, headless = true } = {}) {
  if (typeof WebSocket === 'undefined') {
    throw new Error(`当前 Node ${process.versions.node} 没有内置 WebSocket，查价功能需要 Node 22 以上`);
  }
  const exe = findBrowser();
  if (!exe) throw new Error('没找到 Chrome / Edge，请先安装');

  await fs.mkdir(userDataDir, { recursive: true });
  // 上一次没退干净会留下这些，导致这次读到旧端口或者干脆起不来
  for (const name of ['SingletonLock', 'SingletonCookie', 'SingletonSocket', 'DevToolsActivePort']) {
    await fs.rm(path.join(userDataDir, name), { force: true }).catch(() => {});
  }

  const args = [
    headless ? '--headless=new' : '--start-maximized',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-blink-features=AutomationControlled',
    '--disable-extensions',
    '--window-size=1400,1200',
    '--remote-debugging-port=0',
    `--user-data-dir=${userDataDir}`
  ];
  if (process.platform === 'linux') {
    // 容器里常以 root 跑 Chrome，必须 --no-sandbox；/dev/shm 很小，禁用以免渲染崩溃
    args.push('--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage');
  }
  args.push('about:blank');

  const proc = spawn(exe, args, { stdio: 'ignore' });

  const portFile = path.join(userDataDir, 'DevToolsActivePort');
  let port = 0;
  for (let i = 0; i < 160; i += 1) {
    await sleep(150);
    if (proc.exitCode !== null) throw new Error(`浏览器启动即退出（code ${proc.exitCode}）`);
    try {
      const raw = await fs.readFile(portFile, 'utf8');
      const p = Number(raw.split('\n')[0].trim());
      if (!p) continue;
      // 光读到端口不算数，要真的能连上（旧文件里可能是上一次的端口）
      const probe = await fetch(`http://127.0.0.1:${p}/json/version`, { signal: AbortSignal.timeout(1500) }).catch(() => null);
      if (probe?.ok) {
        port = p;
        break;
      }
    } catch {
      /* 继续等 */
    }
  }
  if (!port) {
    proc.kill();
    throw new Error('浏览器调试端口没起来（可能 profile 被占用，关掉残留的 Chrome 再试）');
  }

  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const target = list.find((t) => t.type === 'page');
  if (!target?.webSocketDebuggerUrl) {
    proc.kill();
    throw new Error('拿不到页面调试地址');
  }

  const cdp = createCdp(target.webSocketDebuggerUrl);
  await cdp.ready;
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Network.enable');

  return {
    cdp,
    async close() {
      // 优雅退出，让 cookie 落盘；用 kill 会丢登录态
      try {
        await cdp.send('Browser.close', {}, 5000);
      } catch {
        /* 可能已经断开 */
      }
      for (let i = 0; i < 25; i += 1) {
        if (proc.exitCode !== null) break;
        await sleep(150);
      }
      try {
        cdp.close();
      } catch {
        /* ignore */
      }
      if (proc.exitCode === null) {
        try {
          proc.kill();
        } catch {
          /* ignore */
        }
      }
      await sleep(400);
    }
  };
}

export { sleep };
