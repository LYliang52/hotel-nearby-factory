#!/usr/bin/env node
/**
 * 携程登录（只需要做一次，登录态失效时重做）
 *   node scripts/ctrip-login.mjs
 *
 * 会弹出真实的 Chrome 窗口，你在里面扫码登录携程。
 * 登录态存在 data/chrome-profile，之后「携程实时价」就复用它。
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchBrowser, sleep } from '../lib/cdp.mjs';
import { profileDir, isProfileReady } from '../lib/ctrip-live.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROFILE = profileDir(ROOT);
const LOGIN_COOKIES = ['cticket', 'cticket_cn', '_ctTicket'];
const COOKIE_URLS = ['https://hotels.ctrip.com', 'https://www.ctrip.com', 'https://passport.ctrip.com'];

const c = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`
};

async function hasTicket(cdp) {
  try {
    const cookies = await cdp.cookies(COOKIE_URLS);
    const names = cookies.map((x) => x.name);
    return LOGIN_COOKIES.some((n) => names.includes(n));
  } catch {
    return false;
  }
}

async function main() {
  console.log('');
  console.log(c.bold('  携程登录（只需一次）'));
  console.log(c.dim('  ────────────────────────────────'));
  console.log(`  登录态保存在: data\\chrome-profile`);

  if (await isProfileReady(PROFILE)) {
    console.log(`  ${c.dim('目录里已有登录态，如果查价提示失效就重跑本脚本覆盖')}`);
  }
  console.log('');
  console.log('  正在打开携程登录页，请在弹出的窗口里扫码登录…');
  console.log(c.dim('  （登录成功会自动检测到）'));
  console.log('');

  const session = await launchBrowser({ userDataDir: PROFILE, headless: false });
  let ok = false;

  try {
    await session.cdp.goto('https://passport.ctrip.com/user/login');

    const start = Date.now();
    while (Date.now() - start < 5 * 60 * 1000) {
      await sleep(2000);
      if (await hasTicket(session.cdp)) {
        ok = true;
        break;
      }
      const sec = Math.round((Date.now() - start) / 1000);
      if (sec % 10 < 2) process.stdout.write(`\r  等待扫码… ${sec}s   `);
    }
    process.stdout.write('\r                        \r');

    if (ok) {
      console.log(`  ${c.green('✓')} 登录成功`);
      // 顺手打开一次列表页，确认登录态在这台机器上真的能看到价格
      process.stdout.write(`  ${c.dim('· 验证能否看到房价…')}`);
      const dates = {
        checkin: new Date(Date.now() + 86400000).toISOString().slice(0, 10),
        checkout: new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10)
      };
      await session.cdp.goto(
        `https://hotels.ctrip.com/hotels/list?city=14&checkin=${dates.checkin}&checkout=${dates.checkout}`
      );
      let good = false;
      for (let i = 0; i < 10; i += 1) {
        await sleep(2500);
        const n = await session.cdp
          .eval(`document.querySelectorAll('.right-card').length`)
          .catch(() => 0);
        if (n > 0) {
          good = true;
          break;
        }
      }
      process.stdout.write('\r                          \r');
      console.log(
        good
          ? `  ${c.green('✓')} 列表能正常出卡片，可以用「携程实时价」了`
          : `  ${c.yellow('•')} 登录成功，但列表页没出卡片（可能被风控，稍后重试）`
      );
    } else {
      console.log(`  ${c.yellow('•')} 5 分钟内没检测到登录，窗口会关掉。重跑本脚本再试。`);
    }
  } finally {
    // 必须优雅关闭，强杀会让 cookie 写不进 profile
    await session.close();
  }

  console.log('');
  console.log(c.dim('  ────────────────────────────────'));
  console.log(ok ? `  ${c.green('搞定')}：回到页面点「携程实时价」` : c.dim('  没登录成功，重跑：node scripts/ctrip-login.mjs'));
  console.log('');
  process.exitCode = ok ? 0 : 2;
}

main().catch((e) => {
  console.error(`  ${c.red('✗')} 失败:`, e.message);
  process.exit(1);
});
