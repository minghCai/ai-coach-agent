// DeepSeek（OpenAI 兼容）客户端。
//
// 安全约定（§5.2）：API key 只从环境变量或 data/.secrets.json 读取，
// 绝不写入报告 / 日志 / 接口响应，绝不出现在任何报错文本里。

import { readFile } from 'node:fs/promises';
import path from 'node:path';

export const DEFAULT_BASE_URL = 'https://api.deepseek.com';
export const DEFAULT_MODEL = 'deepseek-chat';

/**
 * 解析 API key：环境变量 > 指定的 secrets 文件。
 * @param {object} [options]
 * @param {string} [options.dataDir] 数据根目录（取其下 .secrets.json）
 * @param {string} [options.secretsPath] 显式指定 secrets 文件路径
 * @returns {Promise<string>}
 */
export async function loadApiKey({ dataDir, secretsPath } = {}) {
  const fromEnv = process.env.DEEPSEEK_API_KEY;
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();

  const file = secretsPath ?? (dataDir ? path.join(dataDir, '.secrets.json') : null);
  if (file) {
    try {
      const secrets = JSON.parse(await readFile(file, 'utf8'));
      const key = secrets.deepseekApiKey ?? secrets.DEEPSEEK_API_KEY ?? secrets.apiKey;
      if (key && String(key).trim()) return String(key).trim();
    } catch {
      // 文件不存在 / 非 JSON → 视为未配置，落到下面的报错
    }
  }

  throw new Error(
    '未找到 DeepSeek API key：请设置环境变量 DEEPSEEK_API_KEY，' +
      '或写入 data/.secrets.json（{"deepseekApiKey":"sk-..."}，该文件已在 .gitignore 中）',
  );
}

/**
 * 流式调用 DeepSeek /chat/completions，返回完整文本。
 * @param {object} options
 * @param {Array<{role: string, content: string}>} options.messages
 * @param {number} [options.temperature=0.3]
 * @param {string} [options.model]
 * @param {string} [options.baseUrl]
 * @param {string} [options.dataDir]
 * @param {string} [options.secretsPath]
 * @param {(delta: string) => void} [options.onDelta] 增量回调（用于 CLI 实时打印）
 * @param {typeof fetch} [options.fetchImpl]
 * @returns {Promise<string>}
 */
export async function streamChat({
  messages,
  temperature = 0.3,
  model = DEFAULT_MODEL,
  baseUrl = process.env.DEEPSEEK_BASE_URL ?? DEFAULT_BASE_URL,
  dataDir,
  secretsPath,
  onDelta,
  signal,
  fetchImpl = fetch,
} = {}) {
  const apiKey = await loadApiKey({ dataDir, secretsPath });

  const res = await fetchImpl(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model, messages, temperature, stream: true }),
    signal,
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`DeepSeek 调用失败：HTTP ${res.status} ${body.slice(0, 300)}`);
  }

  if (!res.body) return '';

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let out = '';

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });

    const lines = buf.split('\n');
    buf = lines.pop() ?? ''; // 末行可能不完整，留到下一轮

    for (const line of lines) {
      const s = line.trim();
      if (!s.startsWith('data:')) continue;
      const payload = s.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;

      let json;
      try {
        json = JSON.parse(payload);
      } catch {
        continue; // 忽略无法解析的 SSE 片段
      }
      const delta = json.choices?.[0]?.delta?.content;
      if (delta) {
        out += delta;
        onDelta?.(delta);
      }
    }
  }

  return out;
}
