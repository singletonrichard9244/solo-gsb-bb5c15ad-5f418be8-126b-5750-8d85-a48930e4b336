/**
 * 沙盒草案发布接口测试（真实 HTTP + 临时数据目录）：
 * - 预演返回基线版本指纹，发布须回传该指纹；
 * - 单次临界区内重新核对指纹、复用草案校验、原子写入；
 * - 基线变化 => 409 BASELINE_CHANGED（返回当前版本与失效操作，不部分落盘）；
 * - 新增 duplicate/prefix 冲突 => 409 DRAFT_CONFLICTS（不落盘）；
 * - 并发发布互斥：同基线的两个发布只有一个成功，另一个 409，结果绝不混合。
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// 必须在 require store/index 之前指定临时数据目录
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shortcut-publish-'));
process.env.DATA_DIR = tmpDir;

// ---- 固定夹具：R → A → B；m1(R,S) 在 B 被 m2(A,S) 覆盖 ----
const fixture = {
  contexts: [
    { id: 'r', parentId: null, name: 'R', description: '' },
    { id: 'a', parentId: 'r', name: 'A', description: '' },
    { id: 'b', parentId: 'a', name: 'B', description: '' },
  ],
  commands: [
    { id: 'm1', contextId: 'r', name: 'root-save', sequenceRaw: 's', sequenceTokens: ['s'], sequenceLabel: 'S', description: '' },
    { id: 'm2', contextId: 'a', name: 'a-save', sequenceRaw: 's', sequenceTokens: ['s'], sequenceLabel: 'S', description: '' },
    { id: 'm3', contextId: 'a', name: 'a-jump', sequenceRaw: 'j', sequenceTokens: ['j'], sequenceLabel: 'J', description: '' },
  ],
};
fs.writeFileSync(path.join(tmpDir, 'state.json'), JSON.stringify(fixture, null, 2));

const store = require('../src/store');
const { app } = require('../src/index');
const { stateFingerprint } = require('../src/engine');

let passed = 0;
const test = async (name, fn) => {
  await fn();
  passed++;
  console.log(`  ✓ ${name}`);
};

const resetState = async () => {
  fs.writeFileSync(path.join(tmpDir, 'state.json'), JSON.stringify(fixture, null, 2));
  await store.reload();
};

async function main() {
  await store.init();
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}/api`;
  const call = (method, url, body) =>
    fetch(base + url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  // 1. 预演返回基线指纹
  await test('预演响应包含基线版本指纹，与当前状态一致', async () => {
        await resetState();
        const res = await call('POST', '/sandbox/preview', { deletes: ['m2'] });
        assert.equal(res.status, 200);
        const data = await res.json();
        assert.match(data.baseline.fingerprint, /^sha256:[0-9a-f]{64}$/);
        assert.equal(data.baseline.fingerprint, stateFingerprint(store.snapshot()));
  });

  // 2. 发布成功：原子写入 + 新增/改序列/删除数量 + 新增命令获得真实 id
  await test('发布成功：原子落盘，返回新增/改序列/删除数量，新增命令分配真实 id', async () => {
    await resetState();
    const preview = await (await call('POST', '/sandbox/preview', {
      adds: [{ draftId: 'd1', contextId: 'a', name: 'new-cmd', sequence: 'n' }],
      updates: [{ commandId: 'm3', sequence: 'u' }],
      deletes: ['m2'],
    })).json();

    // 无新增冲突才允许发布
    assert.equal(preview.stats.duplicateAppeared, 0);
    assert.equal(preview.stats.prefixAppeared, 0);

    const res = await call('POST', '/sandbox/publish', {
      draft: {
        adds: [{ draftId: 'd1', contextId: 'a', name: 'new-cmd', sequence: 'n' }],
        updates: [{ commandId: 'm3', sequence: 'u' }],
        deletes: ['m2'],
      },
      baselineFingerprint: preview.baseline.fingerprint,
    });
    assert.equal(res.status, 200, res.status === 200 ? '' : await res.text());
    const data = await res.json();
    assert.deepEqual(data.counts, { adds: 1, updates: 1, deletes: 1 });
    assert.equal(data.addedCommands[0].draftId, 'd1');
    assert.match(data.addedCommands[0].commandId, /^cmd-/);
    assert.notEqual(data.addedCommands[0].commandId, 'd1');
    assert.deepEqual(data.updatedCommandIds, ['m3']);
    assert.deepEqual(data.deletedCommandIds, ['m2']);

    const after = store.snapshot();
    const ids = after.commands.map((c) => c.id);
    assert.ok(!ids.includes('m2'), 'm2 已删除');
    assert.ok(!ids.includes('d1'), '前端 draftId 不得落盘');
    const realNew = after.commands.find((c) => c.name === 'new-cmd');
    assert.ok(realNew && /^cmd-/.test(realNew.id));
    assert.deepEqual(realNew.sequenceTokens, ['n']);
    assert.equal(after.commands.find((c) => c.id === 'm3').sequenceTokens[0], 'u');
    // 返回的新基线指纹与落盘状态一致
    assert.equal(data.baseline.fingerprint, stateFingerprint(after));
    // 数据文件内容与内存一致（原子落盘）
    const onDisk = JSON.parse(fs.readFileSync(path.join(tmpDir, 'state.json'), 'utf8'));
    assert.equal(stateFingerprint(onDisk), data.baseline.fingerprint);
  });

  // 3. 指纹过期：发布前数据被别处改动 => 409 + 当前版本 + 失效操作，不落盘
  await test('基线已变化：409 BASELINE_CHANGED，返回当前版本与失效操作，不部分落盘', async () => {
    await resetState();
    const preview = await (await call('POST', '/sandbox/preview', {
      updates: [{ commandId: 'm3', sequence: 'u' }],
      deletes: ['m2'],
    })).json();

    // 别处改动：直接删除 m3（草案中的 update 目标随之失效）
    const delRes = await call('DELETE', '/commands/m3');
    assert.equal(delRes.status, 200);

    const res = await call('POST', '/sandbox/publish', {
      adds: [],
      updates: [{ commandId: 'm3', sequence: 'u' }],
      deletes: ['m2'],
      baselineFingerprint: preview.baseline.fingerprint,
    });
    assert.equal(res.status, 409);
    const data = await res.json();
    assert.equal(data.code, 'BASELINE_CHANGED');
    assert.equal(data.details.current.fingerprint, stateFingerprint(store.snapshot()));
    assert.notEqual(data.details.current.fingerprint, preview.baseline.fingerprint);
    assert.deepEqual(data.details.invalidated.updates, [{ commandId: 'm3' }]);
    assert.deepEqual(data.details.invalidated.deletes, []); // m2 仍存在，删除操作未失效

    // 未落盘任何草案内容：m2 仍在（删除未执行），状态与“仅删除 m3”一致
    const after = store.snapshot();
    assert.ok(after.commands.some((c) => c.id === 'm2'), '失败发布不得删除 m2');
    assert.ok(!after.commands.some((c) => c.id === 'm3'));
    assert.equal(stateFingerprint(after), data.details.current.fingerprint);
  });

  // 4. 新 duplicate 冲突：409 DRAFT_CONFLICTS，且不修改数据
  await test('草案新增同层重复：409 DRAFT_CONFLICTS，拒绝发布且不落盘', async () => {
    await resetState();
    const beforeFingerprint = stateFingerprint(store.snapshot());
    const preview = await (await call('POST', '/sandbox/preview', {
      updates: [{ commandId: 'm3', sequence: 's' }], // J → S，与 m2 同层重复
    })).json();
    assert.ok(preview.stats.duplicateAppeared > 0);

    const res = await call('POST', '/sandbox/publish', {
      updates: [{ commandId: 'm3', sequence: 's' }],
      deletes: [],
      adds: [],
      baselineFingerprint: preview.baseline.fingerprint,
    });
    assert.equal(res.status, 409);
    const data = await res.json();
    assert.equal(data.code, 'DRAFT_CONFLICTS');
    assert.ok(data.details.newConflicts.some((c) => c.type === 'duplicate'));
    assert.deepEqual(
      data.details.newConflicts.find((c) => c.type === 'duplicate').commandIds.sort(),
      ['m2', 'm3'],
    );
    // 数据完全未变
    assert.equal(stateFingerprint(store.snapshot()), beforeFingerprint);
    assert.deepEqual(store.snapshot().commands.find((c) => c.id === 'm3').sequenceTokens, ['j']);
  });

  // 5. 新 prefix 冲突同样被拒
  await test('草案新增前缀冲突：409 DRAFT_CONFLICTS', async () => {
    await resetState();
    // 在根新增单键 S：与 A 层？根视角 S(m1) 自身重复——改用独立场景：
    // m3: J → J K 与任何现存 J？根/A 下没有 J 前缀组……A 层 m3 自身 J 改走后，
    // A 下生效序列 S(m2)、S(m1 被覆盖)、J K。新增 j 与 j k：在 B 新增单键 j，
    // 与 m3 改为 j k 构成前缀。
    const draft = {
      adds: [{ draftId: 'p1', contextId: 'a', name: 'a-j', sequence: 'j' }],
      updates: [{ commandId: 'm3', sequence: 'j k' }],
      deletes: [],
    };
    const preview = await (await call('POST', '/sandbox/preview', draft)).json();
    assert.ok(preview.stats.prefixAppeared > 0);
    const res = await call('POST', '/sandbox/publish', {
      ...draft,
      baselineFingerprint: preview.baseline.fingerprint,
    });
    assert.equal(res.status, 409);
    const data = await res.json();
    assert.equal(data.code, 'DRAFT_CONFLICTS');
    assert.ok(data.details.newConflicts.some((c) => c.type === 'prefix'));
  });

  // 6. 缺少指纹 / 空草案 => 400
  await test('缺少基线指纹或草案为空：400', async () => {
    await resetState();
    const r1 = await call('POST', '/sandbox/publish', { deletes: ['m2'] });
    assert.equal(r1.status, 400);
    const r2 = await call('POST', '/sandbox/publish', {
      adds: [], updates: [], deletes: [], baselineFingerprint: stateFingerprint(store.snapshot()),
    });
    assert.equal(r2.status, 400);
  });

  // 7. 非法草案 => 400，无副作用
  await test('非法草案（删除不存在的命令）：400 且不修改数据', async () => {
    await resetState();
    const fp = stateFingerprint(store.snapshot());
    const res = await call('POST', '/sandbox/publish', {
      deletes: ['nope'],
      baselineFingerprint: fp,
    });
    assert.equal(res.status, 400);
    assert.equal(stateFingerprint(store.snapshot()), fp);
  });

  // 8. 并发发布互斥：同基线的两个草案竞争，恰好一个成功，状态不混合
  await test('并发发布：临界区串行化，失败者 409，绝不部分落盘', async () => {
    await resetState();
    const fp = stateFingerprint(store.snapshot());
    const draftA = { adds: [], updates: [], deletes: ['m2'], baselineFingerprint: fp };
    const draftB = {
      adds: [],
      updates: [{ commandId: 'm3', sequence: 'u' }],
      deletes: [],
      baselineFingerprint: fp,
    };
    const [ra, rb] = await Promise.all([
      call('POST', '/sandbox/publish', draftA),
      call('POST', '/sandbox/publish', draftB),
    ]);
    const statuses = [ra.status, rb.status].sort();
    assert.deepEqual(statuses, [200, 409]);
    const body409 = ra.status === 409 ? await ra.json() : await rb.json();
    assert.equal(body409.code, 'BASELINE_CHANGED');

    // 最终状态恰为其中一个草案的结果：
    //  方案 A => 无 m2、m3 仍为 J
    //  方案 B => m2 仍在、m3 为 U
    const after = store.snapshot();
    const m2Exists = after.commands.some((c) => c.id === 'm2');
    const m3Token = after.commands.find((c) => c.id === 'm3').sequenceTokens[0];
    const exactlyA = !m2Exists && m3Token === 'j';
    const exactlyB = m2Exists && m3Token === 'u';
    assert.ok(exactlyA || exactlyB, '最终状态必须恰好是其中一个草案，不得混合');
    // 失败响应给出的当前指纹正是落盘状态指纹
    assert.equal(body409.details.current.fingerprint, stateFingerprint(after));
  });

  // 9. 发布后旧指纹不可再次使用
  await test('发布成功后旧基线指纹立即失效，再次发布被 409 拒绝', async () => {
    await resetState();
    const fp = stateFingerprint(store.snapshot());
    const r1 = await call('POST', '/sandbox/publish', { deletes: ['m2'], baselineFingerprint: fp });
    assert.equal(r1.status, 200);
    const r2 = await call('POST', '/sandbox/publish', {
      updates: [{ commandId: 'm3', sequence: 'u' }],
      baselineFingerprint: fp, // 旧指纹
    });
    assert.equal(r2.status, 409);
    assert.equal((await r2.json()).code, 'BASELINE_CHANGED');
    // m3 未被第二次（失败的）发布修改
    assert.equal(store.snapshot().commands.find((c) => c.id === 'm3').sequenceTokens[0], 'j');
  });

  server.close();
  console.log(`\n发布接口测试全部通过：${passed} 项`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
