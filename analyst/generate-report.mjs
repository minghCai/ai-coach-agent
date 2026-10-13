// M5 报告生成主入口。
//
// 用法：node analyst/generate-report.mjs --angle "重装厄斐琉斯这版为什么掉到 T2" [--mode <2|4|4-大师场|…>]
// 落盘：data/reports/<date>-<模式>-<角度>.md；同时写 data/meta/<date>/<slot>/summary.md（§5.1 约定的 diff 摘要）
//
// 边界：不采集数据（只读本地快照）、不生成前端页面。LLM 调用可注入（llmCall），便于无 key 测试。
// 模式：slot 决定读哪一份快照，且趋势 diff 只在同模式内进行。

import { mkdir, readFile, writeFile, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildContext } from './build-context.mjs';
import { streamChat } from './llm.mjs';
import { DEFAULT_MODE } from '../collector/fetch-meta.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROMPT_FILE = path.join(ROOT, 'analyst', 'prompts', 'coach.md');
const DATASETS = [
  ['heroes', '英雄榜'],
  ['commanders', '棋手榜'],
  ['equipment', '装备榜'],
];
const DEFAULT_ANGLE_NAME = '版本环境速览';

const readJson = async (file) => JSON.parse(await readFile(file, 'utf8'));
const pct = (v) => (v == null ? '-' : `${(v * 100).toFixed(1)}%`);

// Windows 文件名非法字符 + 首尾空格/点
function safeAngleName(angle) {
  const base = (angle ?? '').trim() || DEFAULT_ANGLE_NAME;
  return (
    base
      .replace(/[\\/:*?"<>|\r\n\t]+/g, ' ')
      .replace(/\s+/g, ' ')
      .replace(/[. ]+$/, '')
      .trim()
      .slice(0, 40) || DEFAULT_ANGLE_NAME
  );
}

async function loadSnapshot(apiDir) {
  const out = {};
  for (const [key] of DATASETS) {
    out[key] = await readJson(path.join(apiDir, `${key}.json`));
  }
  return out;
}

async function loadCardMap(file) {
  try {
    return new Map((await readJson(file)).map((c) => [String(c.id), c]));
  } catch {
    return new Map();
  }
}

const rankMap = (body) => new Map((body?.data?.rows ?? []).map((r, i) => [String(r.id), { rank: i + 1, row: r }]));

/**
 * 纯函数：两份快照 → 结构化 diff 文本。
 * @param {object} prev 上一份快照（{heroes, commanders, equipment} 的原始响应体）
 * @param {object} curr 当前快照
 * @param {object} [options]
 * @param {number} [options.topN=12] 参与对比的榜单范围
 * @param {(ds: string, id: string, row: object) => string} [options.nameOf] id → 可读名称
 * @returns {string}
 */
export function diffSnapshots(prev, curr, { topN = 12, nameOf = (ds, id, row) => row?.name ?? id } = {}) {
  const keys = DATASETS.map(([k]) => k);
  const frozen = keys.every((k) => JSON.stringify(prev?.[k]) === JSON.stringify(curr?.[k]));
  const lines = [];
  if (frozen) lines.push('- ⚠ 数据源冻结：相邻快照内容完全一致，本段不做强度重估（§4.5）');

  for (const [key, title] of DATASETS) {
    const p = rankMap(prev?.[key]);
    const c = rankMap(curr?.[key]);
    lines.push(`### ${title}（Top ${topN}）`);

    const up = [];
    const down = [];
    const entered = [];
    const left = [];
    const rate = [];

    for (const [id, cur] of c) {
      if (cur.rank > topN) continue;
      const old = p.get(id);
      const name = nameOf(key, id, cur.row);
      if (!old) {
        entered.push(name);
        continue;
      }
      const dRank = old.rank - cur.rank; // 正数 = 上升
      if (dRank > 0) up.push(`${name} ↑${dRank}（${old.rank}→${cur.rank}）`);
      else if (dRank < 0) down.push(`${name} ↓${-dRank}（${old.rank}→${cur.rank}）`);

      const dFirst = (cur.row.firstRate ?? 0) - (old.row.firstRate ?? 0);
      if (Math.abs(dFirst) >= 0.01) {
        rate.push(`${name} ${pct(old.row.firstRate)} → ${pct(cur.row.firstRate)}（${dFirst > 0 ? '+' : ''}${(dFirst * 100).toFixed(1)}pp）`);
      }
    }
    for (const [id, old] of p) {
      if (old.rank > topN) continue;
      if (!c.has(id) || c.get(id).rank > topN) left.push(nameOf(key, id, old.row));
    }

    if (up.length) lines.push(`- 名次上升：${up.join('；')}`);
    if (down.length) lines.push(`- 名次下降：${down.join('；')}`);
    if (entered.length) lines.push(`- 新进入 Top ${topN}：${entered.join('、')}`);
    if (left.length) lines.push(`- 掉出 Top ${topN}：${left.join('、')}`);
    if (rate.length) lines.push(`- 登顶率变化 ≥1pp：${rate.join('；')}`);
    if (!up.length && !down.length && !entered.length && !left.length && !rate.length) {
      lines.push('- 无显著变化（Top 榜内名次与登顶率均未变）');
    }
  }

  return lines.join('\n');
}

function buildUserMessage(angleText, contextText, diffText) {
  return [
    `## 本次分析角度\n${angleText}`,
    `## 可用数据（唯一事实源，禁止引用此段之外的任何数值）\n${contextText}`,
    `## 版本变化（与上一份快照的 diff）\n${diffText}`,
  ].join('\n\n');
}

/**
 * 生成一份分析报告。
 * @param {object} [options]
 * @param {string} [options.angle] 本次分析角度；为空则退化为「版本环境速览」
 * @param {string} [options.dataDir]
 * @param {string} [options.knowledgeDir]
 * @param {string} [options.date] 快照日期，默认最新
 * @param {string} [options.slot] 模式槽位（'2' 万象大赛 / '4' 或 '4-大师场' 等），默认 '2'
 * @param {Function} [options.llmCall] LLM 调用函数（测试注入 mock）；默认 DeepSeek 流式客户端
 * @param {(d: string) => void} [options.onDelta]
 * @returns {Promise<object>}
 */
export async function generateReport({ angle = '', dataDir, knowledgeDir, date, slot = DEFAULT_MODE, llmCall, onDelta } = {}) {
  const root = dataDir ? path.resolve(dataDir) : path.join(ROOT, 'data');
  const ctx = await buildContext({ dataDir: root, knowledgeDir, date, slot });

  const idx = ctx.availableDates.indexOf(ctx.date);
  const previousDate = idx > 0 ? ctx.availableDates[idx - 1] : null;

  const curr = await loadSnapshot(path.join(root, 'meta', ctx.date, ctx.slot, 'api'));
  const prev = previousDate ? await loadSnapshot(path.join(root, 'meta', previousDate, ctx.slot, 'api')) : null;

  const heroCards = await loadCardMap(path.join(root, 'cards', 'heroes.json'));
  const equipCards = await loadCardMap(path.join(root, 'cards', 'equipment.json'));
  const nameOf = (ds, id, row) => {
    if (ds === 'heroes') return heroCards.get(String(id))?.name ?? row?.name ?? `id=${id}`;
    if (ds === 'equipment') return equipCards.get(String(id))?.name ?? row?.name ?? `id=${id}`;
    return row?.name ?? `id=${id}`;
  };

  const diffText = prev
    ? diffSnapshots(prev, curr, { nameOf })
    : `无上一份「${ctx.modeLabel}」快照（当前仅 ${ctx.availableDates.length} 份：${ctx.date}）。依 §4.5「单日数据禁出结论」，本轮不做趋势对比，仅可给方向性参考。`;

  // §5.1：diff 摘要由分析层写入 meta/<date>/<slot>/summary.md（与报告一同落盘，失败则不写）
  const summaryPath = path.join(root, 'meta', ctx.date, ctx.slot, 'summary.md');

  const angleText =
    (angle ?? '').trim() ||
    '（未指定分析角度）本轮退化为「版本环境速览」：概览当前版本环境，给出 3 条方向性观察，不下强度结论。';

  const system = await readFile(PROMPT_FILE, 'utf8');
  const messages = [
    { role: 'system', content: system },
    { role: 'user', content: buildUserMessage(angleText, ctx.text, diffText) },
  ];

  const call = llmCall ?? ((opts) => streamChat({ ...opts, dataDir: root }));
  const text = await call({ messages, temperature: 0.3, onDelta });

  const reportPath = path.join(root, 'reports', `${ctx.date}-${ctx.modeLabel}-${safeAngleName(angle)}.md`);
  await mkdir(path.dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${text.trim()}\n`, 'utf8');

  await writeFile(
    summaryPath,
    `# 版本变化摘要（${ctx.date} · ${ctx.modeLabel}，对比 ${previousDate ?? '无'}）\n\n${diffText}\n`,
    'utf8',
  );

  return {
    date: ctx.date,
    slot: ctx.slot,
    modeLabel: ctx.modeLabel,
    fallback: ctx.fallback,
    previousDate,
    angle: angle ?? '',
    reportPath,
    summaryPath,
    text,
  };
}

function parseArg(argv, name) {
  const i = argv.indexOf(name);
  if (i >= 0) return argv[i + 1] ?? '';
  const eq = argv.find((a) => a.startsWith(`${name}=`));
  return eq ? eq.slice(name.length + 1) : '';
}

async function main() {
  const angle = parseArg(process.argv, '--angle');
  const slot = parseArg(process.argv, '--mode') || DEFAULT_MODE;
  try {
    const r = await generateReport({ angle, slot, onDelta: (d) => process.stdout.write(d) });
    process.stdout.write('\n');
    console.log(`[ok] 模式：${r.modeLabel}（slot=${r.slot}）`);
    console.log(`[ok] 报告：${path.relative(ROOT, r.reportPath)}`);
    console.log(`[ok] 版本变化摘要：${path.relative(ROOT, r.summaryPath)}`);
  } catch (err) {
    console.error(`\n[fatal] ${err.message}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
