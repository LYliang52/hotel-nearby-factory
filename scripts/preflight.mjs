#!/usr/bin/env node
/**
 * 启动前检查（启动器双击时自动调用）
 *   node scripts/preflight.mjs                  自动检查
 *   node scripts/preflight.mjs --set-key <key>  直接写入一个 key 并校验
 *
 * 做四件事：
 *   1. 没有 config.json 就从模板生成
 *   2. 没有可用的高德 key 就当场让你粘贴进去
 *   3. 探测一次 key，明确告诉你是哪种问题（平台类型不对 / 过期 / IP 白名单 / 额度）
 *   4. 告诉启动器能不能直接起
 *
 * 退出码：0 = 可以启动（哪怕 key 有问题，也能看演示效果）；1 = 需要先处理
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { AMAP_ERRORS } from '../lib/amap.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG = path.join(ROOT, 'config.json');
const EXAMPLE = path.join(ROOT, 'config.example.json');

const PLACEHOLDER = /在此填入|YOUR_KEY|xxx/i;
/** 这些错误说明"换一个 key"才是解法 */
const KEY_PROBLEM_CODES = new Set(['10009', '10001', '10003', '10044']);

const c = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`
};

const line = () => console.log(c.dim('  ────────────────────────────────'));

async function readJson(file) {
  return JSON.parse((await fs.readFile(file, 'utf8')).replace(/^\uFEFF/, ''));
}

async function writeJson(file, value) {
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await fs.rename(tmp, file);
}

/** 探测 key 类型：只有 Web服务 类型的 key 能调 restapi */
async function probeKey(key) {
  try {
    const res = await fetch(`https://restapi.amap.com/v3/ip?key=${encodeURIComponent(key)}`, {
      signal: AbortSignal.timeout(9000)
    });
    const j = await res.json();
    if (String(j.status) === '1') return { ok: true };
    return { ok: false, infocode: String(j.infocode || ''), info: String(j.info || '') };
  } catch (e) {
    return { ok: false, infocode: 'NETWORK', info: e.message };
  }
}

function explainFailure(probe) {
  const hint = AMAP_ERRORS[probe.infocode] || '';
  console.log(`  ${c.red('✗')} key 不可用：${probe.info || '未知错误'}${probe.infocode ? ` (${probe.infocode})` : ''}`);
  if (hint) console.log(c.dim(`     ${hint}`));
  console.log('');

  if (probe.infocode === '10009') {
    console.log(c.bold('  这是「key 平台类型不对」，不是 key 写错。'));
    console.log('  高德的 key 分平台，创建后不能改类型。你手上这个多半是「Web端(JS API)」key，');
    console.log('  它能画地图，但查酒店 / 地理编码那些接口只认「Web服务」key。');
    console.log('');
    console.log(`  去 https://console.amap.com →「应用管理」→ 同一个应用下点${c.bold('「添加 Key」')}`);
    console.log(`  → 服务平台选 ${c.bold('「Web 服务」')}（别选带 JS API 字样的）`);
  } else if (probe.infocode === '10005') {
    console.log('  去控制台把这个 key 的「IP 白名单」清空（家用宽带 IP 会变）。');
  } else if (probe.infocode === '10003' || probe.infocode === '10044') {
    console.log('  当天额度用完了。个人 key 额度小，等第二天，或者换一个 key。');
  } else if (probe.infocode === 'NETWORK') {
    console.log('  连不上高德服务器，先检查网络 / 代理 / 防火墙，跟 key 无关。');
  }
}

async function main() {
  console.log('');
  console.log(c.bold('  出差小助手 · 启动检查'));
  line();

  const major = Number(process.versions.node.split('.')[0]);
  if (major < 18) {
    console.log(`  ${c.red('✗')} Node.js 版本太低（当前 ${process.versions.node}），需要 18 以上`);
    console.log(c.dim('     去 https://nodejs.org 装个 LTS 版本再试。'));
    process.exitCode = 1;
    return;
  }

  /* 1. config.json */
  let config;
  try {
    config = await readJson(CONFIG);
  } catch {
    try {
      config = await readJson(EXAMPLE);
      await writeJson(CONFIG, config);
      console.log(`  ${c.yellow('•')} 已从模板生成 config.json`);
    } catch {
      console.log(`  ${c.red('✗')} 读不到 config.json，也读不到 config.example.json`);
      console.log(c.dim('     文件是不是被删了？重新解压一份项目即可。'));
      process.exitCode = 1;
      return;
    }
  }

  /* 2. 交互准备 */
  const canAsk = process.stdin.isTTY;
  const rl = canAsk ? readline.createInterface({ input: process.stdin, output: process.stdout }) : null;
  const ask = async (q) => {
    if (!rl) return '';
    const a = (await rl.question(q)).trim();
    return a.replace(/^["']|["']$/g, '');
  };

  const saveKey = async (value) => {
    config.amapKey = value;
    await writeJson(CONFIG, config);
    console.log(`  ${c.green('✓')} 已写入 config.json`);
  };

  const looksLikeKey = (v) => /^[0-9a-f]{32}$/i.test(v);

  try {
    /* 3. 直接指定 key（--set-key，脚本或手动用） */
    const setIdx = process.argv.indexOf('--set-key');
    if (setIdx > 0 && process.argv[setIdx + 1]) {
      const v = process.argv[setIdx + 1].trim();
      if (!looksLikeKey(v)) {
        console.log(`  ${c.red('✗')} 这不像高德 key（要 32 位十六进制，当前 ${v.length} 位）`);
        process.exitCode = 1;
        return;
      }
      await saveKey(v);
      const p = await probeKey(v);
      if (p.ok) {
        console.log(`  ${c.green('✓')} key 可用（Web服务），可以正常查酒店`);
        return;
      }
      explainFailure(p);
      process.exitCode = 1;
      return;
    }

    /* 4. key 有没有 */
    let key = String(process.env.AMAP_KEY || config.amapKey || '').trim();
    const keyMissing = !key || PLACEHOLDER.test(key);

    if (keyMissing) {
      console.log(`  ${c.yellow('•')} config.json 里还没有高德 key`);
      console.log('');
      console.log('  需要一个【Web服务】类型的 key（不是「Web端(JS API)」）：');
      console.log(`    1. 打开 https://console.amap.com →「应用管理」`);
      console.log(`    2. 新建应用 →「添加 Key」→ 服务平台选 ${c.bold('「Web 服务」')}`);
      console.log('    3. 复制那串 32 位字符，粘贴到下面');
      console.log('');

      if (!canAsk) {
        console.log(`  ${c.yellow('•')} 当前不是交互终端，跳过粘贴。先看演示效果也行。`);
        process.exitCode = 0;
        return;
      }
      const answer = await ask('  粘贴 key（直接回车跳过）：');
      if (!answer) {
        console.log(`  ${c.yellow('•')} 跳过了。启动后点页面上的「先看演示效果」可以先熟悉界面。`);
        process.exitCode = 0;
        return;
      }
      if (!looksLikeKey(answer)) {
        console.log(`  ${c.yellow('•')} 这不像 key（要 32 位十六进制，你贴了 ${answer.length} 位），先不写入`);
        process.exitCode = 0;
        return;
      }
      await saveKey(answer);
      key = answer;
    }

    /* 5. 探测，失败时给一次就地换 key 的机会 */
    process.stdout.write(c.dim('  · 正在探测 key…'));
    let probe = await probeKey(key);
    process.stdout.write('\r                                              \r');

    if (probe.ok) {
      console.log(`  ${c.green('✓')} key 可用（Web服务），可以正常查酒店`);
      line();
      console.log('');
      process.exitCode = 0;
      return;
    }

    explainFailure(probe);

    if (canAsk && KEY_PROBLEM_CODES.has(probe.infocode)) {
      console.log('');
      const answer = await ask('  建好新 key 了？粘贴到这里（直接回车先跳过）：');
      if (answer && looksLikeKey(answer)) {
        await saveKey(answer);
        process.stdout.write(c.dim('  · 再测一次…'));
        probe = await probeKey(answer);
        process.stdout.write('\r                                              \r');
        if (probe.ok) {
          console.log(`  ${c.green('✓')} 新 key 可用（Web服务）`);
          line();
          console.log('');
          process.exitCode = 0;
          return;
        }
        explainFailure(probe);
      } else if (answer) {
        console.log(`  ${c.yellow('•')} 这不像 key（要 32 位十六进制，你贴了 ${answer.length} 位），先不写入`);
      }
    }

    console.log('');
    line();
    console.log(`  ${c.yellow('•')} 仍然可以先启动，页面上点「先看演示效果」熟悉界面，配好 key 再查真实数据。`);
    console.log('');
    process.exitCode = 0;
  } finally {
    rl?.close();
  }
}

main().catch((e) => {
  console.error('检查过程出错:', e.message);
  process.exitCode = 1;
});
