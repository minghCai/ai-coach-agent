// 接口客户端：统一请求入口（串行 + 校验）。
//
// 设计文档 §3.2「防线」在此落地：
//   防线 1  串行请求：端点按顺序逐个请求，不并发（调用方保证）；
//   防线 2  只有 code===1 且 data!=null 才算成功，否则抛错（由调用方保证不落盘）；
//   防线 3  遇到 code===42000 抛 BusinessRejectedError：数据源在业务层面拒绝本次请求，
//           调用方立即终止本轮；不自动重试（是否重试由用户手动决定，不做频率限制）。

export const API_BASE = 'https://api.datatft.com/wzwxq';

// 固定礼貌 UA，便于站方识别本工具身份
export const USER_AGENT = 'wxq-coach-agent/0.1 (personal research, on-demand)';

// 数据源业务拒绝：HTTP 200 + body.code === 42000。
// 语义为「服务端明确拒绝这组请求参数」（如参数组合已下线），与 IP 封禁/限流无关；
// 原文照抄服务端 message 以便定位。
export class BusinessRejectedError extends Error {
  constructor(name, serverMessage) {
    const detail = serverMessage ? `：${serverMessage}` : '';
    super(`${name}: 数据源业务拒绝 code=42000${detail}`);
    this.name = 'BusinessRejectedError';
    this.code = 42000;
    this.serverMessage = serverMessage ?? null;
  }
}

// 数据源异常（网络失败 / 非 2xx / 非 JSON / code≠1）
export class ApiError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ApiError';
  }
}

/**
 * 发起一次 GET/POST 请求并完成校验。
 * @param {string} name 端点名（用于错误信息，如 "heroes.json"）
 * @param {string} path 端点路径（以 / 开头，相对 API_BASE）
 * @returns {Promise<object>} 原始响应体（含 code / success / message / data）
 */
export async function requestJson(name, path, { method = 'GET', body } = {}) {
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

  // 防线 3：数据源业务拒绝，交给上层终止本轮
  if (json.code === 42000) throw new BusinessRejectedError(name, json.message);

  // 防线 2：校验不通过一律抛错，绝不把脏数据当成功
  if (json.code !== 1 || json.data == null) {
    const detail = json.message ? ` ${json.message}` : '';
    throw new ApiError(`${name}: 数据源异常 code=${json.code}${detail}`);
  }

  return json;
}
