// 采集入口：手动触发，按「模式」拉取 3 个 rankings 端点并落盘原始快照。
//
// 手动执行：node collector/fetch-meta.mjs [--all] [--mode <2|4|4-大师场|4-精英场|4-标准场>] [--force]
//   --all：一键采集 MODES 里的全部模式（万象大赛 + 钻石狂潮·大师场），供 GitHub Actions 使用
// 落盘位置：data/meta/<YYYY-MM-DD>/<slot>/api/{heroes,commanders,equipment}.json
//   slot = gameType（2=万象大赛 / 4=钻石狂潮）；钻石狂潮指定具体场次时追加 '-<场次>'
//
// 模式口径（唯一权威来源：站点 assets/seo-*.js）：
//   站点默认 gameType=2（万象大赛），响应体中不含任何模式字段，模式完全由请求参数决定；
//   仅 gameType=4（钻石狂潮）时才有 subModeName（空=不限 / 大师场 / 精英场 / 标准场）。
//
// 关键约束：
//   §3.2 防线 2  先串行取回全部端点并逐一校验，全部通过后才 mkdir + 写文件；
//               任何一步失败 → 本轮零写入，不留空壳目录，不覆盖已有快照。
//   §3.4 幂等     同日同模式已有有效快照则直接跳过（--force 强制重采）。
//   §3.4 并发锁   用 PID 锁文件防止重复触发同时发起两轮采集；stale 锁可被接管。

import { mkdir, writeFile, readFile, unlink, open } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { requestJson, ThrottledError } from './client.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// 站点下拉选项（与 seo-*.js 中 $1 / WF 逐字一致）
export const SUB_MODES = ['不限', '大师场', '精英场', '标准场'];
export const DEFAULT_MODE = '2';
const NO_SUB_MODE = '不限';

// 本工具固定使用的两个模式：万象大赛（不限场次）+ 钻石狂潮·大师场。
// 一键采集按此列表顺序执行；报告模式下拉也直接取自这里。
export const MODES = [
  { id: '2', gameType: '2', subModeName: null, label: '万象大赛' },
  { id: '4-大师场', gameType: '4', subModeName: '大师场', label: '钻石狂潮' },
];

/**
 * 模式归一：gameType + subModeName → 落盘槽位名。
 * 仅 gameType=4 且指定具体场次（非「不限」）时追加 '-<场次>'，其余一律就是 gameType。
 */
export function slotKey(gameType, subModeName) {
  const gt = String(gameType ?? DEFAULT_MODE);
  const sub = subModeName == null ? '' : String(subModeName).trim();
  if (gt === '4' && sub && sub !== NO_SUB_MODE) return `${gt}-${sub}`;
  return gt;
}

// 槽位名 → 可读模式名（上下文标题 / 报告文件名 / 前端徽标共用）
export function modeLabel(slot) {
  const s = String(slot);
  const m = MODES.find((x) => x.id === s);
  if (m) return m.label;
  if (s === '2') return '万象大赛';
  if (s === '4') return '钻石狂潮·不限';
  const sub = /^4-(.+)$/.exec(s);
  return sub ? `钻石狂潮·${sub[1]}` : s;
}

/**
 * 依模式构造 3 个 rankings 端点：gameType 必须显式传入；subModeName 仅在
 * gameType=4 且为具体场次时附加（与站点 ti() 完全一致）。
 */
export function buildEndpoints(gameType, subModeName) {
  const gt = String(gameType ?? DEFAULT_MODE);
  const sub = subModeName == null ? '' : String(subModeName).trim();
  const q = [`time=7`, `version=v1`, `gameType=${encodeURIComponent(gt)}`];
  if (gt === '4' && sub && sub !== NO_SUB_MODE) q.push(`subModeName=${encodeURIComponent(sub)}`);
  const query = q.join('&');
  return [
    { file: 'heroes.json', path: `/rankings/heroes?${query}` },
    { file: 'commanders.json', path: `/rankings/commanders?${query}` },
    { file: 'equipment.json', path: `/rankings/equipment?${query}` },
  ];
}

export const DEFAULT_ENDPOINTS = buildEndpoints(DEFAULT_MODE, null);

const LOCK_NAME = '.collect.lock';

function today() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

const resolveRoot = (dataDir) => (dataDir ? path.resolve(dataDir) : path.join(ROOT, 'data'));

// 进程是否存活：signal 0 只做存在性探测，不实际发信号
function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM'; // 存在但无权限 → 视为存活
  }
}

// 判断某模式快照是否已存在且有效：3 个端点文件俱在，且均满足 code===1 && data!=null
export async function hasValidSnapshot(apiDir, endpoints = DEFAULT_ENDPOINTS) {
  for (const ep of endpoints) {
    let json;
    try {
      json = JSON.parse(await readFile(path.join(apiDir, ep.file), 'utf8'));
    } catch {
      return false;
    }
    if (json.code !== 1 || json.data == null) return false;
  }
  return true;
}

/**
 * 获取并发锁（PID 锁文件）。
 * @param {string} root 数据根目录
 * @returns {Promise<string|null>} 成功返回锁文件路径；已有存活进程持有时返回 null
 */
export async function acquireLock(root) {
  const lockPath = path.join(root, LOCK_NAME);
  await mkdir(root, { recursive: true });

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fh = await open(lockPath, 'wx'); // 原子创建，已存在则抛 EEXIST
      await fh.writeFile(String(process.pid), 'utf8');
      await fh.close();
      return lockPath;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      const raw = await readFile(lockPath, 'utf8').catch(() => '');
      if (isAlive(Number.parseInt(raw.trim(), 10))) return null; // 有活进程在跑 → 让出
      await unlink(lockPath).catch(() => {}); // stale 锁（进程已死）→ 清理后重试一次
    }
  }
  return null;
}

export async function releaseLock(lockPath) {
  if (lockPath) await unlink(lockPath).catch(() => {});
}

/**
 * 采集并落盘（不含并发锁；幂等检查在发起任何 HTTP 之前完成）。
 * @param {object} [options]
 * @param {string} [options.dataDir] 数据根目录，默认 <repo>/data（测试时指向临时目录）
 * @param {string} [options.date] 快照日期（YYYY-MM-DD），默认今天
 * @param {string} [options.gameType] 模式：'2' 万象大赛 / '4' 钻石狂潮（默认 '2'）
 * @param {string} [options.subModeName] 钻石狂潮场次（空=不限），仅 gameType='4' 有效
 * @param {Array}  [options.endpoints] 端点列表，默认按模式生成
 * @param {boolean} [options.force] 忽略已有快照，强制重采
 * @returns {Promise<{apiDir: string, slot: string, files: string[], skipped: boolean}>}
 */
export async function collectMeta({
  dataDir,
  date = today(),
  gameType = DEFAULT_MODE,
  subModeName = null,
  endpoints,
  force = false,
} = {}) {
  const root = resolveRoot(dataDir);
  const slot = slotKey(gameType, subModeName);
  const eps = endpoints ?? buildEndpoints(gameType, subModeName);
  const apiDir = path.join(root, 'meta', date, slot, 'api');

  if (!force && (await hasValidSnapshot(apiDir, eps))) {
    return { apiDir, slot, files: [], skipped: true };
  }

  // 第一步：全部取回 + 校验。此处抛错则不会有任何落盘动作。
  const results = [];
  for (const ep of eps) {
    const json = await requestJson(ep.file, ep.path);
    results.push({ file: ep.file, json });
  }

  // 第二步：校验全部通过后才创建目录并写入（防线 2）
  await mkdir(apiDir, { recursive: true });
  for (const { file, json } of results) {
    await writeFile(path.join(apiDir, file), `${JSON.stringify(json, null, 2)}\n`, 'utf8');
  }

  return { apiDir, slot, files: results.map((r) => r.file), skipped: false };
}

/**
 * 完整一轮采集：加锁 → 幂等检查 + 采集 → 释放锁（所有退出路径都释放）。
 * @returns {Promise<{status: 'collected'|'skipped'|'locked', apiDir?: string, slot?: string, files?: string[]}>}
 */
export async function runCollect({
  dataDir,
  date = today(),
  gameType = DEFAULT_MODE,
  subModeName = null,
  endpoints,
  force = false,
} = {}) {
  const root = resolveRoot(dataDir);
  const lockPath = await acquireLock(root);
  if (!lockPath) return { status: 'locked' };

  try {
    const res = await collectMeta({ dataDir: root, date, gameType, subModeName, endpoints, force });
    return {
      status: res.skipped ? 'skipped' : 'collected',
      apiDir: res.apiDir,
      slot: res.slot,
      files: res.files,
    };
  } finally {
    await releaseLock(lockPath);
  }
}

/**
 * 一键采集：按顺序跑完 MODES 里的每个模式；任一模式熔断/异常/让出锁即停止，
 * 不继续触碰数据源（42000 只允许一次，禁止连环重试）。
 * @returns {Promise<{results: Array<{slot: string, label: string, status: string}>, error?: Error}>}
 */
export async function runCollectAll({ dataDir, date = today(), modes = MODES, force = false } = {}) {
  const results = [];
  for (const m of modes) {
    const slot = slotKey(m.gameType, m.subModeName);
    try {
      const r = await runCollect({ dataDir, date, gameType: m.gameType, subModeName: m.subModeName, force });
      results.push({ slot, label: modeLabel(slot), status: r.status });
      if (r.status === 'locked') break; // 已有采集进程在跑，让出
    } catch (err) {
      return { results, error: err }; // 熔断/异常：立即中止后续模式
    }
  }
  return { results };
}

// CLI：--mode 槽位名 → {gameType, subModeName}；非法返回 null
function modeFromId(id) {
  if (id === '2') return { gameType: '2', subModeName: null };
  if (id === '4') return { gameType: '4', subModeName: null };
  const m = /^4-(.+)$/.exec(id);
  if (m && SUB_MODES.includes(m[1]) && m[1] !== NO_SUB_MODE) return { gameType: '4', subModeName: m[1] };
  return null;
}

function parseModeArg(argv) {
  const i = argv.indexOf('--mode');
  const v = i >= 0 ? argv[i + 1] : undefined;
  return (v ?? DEFAULT_MODE).trim();
}

function reportFatal(err) {
  if (err instanceof ThrottledError) {
    console.error(`[fatal] ${err.message}`);
    console.error('已熔断：本轮未写入任何文件。请数小时后再手动重试，切勿反复试探。');
  } else {
    console.error(`[fatal] ${err.message}`);
    console.error('已中止：本轮未写入任何文件（校验通过前不创建目录）。');
  }
  process.exitCode = 1;
}

async function main() {
  const force = process.argv.includes('--force');
  const date = today();

  // 一键采集：按 MODES 顺序跑完所有模式，任一熔断即止
  if (process.argv.includes('--all')) {
    const { results, error } = await runCollectAll({ date, force });
    for (const r of results) {
      const what =
        r.status === 'skipped' ? '快照已存在，跳过重复采集' :
        r.status === 'locked' ? '已有采集进程在运行，本轮让出' :
        '快照已落盘';
      console.log(`[ok] ${date} 「${r.label}」${what}（slot=${r.slot}）`);
    }
    if (error) reportFatal(error);
    return;
  }

  const modeId = parseModeArg(process.argv);
  const mode = modeFromId(modeId);

  if (!mode) {
    const choices = ['2', '4', ...SUB_MODES.filter((s) => s !== NO_SUB_MODE).map((s) => `4-${s}`)];
    console.error(`[fatal] 未知模式：${modeId}（可选：${choices.join(' / ')}）`);
    process.exitCode = 1;
    return;
  }

  const label = modeLabel(slotKey(mode.gameType, mode.subModeName));
  try {
    const r = await runCollect({ date, force, ...mode });
    if (r.status === 'locked') {
      console.log('[skip] 已有采集进程在运行（并发保护），本轮直接退出。');
    } else if (r.status === 'skipped') {
      console.log(`[skip] ${date} 「${label}」快照已存在，跳过重复采集（--force 可强制重采）。`);
    } else {
      console.log(`[ok] ${date} 「${label}」快照已落盘：${path.relative(ROOT, r.apiDir)}`);
      for (const f of r.files) console.log(`  - ${f}`);
    }
  } catch (err) {
    reportFatal(err);
  }
}

// 仅在直接执行本文件时运行采集（被 import 时只导出函数）
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
