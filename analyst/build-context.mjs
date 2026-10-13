// M4 分析上下文构建：把榜单快照压缩为结构化上下文（含卡牌库映射 + 常驻底稿注入）。
//
// 用法：node analyst/build-context.mjs [--date YYYY-MM-DD] [--mode <2|4|4-大师场|…>]
// 导出：buildContext({ dataDir, knowledgeDir, date, slot }) →
//       { date, slot, modeLabel, availableDates, snapshotCount, knowledgeFiles, text }
//
// 边界（§9 M4）：本模块只产出上下文，不调用任何 LLM、不生成报告（属 M5）；
//              也不计算与上一份快照的 diff（属 M5）。
// 模式：slot 决定读取 data/meta/<date>/<slot>/api/ 与趋势对比口径（同模式才可比）。

import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadKnowledge } from './load-knowledge.mjs';
import { modeLabel, DEFAULT_MODE } from '../collector/fetch-meta.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const readJson = async (file) => JSON.parse(await readFile(file, 'utf8'));
const pct = (v) => (v == null ? '-' : `${(v * 100).toFixed(1)}%`);
const fix = (v, d = 3) => (v == null ? '-' : Number(v).toFixed(d));

// 列出「该模式」有快照的日期（趋势对比只在同一模式内进行）
async function listSnapshotDates(metaDir, slot) {
  let entries;
  try {
    entries = await readdir(metaDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const dates = entries
    .filter((e) => e.isDirectory() && DATE_RE.test(e.name))
    .map((e) => e.name)
    .sort();

  const out = [];
  for (const d of dates) {
    try {
      if ((await stat(path.join(metaDir, d, slot, 'api'))).isDirectory()) out.push(d);
    } catch {
      // 该日该模式无快照 → 跳过
    }
  }
  return out;
}

// 全局兜底：扫描 meta/<date>/*/api，返回「日期最新」且存在任意模式快照的 { date, slot }
async function findLatestAnySlot(metaDir) {
  let entries;
  try {
    entries = await readdir(metaDir, { withFileTypes: true });
  } catch {
    return null;
  }
  const dates = entries
    .filter((e) => e.isDirectory() && DATE_RE.test(e.name))
    .map((e) => e.name)
    .sort()
    .reverse(); // 最新日期优先

  for (const date of dates) {
    let slots;
    try {
      slots = (await readdir(path.join(metaDir, date), { withFileTypes: true }))
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .sort();
    } catch {
      continue;
    }
    for (const slot of slots) {
      try {
        if ((await stat(path.join(metaDir, date, slot, 'api'))).isDirectory()) return { date, slot };
      } catch {
        // 该槽位无 api 目录 → 跳过
      }
    }
  }
  return null;
}

async function loadCardMap(file) {
  try {
    const items = await readJson(file);
    return new Map(items.map((c) => [String(c.id), c]));
  } catch {
    return new Map(); // 卡牌库缺失时降级为 id 占位
  }
}

function rankingTable(title, rows, limit, resolve) {
  const out = [`### ${title}（Top ${Math.min(limit, rows.length)} / 共 ${rows.length} 行）`];
  out.push('| # | 名称 | 补充 | 场次 | 平均名次 | 登顶率 | 前三率 |');
  out.push('| --- | --- | --- | --- | --- | --- | --- |');
  rows.slice(0, limit).forEach((r, i) => {
    const info = resolve(r);
    out.push(
      `| ${i + 1} | ${info.name} | ${info.extra} | ${r.count ?? '-'} | ` +
        `${fix(r.avgPlacement)} | ${pct(r.firstRate)} | ${pct(r.top3Rate)} |`,
    );
  });
  return out.join('\n');
}

export async function buildContext({ dataDir, knowledgeDir, date, slot = DEFAULT_MODE } = {}) {
  const root = dataDir ? path.resolve(dataDir) : path.join(ROOT, 'data');
  const metaDir = path.join(root, 'meta');
  let actualSlot = slot;
  let label = modeLabel(actualSlot);
  let fallback = null; // 兜底记录：{ requestedSlot, actualSlot }，无兜底时为 null

  let availableDates = await listSnapshotDates(metaDir, actualSlot);
  if (availableDates.length === 0) {
    // 兜底：所选模式无任何快照 → 采用全局「日期最新」的可用快照。
    // 关键：改用快照的真实 slot 读取与标注，绝不把别的模式数据贴上所选模式的标签。
    const latest = await findLatestAnySlot(metaDir);
    if (latest) {
      actualSlot = latest.slot;
      label = modeLabel(actualSlot);
      fallback = { requestedSlot: slot, actualSlot };
      availableDates = await listSnapshotDates(metaDir, actualSlot);
    }
  }
  if (availableDates.length === 0) throw new Error(`未找到任何「${label}」快照：${metaDir}/*/${slot}/api`);

  const target = date ?? availableDates[availableDates.length - 1];
  if (!availableDates.includes(target)) {
    throw new Error(`「${label}」快照不存在：${target}（可用：${availableDates.join(', ')}）`);
  }

  const apiDir = path.join(metaDir, target, actualSlot, 'api');
  const [heroes, commanders, equipment] = await Promise.all([
    readJson(path.join(apiDir, 'heroes.json')),
    readJson(path.join(apiDir, 'commanders.json')),
    readJson(path.join(apiDir, 'equipment.json')),
  ]);

  const heroCards = await loadCardMap(path.join(root, 'cards', 'heroes.json'));
  const equipCards = await loadCardMap(path.join(root, 'cards', 'equipment.json'));
  const knowledge = await loadKnowledge(knowledgeDir ?? path.join(root, 'knowledge'));

  const sections = [];
  sections.push(`# 版本环境上下文（快照 ${target} · ${label}）`);

  sections.push(
    [
      '## 数据口径',
      `- 模式：${label}（gameType=${actualSlot.startsWith('4') ? '4' : actualSlot}）；本上下文仅含该模式数据，勿跨模式混用`,
      fallback ? `- ⚠ 兜底说明：所选模式「${modeLabel(fallback.requestedSlot)}」无任何快照，已自动改用「${label}」的『${target}』快照` : null,
      '- firstRate = 登顶率；top3Rate = 前三率；avgPlacement = 平均名次（6 人局均值 3.50）；avgLevel = 平均等级',
      '- 时间窗：近 7 天（time=7），跟随数据源最新版本（不指定 version）；数据源 api.datatft.com/wzwxq（第三方非官方接口，无 SLA）',
      '- 名称/阵营/阶位来自本地卡牌库（data/cards/），未命中时以 id 占位',
    ]
      .filter(Boolean)
      .join('\n'),
  );

  sections.push(
    rankingTable('英雄榜', heroes.data.rows, 12, (r) => {
      const c = heroCards.get(String(r.id));
      return {
        name: c ? c.name : `id=${r.id}`,
        extra: c ? `${c.faction} / ${c.quality} 阶` : '（卡牌库未命中）',
      };
    }),
  );

  sections.push(
    rankingTable('棋手榜', commanders.data.rows, 6, (r) => ({ name: r.name ?? `id=${r.id}`, extra: '—' })),
  );

  sections.push(
    rankingTable('装备榜', equipment.data.rows, 6, (r) => {
      const c = equipCards.get(String(r.id));
      return { name: c ? c.name : `id=${r.id}`, extra: c ? `${c.quality} 阶` : '（卡牌库未命中）' };
    }),
  );

  sections.push(
    [
      '## 热门阵容',
      '- 数据缺失：本轮快照未采集 lineups/search，阵容维度不可用（缺失声明，勿据此推断阵容强度）',
    ].join('\n'),
  );

  sections.push(
    [
      '## 快照元数据（§4.5 硬规则）',
      `- 可用「${label}」快照：${availableDates.length} 份（${availableDates.join(', ')}）`,
      availableDates.length < 2
        ? '- ⚠ 仅 1 份快照 → 单日数据禁出强度结论，本上下文仅作方向性参考'
        : '- 已具备 ≥2 份快照，可做趋势对比',
      `- 英雄榜总样本量：${heroes.data.base?.count ?? '-'} 场（base.count）`,
    ].join('\n'),
  );

  sections.push(
    ['## 用户方法论（常驻底稿，data/knowledge/）', knowledge.text || '（knowledge/ 为空，未注入任何底稿）'].join(
      '\n\n',
    ),
  );

  return {
    date: target,
    slot: actualSlot,
    modeLabel: label,
    fallback,
    availableDates,
    snapshotCount: availableDates.length,
    knowledgeFiles: knowledge.files,
    text: sections.join('\n\n'),
  };
}

async function main() {
  const di = process.argv.indexOf('--date');
  const date = di >= 0 ? process.argv[di + 1] : undefined;
  const mi = process.argv.indexOf('--mode');
  const slot = mi >= 0 ? process.argv[mi + 1] : undefined;
  try {
    const ctx = await buildContext({ date, slot });
    console.log(ctx.text);
  } catch (err) {
    console.error(`[fatal] ${err.message}`);
    process.exitCode = 1;
  }
}

// 仅在直接执行本文件时打印上下文（被 import 时只导出函数）
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
