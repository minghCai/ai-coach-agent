// M5 验收测试：全部使用 mock llmCall，不访问 DeepSeek、不读取真实 API key。

import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

const { generateReport, diffSnapshots } = await import('./generate-report.mjs');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'm5-'));

const CANNED = `# 2026-10-13 测试 分析报告

## 一、结论（先行）
- 结论一

## 二、证据
- 证据一

## 三、版本环境变化
- 变化一

## 四、风险与反方审查
- 风险一

## 五、可证伪的验证计划
- 计划一

## 六、待验证假设
- 假设一`;

// 造快照：heroes 的 id=1861 在两个日期名次/登顶率不同（默认万象大赛槽位 2）
function seedSnapshot(root, date, slot = '2', { firstHeroFirstRate = 0.2 } = {}) {
  const apiDir = path.join(root, 'meta', date, slot, 'api');
  fs.mkdirSync(apiDir, { recursive: true });
  const wrap = (data) => ({ code: 1, success: true, message: '', data });
  fs.writeFileSync(
    path.join(apiDir, 'heroes.json'),
    JSON.stringify(
      wrap({
        base: { count: 1000, avgPlacement: 3.4, firstRate: 0.16, top3Rate: 0.5 },
        rows: [
          { id: '999', count: 500, avgPlacement: 2.9, firstRate: 0.3, top3Rate: 0.7 },
          { id: '1861', count: 400, avgPlacement: 2.8, firstRate: firstHeroFirstRate, top3Rate: 0.66 },
        ],
      }),
    ),
    'utf8',
  );
  fs.writeFileSync(
    path.join(apiDir, 'commanders.json'),
    JSON.stringify(
      wrap({
        base: { count: 10, avgPlacement: 3.1, firstRate: 0.2, top3Rate: 0.5 },
        rows: [{ id: 'c1', name: '小妲己', count: 100, avgPlacement: 3.2, firstRate: 0.2, top3Rate: 0.5 }],
      }),
    ),
    'utf8',
  );
  fs.writeFileSync(
    path.join(apiDir, 'equipment.json'),
    JSON.stringify(
      wrap({
        base: { count: 10, avgPlacement: 3.2, firstRate: 0.15, top3Rate: 0.45 },
        rows: [{ id: '643100', count: 90, avgPlacement: 2.9, firstRate: 0.24, top3Rate: 0.6 }],
      }),
    ),
    'utf8',
  );
}

function seedCards(root) {
  fs.mkdirSync(path.join(root, 'cards'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'cards', 'heroes.json'),
    JSON.stringify([
      { id: '999', name: '甲英雄', faction: 'A', quality: 5, source: 't', verified: true },
      { id: '1861', name: '太乙真人', faction: '无阵营', quality: 4, source: 't', verified: true },
    ]),
    'utf8',
  );
  fs.writeFileSync(
    path.join(root, 'cards', 'equipment.json'),
    JSON.stringify([{ id: '643100', name: '风暴巨剑', quality: 1, source: 't', verified: true }]),
    'utf8',
  );
}

const captureLlm = () => {
  const calls = [];
  const fn = async (opts) => {
    calls.push(opts);
    return CANNED;
  };
  return { calls, fn };
};

test('generateReport：落盘报告含六段结构，且 system prompt 载入教练原则', async () => {
  const root = tmp();
  seedSnapshot(root, '2026-10-11');
  seedSnapshot(root, '2026-10-13', '2', { firstHeroFirstRate: 0.28 });
  seedCards(root);
  const { calls, fn } = captureLlm();

  const r = await generateReport({ angle: '太乙真人这版强度', dataDir: root, llmCall: fn });

  assert.equal(r.date, '2026-10-13');
  assert.equal(r.previousDate, '2026-10-11');
  assert.ok(fs.existsSync(r.reportPath));
  assert.equal(path.basename(r.reportPath), '2026-10-13-万象大赛-太乙真人这版强度.md');

  const saved = fs.readFileSync(r.reportPath, 'utf8');
  for (const h of ['## 一、结论', '## 二、证据', '## 三、版本环境变化', '## 四、风险与反方审查', '## 五、可证伪的验证计划', '## 六、待验证假设']) {
    assert.ok(saved.includes(h), `报告应包含段落：${h}`);
  }

  const [system, user] = calls[0].messages;
  assert.equal(system.role, 'system');
  assert.match(system.content, /绝不编造数值/);
  assert.match(system.content, /待验证/);
  assert.equal(calls[0].temperature, 0.3);
  assert.equal(user.role, 'user');
});

test('命令行传入的角度出现在报告主线（prompt）里', async () => {
  const root = tmp();
  seedSnapshot(root, '2026-10-13');
  seedCards(root);
  const { calls, fn } = captureLlm();

  await generateReport({ angle: '重装厄斐琉斯为什么掉到 T2', dataDir: root, llmCall: fn });

  assert.match(calls[0].messages[1].content, /重装厄斐琉斯为什么掉到 T2/);
});

test('diff 摘要按 §5.1 写入 meta/<date>/summary.md，且含名次/登顶率变化', async () => {
  const root = tmp();
  seedSnapshot(root, '2026-10-11');
  seedSnapshot(root, '2026-10-13', '2', { firstHeroFirstRate: 0.28 });
  seedCards(root);
  const { calls, fn } = captureLlm();

  const r = await generateReport({ angle: 'x', dataDir: root, llmCall: fn });

  assert.ok(fs.existsSync(r.summaryPath));
  assert.equal(path.relative(root, r.summaryPath), path.join('meta', '2026-10-13', '2', 'summary.md'));
  const summary = fs.readFileSync(r.summaryPath, 'utf8');
  assert.match(summary, /太乙真人/);
  assert.match(summary, /登顶率变化/);
  assert.match(calls[0].messages[1].content, /版本变化/);
});

test('单快照降级：不做趋势对比，并在 prompt 中声明禁出强度结论', async () => {
  const root = tmp();
  seedSnapshot(root, '2026-10-13');
  seedCards(root);
  const { calls, fn } = captureLlm();

  const r = await generateReport({ angle: 'x', dataDir: root, llmCall: fn });

  assert.equal(r.previousDate, null);
  assert.match(calls[0].messages[1].content, /无上一份「万象大赛」快照/);
  assert.match(calls[0].messages[1].content, /禁出结论/);
});

test('空角度：退化为「版本环境速览」，并体现在文件名与 prompt', async () => {
  const root = tmp();
  seedSnapshot(root, '2026-10-13');
  seedCards(root);
  const { calls, fn } = captureLlm();

  const r = await generateReport({ angle: '   ', dataDir: root, llmCall: fn });

  assert.equal(path.basename(r.reportPath), '2026-10-13-万象大赛-版本环境速览.md');
  assert.match(calls[0].messages[1].content, /版本环境速览/);
});

test('模式：按 slot 出报告，文件名与摘要都带模式名', async () => {
  const root = tmp();
  seedSnapshot(root, '2026-10-13', '4-大师场');
  seedCards(root);
  const { fn } = captureLlm();

  const r = await generateReport({ angle: 'x', dataDir: root, slot: '4-大师场', llmCall: fn });

  assert.equal(r.slot, '4-大师场');
  assert.equal(r.modeLabel, '钻石狂潮·大师场');
  assert.equal(path.basename(r.reportPath), '2026-10-13-钻石狂潮·大师场-x.md');
  assert.equal(path.relative(root, r.summaryPath), path.join('meta', '2026-10-13', '4-大师场', 'summary.md'));
});

test('兜底：所选模式无快照时回退到全局最新快照，报告按真实模式命名', async () => {
  const root = tmp();
  seedSnapshot(root, '2026-10-13'); // 仅万象大赛，无钻石狂潮
  seedCards(root);
  const { fn } = captureLlm();

  const r = await generateReport({ angle: 'x', dataDir: root, slot: '4-大师场', llmCall: fn });

  assert.deepEqual(r.fallback, { requestedSlot: '4-大师场', actualSlot: '2' });
  assert.equal(r.slot, '2');
  assert.equal(r.modeLabel, '万象大赛');
  assert.equal(path.basename(r.reportPath), '2026-10-13-万象大赛-x.md');
  assert.equal(path.relative(root, r.summaryPath), path.join('meta', '2026-10-13', '2', 'summary.md'));
});

test('文件名净化：角度中的非法字符不会进入路径', async () => {
  const root = tmp();
  seedSnapshot(root, '2026-10-13');
  seedCards(root);
  const { fn } = captureLlm();

  const r = await generateReport({ angle: 'a/b:c*?"<>|d', dataDir: root, llmCall: fn });

  const name = path.basename(r.reportPath);
  assert.ok(!/[\\/:*?"<>|]/.test(name), `文件名不应含非法字符：${name}`);
  assert.ok(fs.existsSync(r.reportPath));
});

test('diffSnapshots：纯函数直接给出升降榜', () => {
  const mk = (rows) => ({ code: 1, data: { base: {}, rows } });
  const prev = { heroes: mk([{ id: '1' }, { id: '2' }, { id: '5' }]), commanders: mk([]), equipment: mk([]) };
  const curr = { heroes: mk([{ id: '2' }, { id: '3' }, { id: '1' }]), commanders: mk([]), equipment: mk([]) };

  const text = diffSnapshots(prev, curr, { topN: 3, nameOf: (ds, id) => `N${id}` });

  assert.match(text, /N2 ↑1（2→1）/);
  assert.match(text, /N1 ↓2（1→3）/);
  assert.match(text, /新进入 Top 3：N3/);
  assert.match(text, /掉出 Top 3：N5/);
});

test('diffSnapshots：内容完全一致时标记数据源冻结', () => {
  const body = { code: 1, data: { base: {}, rows: [{ id: '1', firstRate: 0.2 }] } };
  const same = { heroes: body, commanders: body, equipment: body };

  const text = diffSnapshots(same, same);
  assert.match(text, /数据源冻结/);
});

test('llm 未配置 key 时报错不泄漏任何密钥内容', async () => {
  const { loadApiKey } = await import('./llm.mjs');
  const root = tmp();
  const saved = process.env.DEEPSEEK_API_KEY;
  delete process.env.DEEPSEEK_API_KEY;
  try {
    await assert.rejects(() => loadApiKey({ dataDir: root }), /未找到 DeepSeek API key/);
  } finally {
    if (saved !== undefined) process.env.DEEPSEEK_API_KEY = saved;
  }
});

test('llm 从 data/.secrets.json 读取 key', async () => {
  const { loadApiKey } = await import('./llm.mjs');
  const root = tmp();
  fs.writeFileSync(path.join(root, '.secrets.json'), JSON.stringify({ deepseekApiKey: 'sk-test-123' }), 'utf8');

  const saved = process.env.DEEPSEEK_API_KEY;
  delete process.env.DEEPSEEK_API_KEY;
  try {
    assert.equal(await loadApiKey({ dataDir: root }), 'sk-test-123');
  } finally {
    if (saved !== undefined) process.env.DEEPSEEK_API_KEY = saved;
  }
});
