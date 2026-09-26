/**
 * 发布接口测试（HTTP 级）：
 * - 预演响应携带基线指纹，原有字段保持兼容；
 * - 发布在单次临界区内核对指纹 + 复用草案校验 + 原子写入；
 * - 数据已变化：409 sandbox-stale，返回当前指纹与失效操作，不落盘；
 * - 引入新增 duplicate/prefix 冲突：409 sandbox-conflicts，不落盘；
 * - 非法草案：400；并发发布：仅一份成功，另一份按基线过期拒绝。
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'shortcut-publish-test-'));
process.env.DATA_DIR = DATA_DIR;

const { start } = require('../src/index');

let server;
let base;
let passed = 0;

const test = async (name, fn) => {
  await fn();
  passed++;
  console.log(`  ✓ ${name}`);
};

const req = async (method, url, body) => {
  const res = await fetch(base + url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
};

const preview = (draft) => req('POST', '/api/sandbox/preview', draft);
const publish = (draft, fingerprint) => req('POST', '/api/sandbox/publish', { draft, fingerprint });

const TERMINAL = 'ctx-terminal';
const CODE = 'ctx-code';

async function main() {
  ({ server } = await start(0));
  base = `http://127.0.0.1:${server.address().port}`;

  await test('预演响应携带基线指纹且原有字段兼容', async () => {
    const { status, data } = await preview({ adds: [{ draftId: 't1', contextId: TERMINAL, name: '临时', sequence: 'ctrl+9' }] });
    assert.equal(status, 200);
    assert.match(data.baselineFingerprint, /^[0-9a-f]{64}$/);
    assert.ok(data.stats && typeof data.stats.totalChanges === 'number');
    assert.ok(Array.isArray(data.contexts));
    assert.ok(data.draft && typeof data.draft.adds === 'number');
  });

  await test('缺少指纹的发布被拒绝（400）', async () => {
    const { status, data } = await req('POST', '/api/sandbox/publish', { draft: { deletes: ['cmd-16'] } });
    assert.equal(status, 400);
    assert.match(data.error, /指纹/);
  });

  await test('发布成功：原子写入并返回新增/改序列/删除数量与新指纹', async () => {
    const draft = {
      adds: [{ draftId: 'd-add', contextId: TERMINAL, name: '发布测试-新增', sequence: 'ctrl+9' }],
      updates: [{ commandId: 'cmd-16', sequence: 'ctrl+8' }], // 清屏 G L → Ctrl+8（消解 G⊂G L 前缀冲突）
      deletes: ['cmd-19'], // 新建终端 Ctrl+`（唯一序列，删除不会暴露任何祖先冲突）
    };
    const pv = await preview(draft);
    assert.equal(pv.status, 200);
    assert.equal(pv.data.stats.duplicateAppeared + pv.data.stats.prefixAppeared, 0, '预演不应出现新增冲突');
    const pub = await publish(draft, pv.data.baselineFingerprint);
    assert.equal(pub.status, 200, JSON.stringify(pub.data));
    assert.deepEqual(pub.data.counts, { adds: 1, updates: 1, deletes: 1 });
    assert.match(pub.data.fingerprint, /^[0-9a-f]{64}$/);
    assert.notEqual(pub.data.fingerprint, pv.data.baselineFingerprint);
    assert.equal(pub.data.addedCommands.length, 1);
    assert.equal(pub.data.addedCommands[0].draftId, 'd-add');
    assert.match(pub.data.addedCommands[0].commandId, /^cmd-/);
    assert.deepEqual(pub.data.updatedCommandIds, ['cmd-16']);
    assert.deepEqual(pub.data.deletedCommandIds, ['cmd-19']);

    // 状态已真实落盘：新命令存在、cmd-16 序列已改、cmd-19 已删除
    const st = await req('GET', '/api/state');
    const added = st.data.commands.find((c) => c.id === pub.data.addedCommands[0].commandId);
    assert.ok(added && added.name === '发布测试-新增');
    assert.equal(st.data.commands.find((c) => c.id === 'cmd-16').sequenceLabel, 'Ctrl+8');
    assert.ok(!st.data.commands.some((c) => c.id === 'cmd-19'));
    // 数据文件内容与内存一致（原子落盘）
    const onDisk = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'state.json'), 'utf8'));
    assert.equal(onDisk.commands.length, st.data.commands.length);
    assert.ok(onDisk.commands.some((c) => c.id === added.id));
  });

  await test('数据已变化：拒绝发布，返回当前指纹与失效操作，不落盘', async () => {
    // 先预演（基线包含 cmd-16 / cmd-17）
    const draft = {
      updates: [{ commandId: 'cmd-16', sequence: 'ctrl+7' }],
      deletes: ['cmd-17'],
    };
    const pv = await preview(draft);
    assert.equal(pv.status, 200);
    // 模拟他人在预演之后修改数据：直接删掉 cmd-17（草案删除目标失效）
    const del = await req('DELETE', '/api/commands/cmd-17');
    assert.equal(del.status, 200);
    // 发布：指纹已过期
    const pub = await publish(draft, pv.data.baselineFingerprint);
    assert.equal(pub.status, 409);
    assert.equal(pub.data.code, 'sandbox-stale');
    assert.match(pub.data.details.currentFingerprint, /^[0-9a-f]{64}$/);
    assert.notEqual(pub.data.details.currentFingerprint, pv.data.baselineFingerprint);
    assert.equal(pub.data.details.invalidCount, 1);
    assert.deepEqual(pub.data.details.invalid.deletes.map((d) => d.commandId), ['cmd-17']);
    // 未落盘：cmd-16 序列未被修改
    const st = await req('GET', '/api/state');
    assert.equal(st.data.commands.find((c) => c.id === 'cmd-16').sequenceLabel, 'Ctrl+8');
  });

  await test('引入新增同层重复的草案被拒绝（409 sandbox-conflicts），不落盘', async () => {
    // cmd-18 / cmd-19 在 Terminal 同为 G H（基线已有重复）；把 cmd-16 也改到 G H 会扩大冲突集合
    const draft = { updates: [{ commandId: 'cmd-16', sequence: 'g h' }] };
    const pv = await preview(draft);
    assert.equal(pv.status, 200);
    assert.ok(pv.data.stats.duplicateAppeared > 0);
    const pub = await publish(draft, pv.data.baselineFingerprint);
    assert.equal(pub.status, 409);
    assert.equal(pub.data.code, 'sandbox-conflicts');
    assert.ok(pub.data.details.introducedConflicts.some((c) => c.type === 'duplicate'));
    // 不落盘
    const st = await req('GET', '/api/state');
    assert.equal(st.data.commands.find((c) => c.id === 'cmd-16').sequenceLabel, 'Ctrl+8');
  });

  await test('引入新增前缀冲突的草案被拒绝（409 sandbox-conflicts）', async () => {
    // Code Editor 已有 G D（cmd-11）；新增 G 会与其构成前缀冲突
    const draft = { adds: [{ draftId: 'd-pre', contextId: CODE, name: '前缀制造者', sequence: 'g' }] };
    const pv = await preview(draft);
    assert.equal(pv.status, 200);
    assert.ok(pv.data.stats.prefixAppeared > 0);
    const pub = await publish(draft, pv.data.baselineFingerprint);
    assert.equal(pub.status, 409);
    assert.equal(pub.data.code, 'sandbox-conflicts');
    assert.ok(pub.data.details.introducedConflicts.some((c) => c.type === 'prefix'));
    const st = await req('GET', '/api/state');
    assert.ok(!st.data.commands.some((c) => c.name === '前缀制造者'));
  });

  await test('非法草案发布返回 400，与预演校验口径一致', async () => {
    const pv = await preview({ deletes: ['cmd-18'] });
    const pub = await publish({ deletes: ['cmd-18'], updates: [{ commandId: 'cmd-18', sequence: 'x' }] }, pv.data.baselineFingerprint);
    assert.equal(pub.status, 400);
    assert.match(pub.data.error, /已在草案中删除/);
  });

  await test('并发发布同一基线：仅一份成功，另一份按基线过期拒绝', async () => {
    const pv = await preview({});
    const fp = pv.data.baselineFingerprint;
    const [r1, r2] = await Promise.all([
      publish({ adds: [{ draftId: 'c1', contextId: TERMINAL, name: '并发A', sequence: 'ctrl+6' }] }, fp),
      publish({ adds: [{ draftId: 'c2', contextId: TERMINAL, name: '并发B', sequence: 'ctrl+5' }] }, fp),
    ]);
    const oks = [r1, r2].filter((r) => r.status === 200);
    const stales = [r1, r2].filter((r) => r.status === 409 && r.data.code === 'sandbox-stale');
    assert.equal(oks.length, 1, `应恰好一份成功：${JSON.stringify([r1.status, r2.status])}`);
    assert.equal(stales.length, 1);
    // 落盘内容恰好是成功那一份（无部分写入、无混合）
    const st = await req('GET', '/api/state');
    const names = st.data.commands.map((c) => c.name);
    const hasA = names.includes('并发A');
    const hasB = names.includes('并发B');
    assert.ok(hasA !== hasB, '应只有一份草案落盘');
    const onDisk = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'state.json'), 'utf8'));
    assert.equal(onDisk.commands.length, st.data.commands.length);
  });

  console.log(`\n发布接口测试全部通过：${passed} 项`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => {
    if (server) server.close();
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
  });
