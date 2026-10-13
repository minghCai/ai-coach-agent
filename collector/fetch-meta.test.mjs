// M1 自动化验收测试（node --test collector/）
//
// 拦截网络（globalThis.fetch），落盘则真实写到系统临时目录，
// 用例结束后直接断言文件系统状态 —— 以此验证硬约束：
//   「业务拒绝（42000）不落盘、不留空壳目录」。
// 测试完全离线，不会触碰真实数据源。

import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

// mock 状态必须以全局量形式在 import 被测模块之前就绪
globalThis.__FETCH_MOCK__ = null;

// 拦截 fetch（client.mjs 调用的是裸 fetch → globalThis.fetch）
globalThis.fetch = async (url) => globalThis.__FETCH_MOCK__(url);

const {
  collectMeta,
  runCollect,
  runCollectAll,
  acquireLock,
  releaseLock,
  hasValidSnapshot,
  buildEndpoints,
  slotKey,
  modeLabel,
  MODES,
} = await import('./fetch-meta.mjs');
const { BusinessRejectedError, ApiError } = await import('./client.mjs');

const okBody = (id) => ({ code: 1, success: true, message: '', data: { id } });

function makeFetchMock(handler) {
  const calls = [];
  globalThis.__FETCH_MOCK__ = async (url) => {
    calls.push({ url: String(url), t: Date.now() });
    const { status = 200, body } = handler(String(url), calls.length - 1);
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    };
  };
  return calls;
}

const tmpDataDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'm1-'));

const EPS = [
  { file: 'heroes.json', path: '/rankings/heroes' },
  { file: 'commanders.json', path: '/rankings/commanders' },
  { file: 'equipment.json', path: '/rankings/equipment' },
];

test('正常路径：3 个端点全部落盘，含 code/message/data', async () => {
  const dir = tmpDataDir();
  makeFetchMock(() => ({ body: okBody('x') }));

  const { files } = await collectMeta({ dataDir: dir, date: '2026-10-13', endpoints: EPS });

  assert.equal(files.length, 3);
  const apiDir = path.join(dir, 'meta', '2026-10-13', '2', 'api');
  for (const f of ['heroes.json', 'commanders.json', 'equipment.json']) {
    const raw = JSON.parse(fs.readFileSync(path.join(apiDir, f), 'utf8'));
    assert.equal(raw.code, 1);
    assert.equal(raw.success, true);
    assert.notEqual(raw.data, null);
  }
});

// ---------- 模式（gameType / subModeName） ----------

test('buildEndpoints：显式带 gameType；仅钻石狂潮具体场次追加 subModeName', () => {
  const wz = buildEndpoints('2');
  assert.ok(wz.every((e) => e.path.includes('gameType=2') && !e.path.includes('subModeName')));

  const zsAny = buildEndpoints('4', '不限');
  assert.ok(zsAny.every((e) => e.path.includes('gameType=4') && !e.path.includes('subModeName')));

  const zsMaster = buildEndpoints('4', '大师场');
  assert.ok(
    zsMaster.every(
      (e) => e.path.includes('gameType=4') && e.path.includes(`subModeName=${encodeURIComponent('大师场')}`),
    ),
  );

  // 刻意不带 version：写死旧版本 v1 会让钻石狂潮恒返回 42000
  assert.ok([...wz, ...zsAny, ...zsMaster].every((e) => !e.path.includes('version=')));
});

test('slotKey / modeLabel：模式 ↔ 槽位 ↔ 可读名', () => {
  assert.equal(slotKey('2'), '2');
  assert.equal(slotKey('4', '不限'), '4');
  assert.equal(slotKey('4', ''), '4');
  assert.equal(slotKey('4', '大师场'), '4-大师场');
  assert.equal(modeLabel('2'), '万象大赛');
  assert.equal(modeLabel('4'), '钻石狂潮·不限');
  assert.equal(modeLabel('4-标准场'), '钻石狂潮·标准场');
  // MODES 中钻石狂潮只认大师场，标签简化为「钻石狂潮」
  assert.equal(modeLabel('4-大师场'), '钻石狂潮');
});

test('一键采集：按 MODES 顺序采集两种模式', async () => {
  const dir = tmpDataDir();
  const calls = makeFetchMock(() => ({ body: okBody('x') }));

  const { results } = await runCollectAll({ dataDir: dir, date: '2026-10-13' });

  assert.deepEqual(
    results.map((r) => r.slot),
    MODES.map((m) => m.id),
  );
  assert.deepEqual(results.map((r) => r.label), ['万象大赛', '钻石狂潮']);
  assert.ok(results.every((r) => r.status === 'collected'));
  assert.equal(calls.length, 6, 'MODES 模式数 × 3 端点');
  assert.equal(calls.filter((c) => c.url.includes('gameType=4')).length, 3);
  assert.ok(fs.existsSync(path.join(dir, 'meta', '2026-10-13', '2', 'api', 'heroes.json')));
  assert.ok(fs.existsSync(path.join(dir, 'meta', '2026-10-13', '4-大师场', 'api', 'heroes.json')));
});

test('一键采集：模式被业务拒绝时记为失败并立即停止', async () => {
  const dir = tmpDataDir();
  const calls = makeFetchMock(() => ({ body: { code: 42000, message: '参数错误' } }));

  const { results, error } = await runCollectAll({ dataDir: dir, date: '2026-10-13' });

  assert.equal(calls.length, 1, '只应发起第 1 个请求后停止');
  assert.equal(results.length, 1);
  assert.equal(results[0].status, 'rejected');
  assert.equal(results[0].slot, '2');
  assert.match(results[0].message, /业务拒绝 code=42000/);
  assert.ok(error instanceof BusinessRejectedError);
  assert.equal(fs.readdirSync(dir).length, 0);
});

test('落盘分槽：钻石狂潮具体场次写入 meta/<date>/4-大师场/api', async () => {
  const dir = tmpDataDir();
  makeFetchMock(() => ({ body: okBody('x') }));

  const { apiDir, slot } = await collectMeta({
    dataDir: dir,
    date: '2026-10-13',
    gameType: '4',
    subModeName: '大师场',
  });

  assert.equal(slot, '4-大师场');
  assert.ok(apiDir.replace(/\\/g, '/').endsWith('/meta/2026-10-13/4-大师场/api'));
  assert.ok(fs.existsSync(path.join(dir, 'meta', '2026-10-13', '4-大师场', 'api', 'heroes.json')));
});

test('模式互不覆盖：同日两种模式各占独立槽位', async () => {
  const dir = tmpDataDir();
  const writeSlot = (slot) => {
    const apiDir = path.join(dir, 'meta', '2026-10-13', slot, 'api');
    fs.mkdirSync(apiDir, { recursive: true });
    for (const ep of EPS) fs.writeFileSync(path.join(apiDir, ep.file), JSON.stringify(okBody('x')), 'utf8');
    return apiDir;
  };
  writeSlot('2');
  writeSlot('4');

  assert.equal(await hasValidSnapshot(path.join(dir, 'meta', '2026-10-13', '2', 'api'), EPS), true);
  assert.equal(await hasValidSnapshot(path.join(dir, 'meta', '2026-10-13', '4', 'api'), EPS), true);
});

test('业务拒绝（42000）：不落盘、不留空壳目录，且透传服务端 message', async () => {
  const dir = tmpDataDir();
  makeFetchMock(() => ({ body: { code: 42000, success: false, message: '系统异常', data: null } }));

  await assert.rejects(
    () => collectMeta({ dataDir: dir, date: '2026-10-13', endpoints: EPS }),
    (err) => {
      assert.ok(err instanceof BusinessRejectedError);
      assert.equal(err.code, 42000);
      assert.equal(err.serverMessage, '系统异常');
      return true;
    },
  );

  assert.equal(fs.existsSync(path.join(dir, 'meta', '2026-10-13')), false, '快照目录不应存在');
  assert.equal(fs.readdirSync(dir).length, 0, '数据根目录应为空');
});

test('业务拒绝即止：命中 42000 后不再发起后续端点请求', async () => {
  const dir = tmpDataDir();
  const calls = makeFetchMock(() => ({ body: { code: 42000 } }));

  await assert.rejects(() => collectMeta({ dataDir: dir, date: '2026-10-13', endpoints: EPS }));

  assert.equal(calls.length, 1, '只应发起第 1 个请求后立即停止');
  assert.equal(fs.readdirSync(dir).length, 0);
});

test('脏数据（code≠1）：抛错且不落盘', async () => {
  const dir = tmpDataDir();
  makeFetchMock(() => ({ body: { code: 10001, message: '参数错误', data: null } }));

  await assert.rejects(
    () => collectMeta({ dataDir: dir, date: '2026-10-13', endpoints: EPS }),
    (err) => err instanceof ApiError,
  );
  assert.equal(fs.readdirSync(dir).length, 0);
});

// ---------- M3：幂等 + 并发锁 ----------

const writeSnapshot = (dir, date) => {
  const apiDir = path.join(dir, 'meta', date, '2', 'api');
  fs.mkdirSync(apiDir, { recursive: true });
  for (const ep of EPS) {
    fs.writeFileSync(path.join(apiDir, ep.file), JSON.stringify(okBody('x')), 'utf8');
  }
  return apiDir;
};

test('幂等：当日已有有效快照时跳过，且不发任何请求', async () => {
  const dir = tmpDataDir();
  writeSnapshot(dir, '2026-10-13');
  const calls = makeFetchMock(() => ({ body: okBody('x') }));

  const r = await runCollect({ dataDir: dir, date: '2026-10-13', endpoints: EPS });

  assert.equal(r.status, 'skipped');
  assert.equal(calls.length, 0, '不应发起任何 HTTP 请求');
  assert.equal(fs.existsSync(path.join(dir, '.collect.lock')), false, '锁应已释放');
});

test('幂等失效：快照存在但 code≠1 时视为无效，重新采集', async () => {
  const dir = tmpDataDir();
  const apiDir = writeSnapshot(dir, '2026-10-13');
  fs.writeFileSync(path.join(apiDir, 'heroes.json'), JSON.stringify({ code: 42000, data: null }), 'utf8');
  const calls = makeFetchMock(() => ({ body: okBody('x') }));

  const r = await runCollect({ dataDir: dir, date: '2026-10-13', endpoints: EPS });

  assert.equal(r.status, 'collected');
  assert.equal(calls.length, 3);
});

test('--force：已有有效快照仍强制重采', async () => {
  const dir = tmpDataDir();
  writeSnapshot(dir, '2026-10-13');
  const calls = makeFetchMock(() => ({ body: okBody('x') }));

  const r = await runCollect({ dataDir: dir, date: '2026-10-13', endpoints: EPS, force: true });

  assert.equal(r.status, 'collected');
  assert.equal(calls.length, 3);
});

test('并发锁：已有存活进程持锁时第二个实例立即退出且不发请求', async () => {
  const dir = tmpDataDir();
  // 用当前进程 PID 造一个「活锁」
  fs.writeFileSync(path.join(dir, '.collect.lock'), String(process.pid), 'utf8');
  const calls = makeFetchMock(() => ({ body: okBody('x') }));

  const r = await runCollect({ dataDir: dir, date: '2026-10-13', endpoints: EPS });

  assert.equal(r.status, 'locked');
  assert.equal(calls.length, 0, '不应发起任何 HTTP 请求');
  assert.equal(fs.existsSync(path.join(dir, '.collect.lock')), true, '他人持有的锁不应被删除');
});

test('stale 锁：持锁进程已死时可被接管并正常采集', async () => {
  const dir = tmpDataDir();
  fs.writeFileSync(path.join(dir, '.collect.lock'), '999999', 'utf8'); // 几乎不可能存活的 PID
  const calls = makeFetchMock(() => ({ body: okBody('x') }));

  const r = await runCollect({ dataDir: dir, date: '2026-10-13', endpoints: EPS });

  assert.equal(r.status, 'collected');
  assert.equal(calls.length, 3);
  assert.equal(fs.existsSync(path.join(dir, '.collect.lock')), false, '锁应已释放');
});

test('失败路径（业务拒绝 42000）也会释放锁，不阻塞下次', async () => {
  const dir = tmpDataDir();
  makeFetchMock(() => ({ body: { code: 42000 } }));

  await assert.rejects(
    () => runCollect({ dataDir: dir, date: '2026-10-13', endpoints: EPS }),
    (err) => err instanceof BusinessRejectedError,
  );
  assert.equal(fs.existsSync(path.join(dir, '.collect.lock')), false, '失败后锁必须被清理');
});

test('锁原语：acquireLock 两次，第二次应让出；release 后可再次获取', async () => {
  const dir = tmpDataDir();
  const lockPath = await acquireLock(dir);
  assert.ok(lockPath);
  assert.equal(await acquireLock(dir), null, '存活持锁时应返回 null');
  await releaseLock(lockPath);
  assert.ok(await acquireLock(dir), '释放后可重新获取');
  await releaseLock(path.join(dir, '.collect.lock'));
});

test('hasValidSnapshot：缺文件 / 非 JSON / code≠1 均判为无效', async () => {
  const dir = tmpDataDir();
  const apiDir = path.join(dir, 'meta', '2026-10-13', '2', 'api');
  assert.equal(await hasValidSnapshot(apiDir, EPS), false, '目录不存在应为 false');

  fs.mkdirSync(apiDir, { recursive: true });
  fs.writeFileSync(path.join(apiDir, 'heroes.json'), 'not json', 'utf8');
  assert.equal(await hasValidSnapshot(apiDir, EPS), false, '非 JSON 应为 false');

  for (const ep of EPS) fs.writeFileSync(path.join(apiDir, ep.file), JSON.stringify(okBody('x')), 'utf8');
  assert.equal(await hasValidSnapshot(apiDir, EPS), true, '三项齐全且 code===1 应为 true');
});
