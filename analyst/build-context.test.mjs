// M4 验收测试（node --test collector/ analyst/）
//
// 全部使用系统临时目录造的 mock 快照与卡牌库，不触碰真实数据源。

import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

const { buildContext } = await import('./build-context.mjs');
const { loadKnowledge } = await import('./load-knowledge.mjs');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'm4-'));

// 造一份最小快照（结构与当前落盘一致：meta/<date>/<slot>/api）
function seedSnapshot(root, date, slot = '2') {
  const apiDir = path.join(root, 'meta', date, slot, 'api');
  fs.mkdirSync(apiDir, { recursive: true });
  const wrap = (data) => ({ code: 1, success: true, message: '', data });
  fs.writeFileSync(
    path.join(apiDir, 'heroes.json'),
    JSON.stringify(
      wrap({
        base: { count: 1137509, avgPlacement: 3.4996, firstRate: 0.1667, top3Rate: 0.5001 },
        rows: [
          { id: '1861', count: 394864, avgPlacement: 2.7961, firstRate: 0.2599, top3Rate: 0.6851, avgLevel: 25.19 },
        ],
      }),
    ),
    'utf8',
  );
  fs.writeFileSync(
    path.join(apiDir, 'commanders.json'),
    JSON.stringify(
      wrap({
        base: { count: 100, avgPlacement: 3.1, firstRate: 0.2, top3Rate: 0.5 },
        rows: [{ id: 'commander-r1', name: '小妲己', count: 1234, avgPlacement: 3.2, firstRate: 0.2, top3Rate: 0.55 }],
      }),
    ),
    'utf8',
  );
  fs.writeFileSync(
    path.join(apiDir, 'equipment.json'),
    JSON.stringify(
      wrap({
        base: { count: 50, avgPlacement: 3.3, firstRate: 0.15, top3Rate: 0.45 },
        rows: [{ id: '643100', count: 999, avgPlacement: 2.9, firstRate: 0.24, top3Rate: 0.6 }],
      }),
    ),
    'utf8',
  );
}

function seedCards(root) {
  fs.mkdirSync(path.join(root, 'cards'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'cards', 'heroes.json'),
    JSON.stringify([{ id: '1861', name: '太乙真人', faction: '无阵营', quality: 4, source: 'test', verified: true }]),
    'utf8',
  );
  fs.writeFileSync(
    path.join(root, 'cards', 'equipment.json'),
    JSON.stringify([{ id: '643100', name: '风暴巨剑', quality: 1, source: 'test', verified: true }]),
    'utf8',
  );
}

test('buildContext：id 映射为名称/阵营/阶位，输出结构化上下文', async () => {
  const root = tmp();
  seedSnapshot(root, '2026-10-13');
  seedCards(root);

  const ctx = await buildContext({ dataDir: root, knowledgeDir: path.join(root, 'knowledge') });

  assert.equal(ctx.date, '2026-10-13');
  assert.equal(ctx.snapshotCount, 1);
  assert.match(ctx.text, /太乙真人/);
  assert.match(ctx.text, /无阵营 \/ 4 阶/);
  assert.match(ctx.text, /风暴巨剑/);
  assert.match(ctx.text, /小妲己/);
  assert.match(ctx.text, /26\.0%/); // firstRate 0.2599
  assert.match(ctx.text, /英雄榜/);
  assert.equal(ctx.slot, '2');
  assert.match(ctx.text, /万象大赛/);
});

test('模式区分：不同模式各读各的槽位，互不串味', async () => {
  const root = tmp();
  seedSnapshot(root, '2026-10-13'); // 万象大赛
  seedSnapshot(root, '2026-10-13', '4-大师场'); // 钻石狂潮·大师场
  seedCards(root);

  const wz = await buildContext({ dataDir: root, knowledgeDir: path.join(root, 'k') });
  assert.equal(wz.slot, '2');
  assert.match(wz.text, /万象大赛/);
  assert.doesNotMatch(wz.text, /钻石狂潮/, '万象大赛上下文不得混入钻石狂潮数据');
  assert.equal(wz.snapshotCount, 1, '只应统计同模式快照');

  const zs = await buildContext({ dataDir: root, knowledgeDir: path.join(root, 'k'), slot: '4-大师场' });
  assert.equal(zs.slot, '4-大师场');
  assert.match(zs.text, /钻石狂潮/);
  assert.equal(zs.snapshotCount, 1);
});

test('模式无快照：所选模式 0 份快照时，兜底到全局最新快照（用真实模式，不贴错标签）', async () => {
  const root = tmp();
  seedSnapshot(root, '2026-10-11'); // 仅万象大赛
  seedSnapshot(root, '2026-10-13');
  seedCards(root);

  const ctx = await buildContext({ dataDir: root, slot: '4', knowledgeDir: path.join(root, 'k') });

  assert.equal(ctx.slot, '2', '应改用真实存在的模式槽位');
  assert.equal(ctx.modeLabel, '万象大赛');
  assert.equal(ctx.date, '2026-10-13', '应取全局日期最新的一份');
  assert.deepEqual(ctx.fallback, { requestedSlot: '4', actualSlot: '2' });
  assert.match(ctx.text, /兜底说明/);
  assert.match(ctx.text, /万象大赛/);
});

test('缺失声明：未采集阵容时显式标注数据缺失', async () => {
  const root = tmp();
  seedSnapshot(root, '2026-10-13');
  seedCards(root);

  const ctx = await buildContext({ dataDir: root, knowledgeDir: path.join(root, 'k') });
  assert.match(ctx.text, /数据缺失/);
  assert.match(ctx.text, /lineups\/search/);
});

test('阵容：快照含 lineups-*.json 时输出阵容榜，且不再标注缺失', async () => {
  const root = tmp();
  seedSnapshot(root, '2026-10-13');
  seedCards(root);
  const apiDir = path.join(root, 'meta', '2026-10-13', '2', 'api');
  const lineup = {
    code: 1,
    success: true,
    message: '',
    data: {
      sampleCount: 344959,
      total: 1,
      lineups: [
        {
          lineupKey: '7|1311|1361|1441|1541|1751|1861|5131',
          lineupSize: 7,
          heroes: [
            { id: '1311', name: '李白' },
            { id: '1541', name: '花木兰' },
          ],
          commanders: [{ id: '43', name: '嬴律' }],
          count: 18761,
          appearanceRate: 0.3263,
          avgPlacement: 3.0849,
          firstRate: 0.2299,
          top3Rate: 0.6041,
        },
      ],
    },
  };
  fs.writeFileSync(path.join(apiDir, 'lineups-1.json'), JSON.stringify(lineup), 'utf8');

  const ctx = await buildContext({ dataDir: root, knowledgeDir: path.join(root, 'k') });

  assert.match(ctx.text, /热门阵容/);
  assert.match(ctx.text, /李白 \/ 花木兰/);
  assert.match(ctx.text, /嬴律/);
  assert.doesNotMatch(ctx.text, /数据缺失：本轮快照未采集 lineups/);
});

test('§4.5 元数据：仅 1 份快照时标注「仅作方向性参考」', async () => {
  const root = tmp();
  seedSnapshot(root, '2026-10-13');
  seedCards(root);

  const ctx = await buildContext({ dataDir: root, knowledgeDir: path.join(root, 'k') });
  assert.match(ctx.text, /方向性参考/);
});

test('底稿注入：knowledge/ 放入 md 后内容零代码改动地出现在上下文', async () => {
  const root = tmp();
  seedSnapshot(root, '2026-10-13');
  seedCards(root);
  const kdir = path.join(root, 'knowledge');
  fs.mkdirSync(kdir, { recursive: true });
  fs.writeFileSync(path.join(kdir, '01-my-principles.md'), '独家底稿内容-ABC123', 'utf8');

  const ctx = await buildContext({ dataDir: root, knowledgeDir: kdir });

  assert.deepEqual(ctx.knowledgeFiles, ['01-my-principles.md']);
  assert.match(ctx.text, /独家底稿内容-ABC123/);
});

test('knowledge/ 不存在时不报错，标注为空', async () => {
  const root = tmp();
  seedSnapshot(root, '2026-10-13');
  seedCards(root);

  const ctx = await buildContext({ dataDir: root, knowledgeDir: path.join(root, 'nope') });
  assert.equal(ctx.knowledgeFiles.length, 0);
  assert.match(ctx.text, /knowledge\/ 为空/);
});

test('多份快照：默认取最新，并标注可做趋势对比', async () => {
  const root = tmp();
  seedSnapshot(root, '2026-10-11');
  seedSnapshot(root, '2026-10-13');
  seedCards(root);

  const ctx = await buildContext({ dataDir: root, knowledgeDir: path.join(root, 'k') });
  assert.equal(ctx.date, '2026-10-13');
  assert.equal(ctx.snapshotCount, 2);
  assert.match(ctx.text, /可做趋势对比/);
});

test('指定不存在的日期时抛出明确错误', async () => {
  const root = tmp();
  seedSnapshot(root, '2026-10-13');
  seedCards(root);

  await assert.rejects(
    () => buildContext({ dataDir: root, date: '2020-01-01', knowledgeDir: path.join(root, 'k') }),
    /快照不存在/,
  );
});

test('无任何快照时抛出明确错误', async () => {
  const root = tmp();
  await assert.rejects(
    () => buildContext({ dataDir: root, knowledgeDir: path.join(root, 'k') }),
    /未找到任何「万象大赛」快照/,
  );
});

test('loadKnowledge：按文件名前缀数字排序，忽略非 md', async () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, '10-b.md'), 'BBB', 'utf8');
  fs.writeFileSync(path.join(dir, '2-a.md'), 'AAA', 'utf8');
  fs.writeFileSync(path.join(dir, 'note.txt'), 'XXX', 'utf8');

  const k = await loadKnowledge(dir);

  assert.deepEqual(k.files, ['2-a.md', '10-b.md']);
  assert.ok(k.text.indexOf('AAA') < k.text.indexOf('BBB'), '2-a 应排在 10-b 之前');
  assert.match(k.text, /### 2-a\.md/);
});
