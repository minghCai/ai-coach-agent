// 接口客户端：统一请求入口（限速 + 校验 + 熔断）
//
// 设计文档 §3.2「四道防线」在此落地：
//   防线 1  串行请求，相邻请求间隔 ≥500ms（叠加 0–1000ms 随机抖动）；
//   防线 2  只有 code===1 且 data!=null 才算成功，否则抛错（由调用方保证不落盘）；
//   防线 3  遇到 code===42000 立即抛 ThrottledError，调用方须熔断、不得重试。

export const API_BASE = 'https://api.datatft.com/wzwxq';

// 固定礼貌 UA，便于站方识别本工具身份
export const USER_AGENT = 'wxq-coach-agent/0.1 (personal research, on-demand)';

// 最小请求间隔（毫秒）——限速是速率问题，宁可慢不可快
export const MIN_INTERVAL_MS = 500;

// 应用层软限流：HTTP 200 + body.code === 42000，故意的假成功体
export class ThrottledError extends Error {
  constructor(name) {
    super(`${name}: 命中限流 code=42000，本轮已熔断且不会重试`);
    this.name = 'ThrottledError';
    this.code = 42000;
  }
}

// 数据源异常（网络失败 / 非 2xx / 非 JSON / code≠1）
export class ApiError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ApiError';
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 防线 1：每次请求前统一等待，保证串行请求之间的间隔 ≥ MIN_INTERVAL_MS
async function throttle() {
  await sleep(MIN_INTERVAL_MS + Math.random() * 1000);
}

/**
 * 发起一次 GET/POST 请求并完成校验。
 * @param {string} name 端点名（用于错误信息，如 "heroes.json"）
 * @param {string} path 端点路径（以 / 开头，相对 API_BASE）
 * @returns {Promise<object>} 原始响应体（含 code / success / message / data）
 */
export async function requestJson(name, path, { method = 'GET', body } = {}) {
  await throttle();

  const url = path.startsWith('http') ? path : `${API_BASE}${path}`;
  const headers = {
    'User-Agent': USER_AGENT,
    'Accept-Language': 'zh-CN,zh;q=0.9',
  };
  if (body != null) headers['Content-Type'] = 'application/json';

  let res;
  try {
    res = await fetch(url, {
      method,
      headers,
      ...(body != null ? { body: JSON.stringify(body) } : {}),
    });
  } catch (err) {
    throw new ApiError(`${name}: 网络请求失败 ${err.message}`);
  }

  if (!res.ok) throw new ApiError(`${name}: HTTP ${res.status}`);

  let json;
  try {
    json = JSON.parse(await res.text());
  } catch {
    throw new ApiError(`${name}: 响应不是合法 JSON`);
  }

  // 防线 3：熔断信号，交给上层终止本轮
  if (json.code === 42000) throw new ThrottledError(name);

  // 防线 2：校验不通过一律抛错，绝不把脏数据当成功
  if (json.code !== 1 || json.data == null) {
    const detail = json.message ? ` ${json.message}` : '';
    throw new ApiError(`${name}: 数据源异常 code=${json.code}${detail}`);
  }

  return json;
}