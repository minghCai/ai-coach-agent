// M6 本地服务：托管 web/ 与 data/（封禁点文件）+ 极简 API。
//
// 安全边界：
//   1. 仅监听 127.0.0.1（私人工具，不对外）。
//   2. 静态托管拒绝一切点文件（任何路径段以 . 开头）→ 挡住 /data/.secrets.json（§5.2）。
//   3. 路径穿越防护：resolve 后必须仍在托管根目录内。
//   4. 不存在任何返回 key 明文的接口；POST /api/secrets 只写不回显。
//   5. 访问日志只记录方法与路径，不记录请求体。

import http from 'node:http';
import { readFile, writeFile, readdir, stat, chmod } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCollectAll, MODES, DEFAULT_MODE, modeLabel } from '../collector/fetch-meta.mjs';
import { generateReport } from '../analyst/generate-report.mjs';
import { loadApiKey } from '../analyst/llm.mjs';
import { ThrottledError } from '../collector/client.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const WEB_DIR = path.join(ROOT, 'web');
export const DATA_DIR = path.join(ROOT, 'data');

const HOST = process.env.HOST ?? '127.0.0.1';
const PORT = Number(process.env.PORT ?? 8787);
const MAX_BODY = 256 * 1024;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// 兜底日志：进程若因未捕获异常退出，服务窗口会留下痕迹
// （否则前端只会看到无信息的 "Failed to fetch"，无从排查）
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection] 未处理的异步错误：', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException] 未捕获异常，服务即将退出：', err);
  process.exit(1);
});

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.md': 'text/markdown; charset=utf-8',
};

const isBlocked = (relPath) => {
  const segs = relPath.split(/[\\/]+/).filter(Boolean);
  if (segs.some((s) => s.startsWith('.'))) return true; // 点文件 / 点目录
  return (segs.at(-1) ?? '').includes('.test.'); // 测试文件不对外
};

const send = (res, code, body, type = 'text/plain; charset=utf-8') => {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(body);
};
const sendJson = (res, code, obj) => send(res, code, JSON.stringify(obj), 'application/json; charset=utf-8');

// 可分析模式白名单（与一键采集的模式一一对应）
const MODE_IDS = MODES.map((m) => m.id);
const MODE_CHOICES = MODES.map((m) => ({ value: m.id, label: m.label }));

async function serveStatic(res, baseDir, relPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(relPath);
  } catch {
    return send(res, 400, 'bad path');
  }
  if (!decoded || decoded.endsWith('/')) decoded += 'index.html';
  if (decoded.includes('\0') || isBlocked(decoded)) return send(res, 403, 'forbidden');

  const target = path.resolve(baseDir, decoded.replace(/^[/\\]+/, ''));
  if (target !== baseDir && !target.startsWith(baseDir + path.sep)) return send(res, 403, 'forbidden');
  if (isBlocked(path.relative(baseDir, target))) return send(res, 403, 'forbidden');

  try {
    if (!(await stat(target)).isFile()) return send(res, 404, 'not found');
    const buf = await readFile(target);
    send(res, 200, buf, MIME[path.extname(target).toLowerCase()] ?? 'application/octet-stream');
  } catch {
    send(res, 404, 'not found');
  }
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > MAX_BODY) throw new Error('请求体过大');
    chunks.push(c);
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error('请求体必须是 JSON');
  }
}

function createApi({ dataDir }) {
  const reportsDir = path.join(dataDir, 'reports');
  const metaDir = path.join(dataDir, 'meta');
  const secretsFile = path.join(dataDir, '.secrets.json');

  const keyConfigured = async () => {
    try {
      await loadApiKey({ dataDir });
      return true;
    } catch {
      return false;
    }
  };

  // 遍历 meta/<date>/<slot>/api：每个「日期 + 模式」是一条独立快照
  const listSnapshots = async () => {
    let dates;
    try {
      dates = (await readdir(metaDir, { withFileTypes: true }))
        .filter((e) => e.isDirectory() && DATE_RE.test(e.name))
        .map((e) => e.name)
        .sort();
    } catch {
      return [];
    }

    const out = [];
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
          if ((await stat(path.join(metaDir, date, slot, 'api'))).isDirectory()) {
            out.push({ date, slot, label: modeLabel(slot) });
          }
        } catch {
          // 该槽位无 api 目录 → 不计入快照
        }
      }
    }
    return out;
  };

  const listReports = async () => {
    try {
      return (await readdir(reportsDir)).filter((n) => n.endsWith('.md')).sort().reverse();
    } catch {
      return [];
    }
  };

  return async function handleApi(req, res, url) {
    const { pathname } = url;

    if (req.method === 'GET' && pathname === '/api/state') {
      return sendJson(res, 200, {
        keyConfigured: await keyConfigured(),
        modes: MODE_CHOICES,
        defaultMode: DEFAULT_MODE,
        snapshots: await listSnapshots(),
        reports: await listReports(),
      });
    }

    // 只看布尔状态：绝不回显 key 明文
    if (req.method === 'GET' && pathname === '/api/secrets/status') {
      return sendJson(res, 200, { keyConfigured: await keyConfigured() });
    }

    if (req.method === 'POST' && pathname === '/api/secrets') {
      const { key } = await readBody(req);
      if (typeof key !== 'string' || !key.trim() || key.includes('\n') || key.length > 500) {
        return sendJson(res, 400, { error: 'key 不合法：应为非空单行字符串' });
      }
      await writeFile(secretsFile, `${JSON.stringify({ deepseekApiKey: key.trim() }, null, 2)}\n`, {
        encoding: 'utf8',
        mode: 0o600,
      });
      await chmod(secretsFile, 0o600).catch(() => {}); // Windows 上为 no-op
      return sendJson(res, 200, { ok: true, keyConfigured: true });
    }

    // 一键采集：固定采集万象大赛 + 钻石狂潮·大师场（不接受模式参数）
    if (req.method === 'POST' && pathname === '/api/collect') {
      const t0 = Date.now();
      const { force = false } = await readBody(req);
      const { results, error } = await runCollectAll({ dataDir, force: Boolean(force) });
      console.log(`[collect] ${results.map((r) => `${r.slot}:${r.status}`).join(' ')} 用时=${Date.now() - t0}ms`);

      if (error) {
        const throttled = error instanceof ThrottledError;
        return sendJson(res, throttled ? 503 : 500, {
          error: throttled
            ? '数据源已触发限流，本轮已熔断（未写入任何文件）。请数小时后再手动重试，切勿反复试探。'
            : String(error?.message ?? error),
          detail: String(error),
          results,
          snapshots: await listSnapshots(),
        });
      }
      return sendJson(res, 200, { results, snapshots: await listSnapshots() });
    }

    if (req.method === 'POST' && pathname === '/api/report') {
      const t0 = Date.now();
      const { angle = '', mode = DEFAULT_MODE } = await readBody(req);
      const slot = String(mode);
      if (!MODE_IDS.includes(slot)) {
        return sendJson(res, 400, { error: `模式不合法，应为 ${MODE_IDS.join(' / ')}` });
      }

      const r = await generateReport({ dataDir, angle: String(angle), slot });
      const fb = r.fallback
        ? `；兜底：所选「${modeLabel(r.fallback.requestedSlot)}」无快照，已改用「${r.modeLabel}」`
        : '';
      console.log(`[report] mode=${r.modeLabel} date=${r.date} prev=${r.previousDate ?? '无'} 用时=${Date.now() - t0}ms${fb}`);
      return sendJson(res, 200, {
        date: r.date,
        slot: r.slot,
        label: r.modeLabel,
        fallback: r.fallback ?? null,
        previousDate: r.previousDate,
        name: path.basename(r.reportPath),
        reports: await listReports(),
        text: r.text,
      });
    }

    if (req.method === 'GET' && pathname === '/api/report') {
      const name = url.searchParams.get('name') ?? '';
      if (name !== path.basename(name) || !name.endsWith('.md') || isBlocked(name)) {
        return sendJson(res, 400, { error: '非法报告名' });
      }
      try {
        return send(res, 200, await readFile(path.join(reportsDir, name), 'utf8'), MIME['.md']);
      } catch {
        return sendJson(res, 404, { error: '报告不存在' });
      }
    }

    return sendJson(res, 404, { error: `未知接口 ${req.method} ${pathname}` });
  };
}

/**
 * 创建服务（不自动监听，便于测试注入临时 dataDir 与随机端口）。
 * @param {object} [options]
 * @param {string} [options.dataDir]
 * @param {string} [options.webDir]
 * @returns {import('node:http').Server}
 */
export function createServer({ dataDir = DATA_DIR, webDir = WEB_DIR } = {}) {
  const handleApi = createApi({ dataDir });

  return http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
    console.log(`${req.method} ${url.pathname}`); // 不打印 body，避免密钥进日志
    try {
      const { pathname } = url;
      if (pathname.startsWith('/api/')) return await handleApi(req, res, url);
      if (pathname === '/data' || pathname.startsWith('/data/')) {
        return await serveStatic(res, dataDir, pathname.slice('/data'.length));
      }
      return await serveStatic(res, webDir, pathname);
    } catch (err) {
      // 完整堆栈打到服务端窗口（前端拿不到 console，只能靠这里留痕）
      console.error(`[error] ${req.method} ${url.pathname}`, err);
      const throttled = err instanceof ThrottledError;
      sendJson(res, throttled ? 503 : 500, {
        error: throttled
          ? '数据源已触发限流，本轮已熔断（未写入任何文件）。请数小时后再手动重试，切勿反复试探。'
          : String(err?.message ?? err),
        detail: String(err),
        stack: err?.stack,
      });
    }
  });
}

function main() {
  createServer().listen(PORT, HOST, () => {
    console.log(`[serve] 万象棋 AI 教练 → http://${HOST}:${PORT}   (Ctrl+C 退出)`);
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
