// M6 验收测试：真实起一个 HTTP 服务（随机端口 + 临时 dataDir），验证托管、接口与密钥不泄漏。
//
// 关键断言：页面源码与任何接口响应中都不出现 key 明文；/data/.secrets.json 恒被拒绝。

import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

const { createServer } = await import('./serve.mjs');
// 预置快照的阵容分页数必须与采集端一致
const { LINEUP_PAGES } = await import('../collector/fetch-meta.mjs');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'm6-'));
const today = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

// 预置今日有效快照 → 采集接口走幂等分支，测试不会真的发出网络请求
function seedSnapshot(root, date, slot = '2') {
  const apiDir = path.join(root, 'meta', date, slot, 'api');
  fs.mkdirSync(apiDir, { recursive: true });
  const wrap = (rows) => ({ code: 1, success: true, message: '', data: { base: { count: 1 }, rows } });
  fs.writeFileSync(path.join(apiDir, 'heroes.json'), JSON.stringify(wrap([])), 'utf8');
  fs.writeFileSync(path.join(apiDir, 'commanders.json'), JSON.stringify(wrap([])), 'utf8');
  fs.writeFileSync(path.join(apiDir, 'equipment.json'), JSON.stringify(wrap([])), 'utf8');
  const lineups = { code: 1, success: true, message: '', data: { sampleCount: 1, total: 0, lineups: [] } };
  for (let p = 1; p <= LINEUP_PAGES; p++) {
    fs.writeFileSync(path.join(apiDir, `lineups-${p}.json`), JSON.stringify(lineups), 'utf8');
  }
}

async function withServer(run) {
  const root = tmp();
  // 预置今日两种模式的快照 → 一键采集两个模式都走幂等分支，测试不发任何网络请求
  seedSnapshot(root, today(), '2');
  seedSnapshot(root, today(), '4-大师场');
  fs.mkdirSync(path.join(root, 'reports'), { recursive: true });
  fs.writeFileSync(path.join(root, 'reports', '2026-10-13-测试.md'), '# 标题\n\n- 条目', 'utf8');

  const server = createServer({ dataDir: root });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const saved = process.env.DEEPSEEK_API_KEY;
  delete process.env.DEEPSEEK_API_KEY; // 隔离本机环境，确保走「未配置」分支
  try {
    await run({ base, root });
  } finally {
    if (saved !== undefined) process.env.DEEPSEEK_API_KEY = saved;
    await new Promise((r) => server.close(r));
  }
}

test('静态托管：/ 返回单页', async () => {
  await withServer(async ({ base }) => {
    const res = await fetch(`${base}/`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/html/);
    assert.match(await res.text(), /万象棋 AI 教练/);
  });
});

test('禁止访问点文件：/data/.secrets.json 恒被拒绝', async () => {
  await withServer(async ({ base, root }) => {
    fs.writeFileSync(path.join(root, '.secrets.json'), '{"deepseekApiKey":"sk-LEAK-ME"}', 'utf8');

    for (const p of ['/data/.secrets.json', '/data/%2e%2e/.secrets.json', '/data/subdir/../.secrets.json', '/.secrets.json']) {
      const res = await fetch(`${base}${p}`);
      assert.ok(res.status === 403 || res.status === 404, `${p} 应被拒绝，实际 ${res.status}`);
      assert.ok(!(await res.text()).includes('sk-LEAK-ME'), `${p} 不得返回密钥`);
    }
  });
});

test('GET /api/state：返回状态，且不含密钥明文', async () => {
  await withServer(async ({ base }) => {
    const res = await fetch(`${base}/api/state`);
    const data = await res.json();
    assert.equal(res.status, 200);
    assert.equal(data.keyConfigured, false);
    assert.deepEqual(data.reports, ['2026-10-13-测试.md']);
    assert.ok(data.snapshots.some((s) => s.date === today() && s.slot === '2'));
    assert.ok(data.snapshots.some((s) => s.date === today() && s.slot === '4-大师场'));
    assert.deepEqual(data.modes, [
      { value: '2', label: '万象大赛' },
      { value: '4-大师场', label: '钻石狂潮' },
    ]);
    assert.equal(data.defaultMode, '2');
  });
});

test('POST /api/secrets：写入后只回布尔状态，前端读不回明文', async () => {
  await withServer(async ({ base, root }) => {
    const SECRET = 'sk-test-DO-NOT-LEAK-123';
    const res = await fetch(`${base}/api/secrets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: SECRET }),
    });
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.keyConfigured, true);
    assert.ok(!JSON.stringify(body).includes(SECRET), '接口不得回显 key');
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, '.secrets.json'), 'utf8')).deepseekApiKey, SECRET);

    for (const p of ['/api/state', '/api/secrets/status', '/']) {
      const r = await fetch(`${base}${p}`);
      assert.ok(!(await r.text()).includes(SECRET), `${p} 不得含 key 明文`);
    }
    assert.equal((await fetch(`${base}/data/.secrets.json`)).status, 403);
  });
});

test('POST /api/secrets：非法 key 被拒', async () => {
  await withServer(async ({ base }) => {
    const res = await fetch(`${base}/api/secrets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'bad\nkey' }),
    });
    assert.equal(res.status, 400);
  });
});

test('POST /api/collect：一键采集命中幂等 → 0 网络请求，且返回结构化结果', async () => {
  await withServer(async ({ base }) => {
    const res = await fetch(`${base}/api/collect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const data = await res.json();
    assert.equal(res.status, 200);
    assert.equal(data.error, null);
    assert.deepEqual(
      data.results.map((r) => `${r.slot}:${r.status}`),
      ['2:skipped', '4-大师场:skipped'],
    );
    assert.deepEqual(
      data.results.map((r) => r.label),
      ['万象大赛', '钻石狂潮'],
    );
    assert.ok(data.snapshots.some((s) => s.slot === '4-大师场'));
  });
});

test('GET /api/report：读取历史报告；非法名被拒', async () => {
  await withServer(async ({ base }) => {
    const ok = await fetch(`${base}/api/report?name=${encodeURIComponent('2026-10-13-测试.md')}`);
    assert.equal(ok.status, 200);
    assert.match(await ok.text(), /# 标题/);

    for (const name of ['../.secrets.json', '.secrets.json', 'a.txt']) {
      assert.equal((await fetch(`${base}/api/report?name=${encodeURIComponent(name)}`)).status, 400, name);
    }
  });
});

test('POST /api/report：未配置 key 时返回明确错误且不泄漏', async () => {
  await withServer(async ({ base }) => {
    const res = await fetch(`${base}/api/report`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ angle: '测试角度' }),
    });
    const data = await res.json();
    assert.equal(res.status, 500);
    assert.match(data.error, /DeepSeek API key/);
  });
});

test('POST /api/report：非法模式返回 400', async () => {
  await withServer(async ({ base }) => {
    const res = await fetch(`${base}/api/report`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ angle: 'x', mode: '4' }),
    });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /模式不合法/);
  });
});

test('未知接口返回 404 JSON', async () => {
  await withServer(async ({ base }) => {
    const res = await fetch(`${base}/api/nope`);
    assert.equal(res.status, 404);
    assert.ok((await res.json()).error);
  });
});
