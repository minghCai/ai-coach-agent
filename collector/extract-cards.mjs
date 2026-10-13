// M2 卡牌库提取（低频）：从 www.datawxq.com 的 seo chunk 内嵌数据中提取 id→名称映射。
//
// 手动执行：node collector/extract-cards.mjs
// 落盘位置：data/cards/{heroes,commanders,equipment,talents,factions}.json
//
// 说明（设计文档 §3.3）：
//   · 卡牌资料打包在 SPA 的 /assets/seo-*.js 模块内（构建产物，文件名带哈希，故需动态发现）；
//   · 该模块内含多个顶层数组字面量，按记录的 type 字段可区分英雄 / 装备 / 天赋等；
//   · 只有版本更新时重跑，与按需采集解耦。
//
// 安全：内嵌数组是 JS 对象字面量（键无引号、含 !0/!1），本模块用「字面量→JSON」转换器解析，
//       不使用 eval / new Function，避免执行远端代码。

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { USER_AGENT } from './client.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SITE = 'https://www.datawxq.com';

// 本工具自身的礼貌间隔（卡牌库提取低频、与按需采集解耦），不约束采集入口的手动频率
const MIN_INTERVAL_MS = 500;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function getText(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, 'Accept-Language': 'zh-CN,zh;q=0.9' },
  });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.text();
}

// 发现 seo chunk：首页 → 入口 bundle → 其中的 assets/seo-*.js
async function discoverSeoChunk() {
  const home = await getText(`${SITE}/`);
  const entry = home.match(/src="(\/assets\/index-[A-Za-z0-9_-]+\.js)"/);
  if (!entry) throw new Error('未在首页找到入口 bundle（/assets/index-*.js）');

  await sleep(MIN_INTERVAL_MS + Math.random() * 1000);
  const indexJs = await getText(SITE + entry[1]);
  const seo = [...indexJs.matchAll(/assets\/(seo-[A-Za-z0-9_-]+\.js)/g)].map((m) => m[1])[0];
  if (!seo) throw new Error('未在入口 bundle 中找到 seo chunk（assets/seo-*.js）');

  return { file: seo, url: `${SITE}/assets/${seo}` };
}

// 从文本中找出与 start 处 '[' 配对的数组字面量（跳过字符串）
function sliceArray(text, bracketStart) {
  let depth = 0;
  let inStr = null;
  let esc = false;
  for (let i = bracketStart; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === inStr) inStr = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') inStr = c;
    else if (c === '[') depth++;
    else if (c === ']' && --depth === 0) return text.slice(bracketStart, i + 1);
  }
  throw new Error('数组字面量未闭合');
}

// JS 对象字面量 → JSON：为无引号键补引号，转换 !0/!1
function literalToJson(src) {
  let out = '';
  let inStr = false;
  let quote = '';
  let esc = false;
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (inStr) {
      if (esc) { out += c; esc = false; i++; continue; }
      if (c === '\\') { out += c; esc = true; i++; continue; }
      if (c === quote) { out += '"'; inStr = false; i++; continue; }
      out += c === '"' ? '\\"' : c;
      i++;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; inStr = true; out += '"'; i++; continue; }
    if (c === '!') {
      if (src[i + 1] === '0') { out += 'true'; i += 2; continue; }
      if (src[i + 1] === '1') { out += 'false'; i += 2; continue; }
    }
    if (c === '-' || (c >= '0' && c <= '9')) {
      const num = /^-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(src.slice(i));
      if (num) { out += num[0]; i += num[0].length; continue; }
    }
    const id = /^[A-Za-z_$][\w$]*/.exec(src.slice(i));
    if (id) {
      const word = id[0];
      const next = src.slice(i + word.length).replace(/^\s*/, '')[0];
      if (next === ':') { out += `"${word}"`; i += word.length; continue; }
      if (word === 'true' || word === 'false' || word === 'null') { out += word; i += word.length; continue; }
      if (word === 'undefined') { out += 'null'; i += word.length; continue; }
      throw new Error(`无法解析的字面量标识符: ${word}`);
    }
    out += c;
    i++;
  }
  return JSON.parse(out);
}

// 提取模块内全部顶层数据数组（形如 `xxx=[{id:`）
function extractArrays(text) {
  const items = [];
  for (const m of text.matchAll(/[A-Za-z_$][\w$]*\s*=\s*\[\{id:/g)) {
    const bracket = text.indexOf('[', m.index);
    const arr = literalToJson(sliceArray(text, bracket));
    if (Array.isArray(arr)) items.push(...arr);
  }
  return items;
}

const str = (v) => (v == null ? '' : String(v));

/**
 * 提取并落盘卡牌库。
 * @param {object} [options]
 * @param {string} [options.dataDir] 数据根目录，默认 <repo>/data
 * @returns {Promise<{dir: string, counts: Record<string, number>, seoFile: string}>}
 */
export async function extractCards({ dataDir } = {}) {
  const root = dataDir ? path.resolve(dataDir) : path.join(ROOT, 'data');
  const dir = path.join(root, 'cards');

  const { file: seoFile, url } = await discoverSeoChunk();
  await sleep(MIN_INTERVAL_MS + Math.random() * 1000);
  const all = extractArrays(await getText(url));

  const source = `datawxq.com/assets/${seoFile}`;
  const wrap = (id, name, extra) => ({ id: str(id), name: str(name), ...extra, source, verified: true });

  const heroes = [];
  const equipment = [];
  const talents = [];
  const commanders = [];
  const factions = new Map();

  for (const d of all) {
    if (d.type === 'hero') {
      heroes.push(wrap(d.id, d.name, { faction: str(d.relationName), quality: d.quality }));
      if (d.relationId != null && !factions.has(str(d.relationId))) {
        factions.set(str(d.relationId), wrap(d.relationId, d.relationName, {}));
      }
    } else if (d.type === 'equipment') {
      equipment.push(wrap(d.id, d.name, { quality: d.quality }));
    } else if (d.type === 'talent') {
      talents.push(wrap(d.id, d.name, { quality: d.quality }));
    } else if (d.type == null && d.lordId != null) {
      commanders.push(wrap(d.id, d.name, { lordId: d.lordId }));
    }
  }

  const files = {
    'heroes.json': heroes,
    'commanders.json': commanders,
    'equipment.json': equipment,
    'talents.json': talents,
    'factions.json': [...factions.values()],
  };
  if (Object.values(files).every((v) => v.length === 0)) {
    throw new Error('未提取到任何卡牌数据（seo chunk 结构可能已变）');
  }

  await mkdir(dir, { recursive: true });
  const counts = {};
  for (const [name, list] of Object.entries(files)) {
    await writeFile(path.join(dir, name), `${JSON.stringify(list, null, 2)}\n`, 'utf8');
    counts[name.replace('.json', '')] = list.length;
  }

  return { dir, counts, seoFile };
}

async function main() {
  try {
    const { dir, counts, seoFile } = await extractCards();
    console.log(`[ok] 卡牌库已提取（来源 assets/${seoFile}）→ ${path.relative(ROOT, dir)}`);
    for (const [k, v] of Object.entries(counts)) console.log(`  - ${k}.json: ${v} 条`);
  } catch (err) {
    console.error(`[fatal] ${err.message}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
