// 常驻底稿加载：扫描 data/knowledge/*.md，按文件名前缀数字排序后整体拼接。
//
// 约定（设计文档 §4.2）：用户新增底稿 = 往 knowledge/ 丢一个 md，零代码改动即可生效。

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

// 取文件名前缀数字；无数字前缀者排在最后
function prefixNum(name) {
  const m = /^(\d+)/.exec(name);
  return m ? Number(m[1]) : Number.POSITIVE_INFINITY;
}

export function compareKnowledgeFiles(a, b) {
  const na = prefixNum(a);
  const nb = prefixNum(b);
  if (na !== nb) return na - nb;
  return a.localeCompare(b, 'zh');
}

/**
 * 加载常驻底稿。
 * @param {string} dir knowledge 目录
 * @returns {Promise<{files: string[], text: string}>}
 */
export async function loadKnowledge(dir) {
  let names;
  try {
    names = await readdir(dir);
  } catch {
    return { files: [], text: '' }; // 目录不存在 → 视为无底稿
  }

  const files = names.filter((n) => n.toLowerCase().endsWith('.md')).sort(compareKnowledgeFiles);
  const parts = [];
  for (const f of files) {
    const body = (await readFile(path.join(dir, f), 'utf8')).trim();
    parts.push(`### ${f}\n\n${body}`);
  }
  return { files, text: parts.join('\n\n') };
}
