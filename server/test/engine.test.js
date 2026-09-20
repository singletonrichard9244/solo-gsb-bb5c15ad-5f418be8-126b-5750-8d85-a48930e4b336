const assert = require('node:assert/strict');
const {
  computeEffective,
  evaluateKey,
  parseSequence,
  generateRegressionSuite,
  minimumSetCover,
  conflictGoalId,
  previewSandbox,
  replayTimeline,
  resolveConflicts,
  stateFingerprint,
  inspectStaleDraftOps,
} = require('../src/engine');

let passed = 0;
const test = (name, fn) => {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
};

// 构造可控数据
const state = {
  contexts: [
    { id: 'root', parentId: null, name: 'Root' },
    { id: 'a', parentId: 'root', name: 'A' },
    { id: 'b', parentId: 'a', name: 'B' },
    { id: 'sibling', parentId: 'root', name: 'Sibling' },
  ],
  commands: [
    { id: 'c1', contextId: 'root', name: 'root-x', sequenceTokens: ['x'], sequenceLabel: 'X', description: '' },
    { id: 'c2', contextId: 'root', name: 'root-g', sequenceTokens: ['g'], sequenceLabel: 'G', description: '' },
    { id: 'c3', contextId: 'root', name: 'root-gd', sequenceTokens: ['g', 'd'], sequenceLabel: 'G D', description: '' },
    { id: 'c4', contextId: 'a', name: 'a-x', sequenceTokens: ['x'], sequenceLabel: 'X', description: '' },
    { id: 'c5', contextId: 'a', name: 'a-y1', sequenceTokens: ['y'], sequenceLabel: 'Y', description: '' },
    { id: 'c6', contextId: 'a', name: 'a-y2', sequenceTokens: ['y'], sequenceLabel: 'Y', description: '' },
    { id: 'c7', contextId: 'b', name: 'b-g', sequenceTokens: ['g'], sequenceLabel: 'G', description: '' },
    { id: 'c8', contextId: 'sibling', name: 'sib-k', sequenceTokens: ['k'], sequenceLabel: 'K', description: '' },
  ],
};

test('序列解析：空格/逗号分隔，1~3 次', () => {
  assert.deepEqual(parseSequence('g l').tokens, ['g', 'l']);
  assert.deepEqual(parseSequence('Ctrl+K, x').tokens, ['ctrl+k', 'x']);
  assert.ok(parseSequence('a b c d').ok === false);
  assert.ok(parseSequence('').ok === false);
  assert.ok(parseSequence('ctrl+alt').ok === false); // 没有主键
  assert.equal(parseSequence('shift+k').tokens[0], 'shift+k');
});

test('最近祖先：B 的 X 被 A 覆盖，root X 标记 shadowed', () => {
  const eff = computeEffective(state, 'b');
  const active = eff.entries.filter((e) => e.state !== 'shadowed');
  assert.ok(active.some((e) => e.commandId === 'c4')); // a-x 生效
  assert.ok(!active.some((e) => e.commandId === 'c1')); // root-x 不生效
  const shadow = eff.entries.find((e) => e.commandId === 'c1');
  assert.equal(shadow.state, 'shadowed');
});

test('同层相同序列：duplicate 冲突且双方都在生效列表', () => {
  const eff = computeEffective(state, 'a');
  const c5 = eff.entries.find((e) => e.commandId === 'c5');
  const c6 = eff.entries.find((e) => e.commandId === 'c6');
  assert.equal(c5.state, 'duplicate');
  assert.equal(c6.state, 'duplicate');
  assert.ok(eff.conflicts.some((c) => c.type === 'duplicate' && c.parties.length === 2));
});

test('前缀冲突：根的 G 与 G D 双方标记，且包含跨层情况', () => {
  const effRoot = computeEffective(state, 'root');
  assert.ok(effRoot.conflicts.some((c) => c.type === 'prefix'));
  const g = effRoot.entries.find((e) => e.commandId === 'c2');
  const gd = effRoot.entries.find((e) => e.commandId === 'c3');
  assert.equal(g.prefix, 'prefix');
  assert.equal(gd.prefix, 'extension');

  // B 层：B 的 G（c7）与 root 的 G D（c3）构成跨层前缀冲突
  const effB = computeEffective(state, 'b');
  assert.ok(
    effB.conflicts.some(
      (c) => c.type === 'prefix' && c.parties.some((p) => p.commandId === 'c7') && c.parties.some((p) => p.commandId === 'c3'),
    ),
  );
  // root 的 G（c2）在 B 下被覆盖，不参与前缀冲突
  assert.ok(!effB.conflicts.some((c) => c.parties.some((p) => p.commandId === 'c2')));
});

test('生效绑定只包含当前上下文链上的命令，兄弟上下文不串入', () => {
  const eff = computeEffective(state, 'b');
  assert.ok(!eff.entries.some((e) => e.commandId === 'c8'));
});

test('逐键模拟：idle → waiting → triggered', () => {
  let r = evaluateKey(state, 'root', []);
  assert.equal(r.status, 'idle');
  r = evaluateKey(state, 'root', ['g']);
  assert.equal(r.status, 'triggered'); // G 自身是命令
  assert.ok(r.candidates.length >= 1); // 同时是 G D 的前缀
  assert.ok(r.candidates.some((c) => c.sequenceLabel === 'G D'));
  r = evaluateKey(state, 'root', ['g', 'd']);
  assert.equal(r.status, 'triggered');
  assert.equal(r.triggered[0].commandId, 'c3');
});

test('逐键模拟：等待态与无匹配', () => {
  // A 层没有 G 单独命令，只有 root 的 G（在 A 下仍生效）。构造更独立的场景：
  const st2 = {
    contexts: [{ id: 'r', parentId: null, name: 'R' }],
    commands: [{ id: 'z1', contextId: 'r', name: 'zab', sequenceTokens: ['z', 'a', 'b'], sequenceLabel: 'Z A B', description: '' }],
  };
  assert.equal(evaluateKey(st2, 'r', ['z']).status, 'waiting');
  assert.equal(evaluateKey(st2, 'r', ['z', 'a']).status, 'waiting');
  assert.equal(evaluateKey(st2, 'r', ['z', 'a', 'b']).status, 'triggered');
  assert.equal(evaluateKey(st2, 'r', ['x']).status, 'no-match');
  assert.equal(evaluateKey(st2, 'r', ['z', 'q']).status, 'no-match');
});

test('逐键模拟：duplicate 命中时 triggered 含双方', () => {
  const r = evaluateKey(state, 'a', ['y']);
  assert.equal(r.status, 'triggered');
  const ids = r.triggered.map((t) => t.commandId).sort();
  assert.deepEqual(ids, ['c5', 'c6']);
});

// ---------- 时序回放 ----------
const replayState = {
  contexts: [{ id: 'r', parentId: null, name: 'R' }],
  commands: [
    { id: 'short', contextId: 'r', name: 'go', sequenceTokens: ['g'], sequenceLabel: 'G', description: '' },
    { id: 'long2', contextId: 'r', name: 'gd', sequenceTokens: ['g', 'd'], sequenceLabel: 'G D', description: '' },
    { id: 'long3', contextId: 'r', name: 'gdd', sequenceTokens: ['g', 'd', 'd'], sequenceLabel: 'G D D', description: '' },
    { id: 'solo', contextId: 'r', name: 'x-cmd', sequenceTokens: ['x'], sequenceLabel: 'X', description: '' },
  ],
};
const P = (token, timeMs, timeoutMs) => (timeoutMs === undefined ? { token, timeMs } : { token, timeMs, timeoutMs });

test('时序回放：阈值内续键沿前缀链推进（短序列不触发），截止时刻逐键重置', () => {
  // g@0 pending(G)；d@500 精确命中 G D 且仍是 G D D 前缀 => 继续 pending(G D)，
  // 截止时刻以 d 的时刻重置为 1300；时间线结束超时触发 G D（而不是 G）
  const r = replayTimeline(replayState, 'r', { presses: [P('g', 0), P('d', 500)] }, { timeoutMs: 800 });
  assert.equal(r.events.length, 3);
  assert.equal(r.events[0].status, 'pending');
  assert.deepEqual(r.events[0].held.map((c) => c.commandId), ['short']);
  assert.equal(r.events[0].candidates.length, 2); // G D、G D D
  assert.equal(r.events[1].status, 'pending');
  assert.deepEqual(r.events[1].held.map((c) => c.commandId), ['long2']);
  assert.equal(r.events[2].type, 'timeout');
  assert.equal(r.events[2].timeMs, 1300); // 500 + 800，截止时刻逐键重置
  assert.deepEqual(r.events[2].triggered.map((c) => c.commandId), ['long2']);
});

test('时序回放：超时触发短序列，并记录超时事件的时间点', () => {
  const r = replayTimeline(replayState, 'r', { presses: [P('g', 100)] }, { timeoutMs: 800 });
  assert.equal(r.events.length, 2);
  assert.equal(r.events[0].status, 'pending');
  assert.equal(r.events[1].type, 'timeout');
  assert.equal(r.events[1].status, 'timeout');
  assert.equal(r.events[1].timeMs, 900); // 100 + 800
  assert.deepEqual(r.events[1].triggered.map((c) => c.commandId), ['short']);
  assert.equal(r.fired[0].atMs, 900);
});

test('时序回放：阈值外续键先补发短序列，续键作为新输入重新判定', () => {
  // g@0 待定，d@900 超过 800ms：800ms 超时触发 G；d 单独无匹配
  const r = replayTimeline(replayState, 'r', { presses: [P('g', 0), P('d', 900)] }, { timeoutMs: 800 });
  assert.equal(r.events[0].status, 'pending');
  assert.equal(r.events[1].type, 'timeout');
  assert.equal(r.events[1].timeMs, 800);
  assert.deepEqual(r.events[1].triggered.map((c) => c.commandId), ['short']);
  assert.equal(r.events[2].status, 'no-match');
  assert.equal(r.events[2].restartFrom, false); // 超时已清空缓冲，d 是全新输入
  // 最终只触发过短序列一次
  assert.deepEqual(r.fired.map((f) => f.atMs), [800]);
});

test('时序回放：无匹配从当前按键重新起算，不吞键（当前键可独立命中）', () => {
  // z 无匹配被丢弃后按 x：x 独立命中，事件携带 restartFrom
  const r = replayTimeline(replayState, 'r', { presses: [P('z', 0), P('x', 10)] });
  assert.equal(r.events[0].status, 'no-match');
  assert.equal(r.events[0].restartFrom, false);
  assert.equal(r.events[1].status, 'triggered');
  assert.equal(r.events[1].restartFrom, true);
  assert.deepEqual(r.events[1].triggered.map((c) => c.commandId), ['solo']);
  assert.equal(r.events[1].discardedLabel, 'X'); // 上一键已在 no-match 事件中丢弃
});

test('时序回放：待定中续键偏离长序列则放弃短序列并从当前键重新起算', () => {
  // g@0 待定，x@100 不匹配任何 G 延伸：短序列不触发（被放弃），x 重新起算命中
  const r = replayTimeline(replayState, 'r', { presses: [P('g', 0), P('x', 100)] }, { timeoutMs: 800 });
  assert.equal(r.events[0].status, 'pending');
  assert.equal(r.events[1].status, 'triggered');
  assert.equal(r.events[1].restartFrom, true);
  assert.deepEqual(r.events[1].triggered.map((c) => c.commandId), ['solo']);
  assert.deepEqual(r.events[1].droppedHeld, ['short']);
  assert.equal(r.firedCount, 1); // 短序列被放弃，仅 x 触发
});

test('时序回放：三级前缀链 pending → pending → 长序列触发', () => {
  // g@0 pending，d@100：同时精确命中 G D 且是 G D D 前缀 => 仍 pending；
  // d@200：触发 G D D
  const r = replayTimeline(replayState, 'r', { presses: [P('g', 0), P('d', 100), P('d', 200)] }, { timeoutMs: 800 });
  assert.equal(r.events[0].status, 'pending');
  assert.equal(r.events[1].status, 'pending');
  assert.deepEqual(r.events[1].held.map((c) => c.commandId), ['long2']);
  assert.equal(r.events[2].status, 'triggered');
  assert.deepEqual(r.events[2].triggered.map((c) => c.commandId), ['long3']);
  assert.equal(r.status, 'idle');
});

test('时序回放：每键可用自身 timeoutMs 覆盖全局阈值', () => {
  const r = replayTimeline(replayState, 'r', { presses: [P('g', 0, 300)] }, { timeoutMs: 800 });
  assert.equal(r.timeoutMs, 800); // 回显全局阈值
  assert.equal(r.events[0].timeoutMs, 300); // 该键实际生效阈值
  assert.equal(r.events[1].timeMs, 300);
  assert.equal(r.events[1].timeoutMs, 300);
});

test('时序回放：纯等待超过全局阈值不会误触发（无待定短序列）', () => {
  // 只有长前缀、无短序列命中的上下文：等待结束不产生任何触发
  const st2 = {
    contexts: [{ id: 'r', parentId: null, name: 'R' }],
    commands: [
      { id: 'z1', contextId: 'r', name: 'zab', sequenceTokens: ['z', 'a', 'b'], sequenceLabel: 'Z A B', description: '' },
    ],
  };
  const r = replayTimeline(st2, 'r', { presses: [P('z', 0), P('a', 100)] }, { timeoutMs: 800 });
  assert.equal(r.events[0].status, 'waiting');
  assert.equal(r.events[1].status, 'waiting');
  assert.equal(r.firedCount, 0);
  assert.equal(r.status, 'waiting');
  // 末尾不补发 timeout 事件
  assert.ok(r.events.every((e) => e.type === 'press'));
});

test('时序回放：非法输入被拒绝（400）', () => {
  assert.throws(() => replayTimeline(replayState, 'r', {}), /presses/);
  assert.throws(() => replayTimeline(replayState, 'r', { presses: [] }), /至少需要一次/);
  assert.throws(
    () => replayTimeline(replayState, 'r', { presses: [P('g', 10), P('d', 5)] }),
    /单调不减/,
  );
  assert.throws(
    () => replayTimeline(replayState, 'r', { presses: [{ token: 'g', timeMs: -1 }] }),
    /timeMs/,
  );
  assert.throws(
    () => replayTimeline(replayState, 'r', { presses: [P('g', 0, -3)] }),
    /timeoutMs/,
  );
});

test('上下文路径展示双方来源', () => {
  const eff = computeEffective(state, 'b');
  const conflict = eff.conflicts.find((c) => c.type === 'prefix');
  assert.ok(conflict.parties.every((p) => typeof p.contextPath === 'string' && p.contextPath.length > 0));
  const labels = conflict.parties.map((p) => p.shortestLabel);
  assert.ok(labels.includes('G') && labels.includes('G D'));
});

// ---------- 回归套件生成 ----------
test('回归套件：叶子候选与精确集合覆盖（最小叶子数）', () => {
  const suite = generateRegressionSuite(state);
  // 叶子：B 与 Sibling（Root、A 不是叶子）
  assert.equal(suite.stats.leafCount, 2);
  assert.deepEqual(
    suite.candidates.map((c) => c.contextId).sort(),
    ['b', 'sibling'],
  );
  // 目标：8 条命令在至少一个叶子可触发（c1 在 Sibling 生效）+ duplicate 1
  // + prefix 2（B 下 c7⊂c3 与 Sibling 下 c2⊂c3 是两个不同冲突身份）
  assert.equal(suite.stats.triggerableCommandCount, 8);
  assert.equal(suite.stats.duplicateConflictCount, 1);
  assert.equal(suite.stats.prefixConflictCount, 2);
  assert.equal(suite.stats.coveredGoalCount, suite.stats.coverableGoalCount);
  // 必须同时入选两个叶子：Sibling 独有 c8/k，B 独有 duplicate 与跨层 prefix
  assert.equal(suite.stats.selectedContextCount, 2);
  const selectedIds = suite.suite.map((tc) => tc.contextId).sort();
  assert.deepEqual(selectedIds, ['b', 'sibling']);

  const bCase = suite.suite.find((tc) => tc.contextId === 'b');
  // 每个入选上下文列出输入序列、预期触发命令集合
  const yInput = bCase.inputs.find((i) => i.sequenceLabel === 'Y');
  assert.equal(yInput.duplicate, true);
  assert.deepEqual(
    yInput.expectedCommands.map((c) => c.commandId).sort(),
    ['c5', 'c6'],
  );
  // 预期冲突类型同时包含 duplicate 与 prefix
  assert.deepEqual(
    bCase.expectedConflicts.map((c) => c.type).sort(),
    ['duplicate', 'prefix'],
  );
});

test('回归套件：任何叶子都无法触发的命令单列原因，不计入覆盖', () => {
  // u1 定义在根、序列 S：在叶子 B 被 A 层同序列覆盖，在叶子 S 被自身同序列覆盖
  const st = {
    contexts: [
      { id: 'r', parentId: null, name: 'R' },
      { id: 'a', parentId: 'r', name: 'A' },
      { id: 'b', parentId: 'a', name: 'B' },
      { id: 's', parentId: 'r', name: 'S' },
    ],
    commands: [
      { id: 'u1', contextId: 'r', name: 'r-save', sequenceTokens: ['s'], sequenceLabel: 'S', description: '' },
      { id: 'a1', contextId: 'a', name: 'a-save', sequenceTokens: ['s'], sequenceLabel: 'S', description: '' },
      { id: 's1', contextId: 's', name: 's-save', sequenceTokens: ['s'], sequenceLabel: 'S', description: '' },
      { id: 'ok', contextId: 'r', name: 'r-quit', sequenceTokens: ['q'], sequenceLabel: 'Q', description: '' },
    ],
  };
  const suite = generateRegressionSuite(st);
  const unreachable = suite.unreachableCommands.find((u) => u.commandId === 'u1');
  assert.ok(unreachable, 'u1 应列为不可触发');
  assert.match(unreachable.reason, /覆盖/);
  assert.deepEqual(unreachable.shadowedBy.map((s) => s.contextId).sort(), ['a', 's']);
  // 不可触发命令不算可触发、不算已覆盖
  assert.equal(suite.stats.triggerableCommandCount, 3); // a1 / s1 / ok
  assert.equal(suite.stats.unreachableCommandCount, 1);
  assert.ok(
    !suite.suite.some((tc) => tc.inputs.some((i) => i.expectedCommands.some((c) => c.commandId === 'u1'))),
  );
  // 但可触发目标仍被完整覆盖
  assert.equal(suite.stats.coveredGoalCount, suite.stats.coverableGoalCount);
});

test('回归套件：定义在非叶子上下文且子树无覆盖时命令仍可在叶子触发', () => {
  // c2(root G)、c3(root G D) 在 A、B、Sibling 都生效
  const suite = generateRegressionSuite(state);
  assert.ok(!suite.unreachableCommands.some((u) => u.commandId === 'c2'));
  assert.ok(!suite.unreachableCommands.some((u) => u.commandId === 'c3'));
});

test('回归套件：非叶子上下文独占（无叶子后代）的命令不可触发', () => {
  const st = {
    contexts: state.contexts,
    commands: [
      ...state.commands,
      { id: 'c11', contextId: 'a', name: 'a-only', sequenceTokens: ['q'], sequenceLabel: 'Q', description: '' },
      { id: 'c12', contextId: 'b', name: 'b-cover-q', sequenceTokens: ['q'], sequenceLabel: 'Q', description: '' },
    ],
  };
  const suite = generateRegressionSuite(st);
  // A 有子 B：Q 在 B 被覆盖，A 没有其他叶子后代
  const u = suite.unreachableCommands.find((x) => x.commandId === 'c11');
  assert.ok(u);
  assert.match(u.reason, /全部 1 个叶子/);
});

test('回归套件：同解时按上下文路径字典序稳定选择', () => {
  // 两个叶子 zfirst / asecond 覆盖目标完全相同 => 任选其一；应选路径字典序更小的
  const st = {
    contexts: [
      { id: 'r', parentId: null, name: 'R' },
      { id: 'zc', parentId: 'r', name: 'Zchild', description: '' },
      { id: 'ac', parentId: 'r', name: 'Achild', description: '' },
    ],
    commands: [
      { id: 'm1', contextId: 'r', name: 'm-save', sequenceTokens: ['s'], sequenceLabel: 'S', description: '' },
    ],
  };
  const suite = generateRegressionSuite(st);
  assert.equal(suite.stats.selectedContextCount, 1);
  assert.equal(suite.suite[0].contextId, 'ac'); // R / Achild < R / Zchild
});

test('minimumSetCover：最小数量 + 字典序平局的基本性质', () => {
  const mk = (contextPath, arr) => ({ contextPath, covers: new Set(arr) });
  const candidates = [
    mk('Z', ['x']),
    mk('A', ['x']), // 与 Z 同覆盖，路径更小
    mk('M', ['y']),
    mk('B', ['x', 'y']),
  ];
  const picked = minimumSetCover(candidates, new Set(['x', 'y']));
  assert.equal(picked.length, 1);
  assert.equal(picked[0].contextPath, 'B'); // 单集合可覆盖全部

  const picked2 = minimumSetCover(
    [mk('Z', ['x']), mk('A', ['x']), mk('Y', ['y']), mk('B', ['y'])],
    new Set(['x', 'y']),
  );
  assert.deepEqual(picked2.map((c) => c.contextPath).sort(), ['A', 'B']);
});

test('conflictGoalId：参与命令集合相同即同一冲突身份', () => {
  const dup1 = { type: 'duplicate', parties: [{ commandId: 'c5' }, { commandId: 'c6' }] };
  const dup2 = { type: 'duplicate', parties: [{ commandId: 'c6' }, { commandId: 'c5' }] };
  assert.equal(conflictGoalId(dup1), conflictGoalId(dup2));
  const pre1 = {
    type: 'prefix',
    parties: [
      { commandId: 'c2', role: 'prefix' },
      { commandId: 'c3', role: 'extension' },
    ],
  };
  const pre2 = {
    type: 'prefix',
    parties: [
      { commandId: 'c3', role: 'extension' },
      { commandId: 'c2', role: 'prefix' },
    ],
  };
  assert.equal(conflictGoalId(pre1), conflictGoalId(pre2));
  assert.notEqual(conflictGoalId(pre1), conflictGoalId(dup1));
});

// ---------- 变更沙盒预演 ----------
// 结构：R → A → B（B 为唯一叶子）；m1(R,S) 在 B 被 m2(A,S) 覆盖 => 基线不可触发
const sandboxState = {
  contexts: [
    { id: 'r', parentId: null, name: 'R' },
    { id: 'a', parentId: 'r', name: 'A' },
    { id: 'b', parentId: 'a', name: 'B' },
  ],
  commands: [
    { id: 'm1', contextId: 'r', name: 'root-save', sequenceTokens: ['s'], sequenceLabel: 'S', description: '' },
    { id: 'm2', contextId: 'a', name: 'a-save', sequenceTokens: ['s'], sequenceLabel: 'S', description: '' },
    { id: 'm3', contextId: 'a', name: 'a-jump', sequenceTokens: ['j'], sequenceLabel: 'J', description: '' },
  ],
};

test('沙盒预演：空草案与基线完全一致', () => {
  const res = previewSandbox(sandboxState, {});
  assert.equal(res.stats.totalChanges, 0);
  assert.equal(res.contexts.length, 0);
  assert.equal(res.unreachable.appeared.length, 0);
  assert.equal(res.unreachable.disappeared.length, 0);
});

test('沙盒预演：删除命令后祖先绑定恢复生效，按上下文汇总', () => {
  const res = previewSandbox(sandboxState, { deletes: ['m2'] });
  const ctxB = res.contexts.find((c) => c.contextId === 'b');
  assert.ok(ctxB, 'B 应有变化');
  // m2 的生效绑定消失，m1 从 shadowed 变为生效
  assert.ok(ctxB.effective.disappeared.some((e) => e.commandId === 'm2'));
  assert.ok(ctxB.effective.appeared.some((e) => e.commandId === 'm1'));
  assert.ok(ctxB.shadowed.disappeared.some((e) => e.commandId === 'm1'));
  // 差异条目携带来源路径与最短触发输入
  const m1 = ctxB.effective.appeared.find((e) => e.commandId === 'm1');
  assert.equal(m1.contextPath, 'R');
  assert.equal(m1.shortestLabel, 'S');
  // 被删除命令的条目标记草案来源
  assert.equal(ctxB.effective.disappeared.find((e) => e.commandId === 'm2').draftOp, 'delete');
  // A 层同样受影响，R 层无变化
  assert.ok(res.contexts.some((c) => c.contextId === 'a'));
  assert.ok(!res.contexts.some((c) => c.contextId === 'r'));
});

test('沙盒预演：新增命令在目标上下文及后代生效，不影响祖先', () => {
  const res = previewSandbox(sandboxState, {
    adds: [{ draftId: 'd1', contextId: 'a', name: 'new-cmd', sequence: 'n' }],
  });
  const ctxA = res.contexts.find((c) => c.contextId === 'a');
  const item = ctxA.effective.appeared.find((e) => e.commandId === 'd1');
  assert.equal(item.draftOp, 'add');
  assert.equal(item.contextPath, 'R / A');
  assert.equal(item.shortestLabel, 'N');
  assert.ok(res.contexts.some((c) => c.contextId === 'b'), '后代 B 同样生效');
  assert.ok(!res.contexts.some((c) => c.contextId === 'r'), '祖先 R 不受影响');
});

test('沙盒预演：改序列引发绑定与冲突的新增/消失', () => {
  // m3: J → S，与 m2 构成同层重复；原 J 绑定消失
  const res = previewSandbox(sandboxState, { updates: [{ commandId: 'm3', sequence: 's' }] });
  const ctxA = res.contexts.find((c) => c.contextId === 'a');
  assert.ok(ctxA.effective.disappeared.some((e) => e.commandId === 'm3' && e.sequenceLabel === 'J'));
  assert.ok(ctxA.effective.appeared.some((e) => e.commandId === 'm3' && e.sequenceLabel === 'S'));
  assert.equal(ctxA.effective.appeared.find((e) => e.commandId === 'm3').draftOp, 'update');
  // 同层重复冲突 {m2, m3} 新增，冲突条目带来源与最短触发输入
  assert.equal(ctxA.duplicate.appeared.length, 1);
  const dup = ctxA.duplicate.appeared[0];
  assert.deepEqual(dup.parties.map((p) => p.commandId), ['m2', 'm3']); // 参与方按 id 稳定排序
  assert.ok(dup.parties.every((p) => p.contextPath && p.shortestLabel === 'S'));
});

test('沙盒预演：冲突以参与命令集合配对，集合不变则不计差异', () => {
  const st = {
    contexts: [{ id: 'r', parentId: null, name: 'R' }],
    commands: [
      { id: 'd1', contextId: 'r', name: 'x1', sequenceTokens: ['x'], sequenceLabel: 'X', description: '' },
      { id: 'd2', contextId: 'r', name: 'x2', sequenceTokens: ['x'], sequenceLabel: 'X', description: '' },
      { id: 'q1', contextId: 'r', name: 'q', sequenceTokens: ['q'], sequenceLabel: 'Q', description: '' },
    ],
  };
  // 只改无关命令 => 已有同层重复 {d1,d2} 不计为差异
  const res = previewSandbox(st, { updates: [{ commandId: 'q1', sequence: 'w' }] });
  const ctxR = res.contexts.find((c) => c.contextId === 'r');
  assert.equal(ctxR.duplicate.appeared.length, 0);
  assert.equal(ctxR.duplicate.disappeared.length, 0);
  // 加入第三条同序列命令 => 冲突身份变化：旧集合消失、新集合出现
  const res2 = previewSandbox(st, { adds: [{ draftId: 'd3', contextId: 'r', name: 'x3', sequence: 'x' }] });
  const ctx2 = res2.contexts.find((c) => c.contextId === 'r');
  assert.deepEqual(ctx2.duplicate.disappeared.map((c) => c.goalId), ['dup:d1,d2']);
  assert.deepEqual(ctx2.duplicate.appeared.map((c) => c.goalId), ['dup:d1,d2,d3']);
});

test('沙盒预演：前缀冲突按参与命令集合配对（角色不变即同一冲突）', () => {
  const st = {
    contexts: [{ id: 'r', parentId: null, name: 'R' }],
    commands: [
      { id: 'p1', contextId: 'r', name: 'pre', sequenceTokens: ['j'], sequenceLabel: 'J', description: '' },
      { id: 'p2', contextId: 'r', name: 'ext', sequenceTokens: ['j', 'k'], sequenceLabel: 'J K', description: '' },
    ],
  };
  // 延伸方序列细节变化但参与集合与角色不变 => 同一冲突身份，不计差异
  const same = previewSandbox(st, { updates: [{ commandId: 'p2', sequence: 'j l' }] });
  const ctxR = same.contexts.find((c) => c.contextId === 'r');
  assert.equal(ctxR.prefix.appeared.length, 0);
  assert.equal(ctxR.prefix.disappeared.length, 0);
  // 前缀方改走 => 冲突消失
  const gone = previewSandbox(st, { updates: [{ commandId: 'p1', sequence: 'h' }] });
  const ctxR2 = gone.contexts.find((c) => c.contextId === 'r');
  assert.deepEqual(ctxR2.prefix.disappeared.map((c) => c.goalId), ['pre:p1::p2']);
  assert.equal(ctxR2.prefix.appeared.length, 0);
});

test('沙盒预演：不可触发命令的新增与消失', () => {
  // 基线：m1 在唯一叶子 B 被 m2 覆盖 => 不可触发；删除 m2 后恢复可触发
  const res = previewSandbox(sandboxState, { deletes: ['m2'] });
  assert.deepEqual(res.unreachable.disappeared.map((u) => u.commandId), ['m1']);
  assert.equal(res.unreachable.appeared.length, 0);
  // 反向：在 B 新增同序列命令 => m2 变为不可触发（附原因）
  const res2 = previewSandbox(sandboxState, {
    adds: [{ draftId: 'x1', contextId: 'b', name: 'b-save', sequence: 's' }],
  });
  const m2 = res2.unreachable.appeared.find((u) => u.commandId === 'm2');
  assert.ok(m2, 'm2 应变为不可触发');
  assert.match(m2.reason, /覆盖/);
  assert.equal(m2.contextPath, 'R / A');
});

test('沙盒预演：结果与数据顺序、草案操作顺序无关', () => {
  const draft = {
    adds: [
      { draftId: 'n1', contextId: 'a', name: 'n1', sequence: 'n' },
      { draftId: 'n2', contextId: 'b', name: 'n2', sequence: 'm' },
    ],
    updates: [{ commandId: 'm3', sequence: 'u' }],
    deletes: ['m2'],
  };
  const r1 = previewSandbox(sandboxState, draft);
  // 打乱：上下文顺序、命令顺序、草案内操作顺序全部颠倒
  const shuffled = {
    contexts: [...sandboxState.contexts].reverse(),
    commands: [...sandboxState.commands].reverse(),
  };
  const draft2 = {
    deletes: ['m2'],
    updates: [{ commandId: 'm3', sequence: 'u' }],
    adds: [
      { draftId: 'n2', contextId: 'b', name: 'n2', sequence: 'm' },
      { draftId: 'n1', contextId: 'a', name: 'n1', sequence: 'n' },
    ],
  };
  const r2 = previewSandbox(shuffled, draft2);
  const strip = (r) => {
    const { generatedAt, ...rest } = r;
    return rest;
  };
  assert.deepEqual(strip(r1), strip(r2));
});

test('沙盒预演：非法草案被拒绝', () => {
  assert.throws(
    () => previewSandbox(sandboxState, { updates: [{ commandId: 'm3', sequence: 'a b c d' }] }),
    /新序列无效/,
  );
  assert.throws(() => previewSandbox(sandboxState, { deletes: ['nope'] }), /不存在/);
  assert.throws(
    () => previewSandbox(sandboxState, { deletes: ['m2'], updates: [{ commandId: 'm2', sequence: 'x' }] }),
    /已在草案中删除/,
  );
  assert.throws(
    () => previewSandbox(sandboxState, { adds: [{ draftId: 'm1', contextId: 'a', name: 'x', sequence: 'x' }] }),
    /重复/,
  );
  assert.throws(
    () => previewSandbox(sandboxState, { adds: [{ draftId: 'z', contextId: 'nope', name: 'x', sequence: 'x' }] }),
    /上下文不存在/,
  );
});

test('沙盒预演：纯内存计算，不修改基线状态', () => {
  const before = JSON.stringify(sandboxState);
  previewSandbox(sandboxState, {
    adds: [{ draftId: 'n1', contextId: 'a', name: 'n1', sequence: 'n' }],
    updates: [{ commandId: 'm3', sequence: 'u' }],
    deletes: ['m2'],
  });
  assert.equal(JSON.stringify(sandboxState), before);
});

// ---------- 基线版本指纹与失效操作核对（草案发布） ----------
test('版本指纹：实质内容相同（顺序不同）指纹相同，内容变化指纹变化', () => {
  const reordered = {
    contexts: [...sandboxState.contexts].reverse(),
    commands: [...sandboxState.commands].reverse(),
  };
  assert.equal(stateFingerprint(sandboxState), stateFingerprint(reordered));
  assert.match(stateFingerprint(sandboxState), /^sha256:[0-9a-f]{64}$/);

  const changed = {
    contexts: sandboxState.contexts,
    commands: sandboxState.commands.map((c) =>
      c.id === 'm3' ? { ...c, sequenceTokens: ['u'], sequenceLabel: 'U' } : c,
    ),
  };
  assert.notEqual(stateFingerprint(sandboxState), stateFingerprint(changed));

  // 仅描述变化也视为版本变化
  const descChanged = {
    contexts: sandboxState.contexts.map((c) => (c.id === 'a' ? { ...c, description: 'x' } : c)),
    commands: sandboxState.commands,
  };
  assert.notEqual(stateFingerprint(sandboxState), stateFingerprint(descChanged));
});

test('版本指纹：预演响应携带基线指纹与基线规模', () => {
  const res = previewSandbox(sandboxState, { deletes: ['m2'] });
  assert.equal(res.baseline.fingerprint, stateFingerprint(sandboxState));
  assert.equal(res.baseline.contextCount, 3);
  assert.equal(res.baseline.commandCount, 3);
  // 草案不同不影响基线指纹（基线是当前真实状态）
  const res2 = previewSandbox(sandboxState, { updates: [{ commandId: 'm3', sequence: 'u' }] });
  assert.equal(res2.baseline.fingerprint, res.baseline.fingerprint);
});

test('失效操作核对：目标上下文/命令消失时逐条标出，adds 只看目标上下文', () => {
  // 基线仍为 sandboxState => 无失效
  assert.equal(inspectStaleDraftOps(sandboxState, {
    adds: [{ draftId: 'd1', contextId: 'a', name: 'n', sequence: 'n' }],
    updates: [{ commandId: 'm3', sequence: 'u' }],
    deletes: ['m2'],
  }).stale, false);

  // 上下文 b 被删除：adds 的目标上下文失效；更新/删除的命令消失也失效
  const withoutB = {
    contexts: sandboxState.contexts.filter((c) => c.id !== 'b'),
    commands: sandboxState.commands.filter((c) => c.id !== 'm3' && c.id !== 'm2'),
  };
  const stale = inspectStaleDraftOps(withoutB, {
    adds: [
      { draftId: 'd1', contextId: 'b', name: 'n1', sequence: 'n' },
      { draftId: 'd2', contextId: 'a', name: 'n2', sequence: 'n' },
    ],
    updates: [{ commandId: 'm3', sequence: 'u' }],
    deletes: ['m2', 'm1'], // m2 已删除（失效），m1 仍在（有效）
  });
  assert.equal(stale.stale, true);
  assert.deepEqual(stale.adds, [{ draftId: 'd1', contextId: 'b' }]);
  assert.deepEqual(stale.updates, [{ commandId: 'm3' }]);
  assert.deepEqual(stale.deletes, [{ commandId: 'm2' }]);
});

test('发布可行性：预演新增 duplicate/prefix 冲突可由 stats 与差异检出', () => {
  // m3: J → S 与 m2 同层重复 => duplicateAppeared > 0，不可发布
  const dup = previewSandbox(sandboxState, { updates: [{ commandId: 'm3', sequence: 's' }] });
  assert.ok(dup.stats.duplicateAppeared > 0);
  // 无冲突草案：m3 改到未占用的 u，删除 m2（恢复 m1），不引入任何新冲突
  const clean = previewSandbox(sandboxState, {
    updates: [{ commandId: 'm3', sequence: 'u' }],
    deletes: ['m2'],
  });
  assert.equal(clean.stats.duplicateAppeared, 0);
  assert.equal(clean.stats.prefixAppeared, 0);
});

// ---------- 冲突消解（改键方案搜索） ----------
const resolveState = {
  contexts: [
    { id: 'r', parentId: null, name: 'R' },
    { id: 'h', parentId: 'r', name: 'H' }, // 当前审校上下文：自身前缀链 + 同层重复 + 跨层前缀
  ],
  commands: [
    // 祖先只提供 G K：在 H 生效并与 H 自己的 G 构成跨层前缀（祖先链上无自身前缀冲突）
    { id: 'rkk', contextId: 'r', name: 'root-gk', sequenceTokens: ['g', 'k'], sequenceLabel: 'G K', description: '' },
    { id: 'hg', contextId: 'h', name: 'h-go', sequenceTokens: ['g'], sequenceLabel: 'G', description: '' },
    { id: 'hgd', contextId: 'h', name: 'h-gd', sequenceTokens: ['g', 'd'], sequenceLabel: 'G D', description: '' },
    { id: 'hgdd', contextId: 'h', name: 'h-gdd', sequenceTokens: ['g', 'd', 'd'], sequenceLabel: 'G D D', description: '' },
    { id: 'hx1', contextId: 'h', name: 'h-x1', sequenceTokens: ['x'], sequenceLabel: 'X', description: '' },
    { id: 'hx2', contextId: 'h', name: 'h-x2', sequenceTokens: ['x'], sequenceLabel: 'X', description: '' },
    { id: 'hs', contextId: 'h', name: 'h-save', sequenceTokens: ['s'], sequenceLabel: 'S', description: '' },
  ],
};

test('冲突消解：无冲突时返回零改动方案', () => {
  const st = {
    contexts: [{ id: 'r', parentId: null, name: 'R' }],
    commands: [
      { id: 'k1', contextId: 'r', name: 'a', sequenceTokens: ['a'], sequenceLabel: 'A', description: '' },
      { id: 'k2', contextId: 'r', name: 'b', sequenceTokens: ['b', 'c'], sequenceLabel: 'B C', description: '' },
    ],
  };
  const res = resolveConflicts(st, 'r', { candidates: ['w'] });
  assert.equal(res.solvable, true);
  assert.equal(res.changes.length, 0);
  assert.equal(res.stats.conflictCount, 0);
});

test('冲突消解：前缀链找到无冲突方案，改动数与剩余冲突为 0', () => {
  const res = resolveConflicts(resolveState, 'h', { candidates: ['w', 'q', 'y', 'z'] });
  assert.equal(res.solvable, true, '应当有解');
  // 冲突：G⊂G D、G⊂G D D、G⊂G K（祖先 G K 仍可见）、G D⊂G D D、X 同层重复
  assert.equal(res.stats.duplicateCount, 1);
  assert.equal(res.stats.prefixCount, 4);
  assert.ok(res.changes.length <= 5);
  const changedIds = new Set(res.changes.map((c) => c.commandId));
  // 不动祖先命令
  assert.ok(![...changedIds].some((id) => id.startsWith('r')));
  // 同层重复至少有一方要离开 X
  assert.ok(changedIds.has('hx1') || changedIds.has('hx2'));
  // 应用方案后 computeEffective 必须无冲突
  const sim = {
    contexts: resolveState.contexts,
    commands: resolveState.commands.map((c) => {
      const ch = res.changes.find((x) => x.commandId === c.id);
      return ch
        ? { ...c, sequenceTokens: [...ch.toTokens], sequenceLabel: ch.toLabel, sequenceRaw: ch.toLabel }
        : c;
    }),
  };
  assert.equal(computeEffective(sim, 'h').conflicts.length, 0);
  // draft 结构可直接用于沙盒预演
  assert.deepEqual(res.draft.deletes, []);
  assert.deepEqual(res.draft.adds, []);
  assert.ok(res.draft.updates.every((u) => typeof u.commandId === 'string' && typeof u.sequence === 'string'));
});

test('冲突消解：只改动当前上下文命令，祖先命令不会被改', () => {
  // 在 h 审校：祖先 rkk 参与跨层前缀冲突，但方案只能改 h 自己的命令
  const res = resolveConflicts(resolveState, 'h', { candidates: ['w', 'q', 'y', 'z'] });
  assert.equal(res.solvable, true);
  assert.ok(res.changes.every((c) => c.contextId === 'h'));
  assert.ok(!res.changes.some((c) => c.commandId === 'rkk'), '祖先命令不会被改');
  const sim = {
    contexts: resolveState.contexts,
    commands: resolveState.commands.map((c) => {
      const ch = res.changes.find((x) => x.commandId === c.id);
      return ch ? { ...c, sequenceTokens: [...ch.toTokens], sequenceLabel: ch.toLabel } : c;
    }),
  };
  assert.equal(computeEffective(sim, 'h').conflicts.length, 0);
});

test('冲突消解：锁定冲突双方导致无解（immutable），并列出无法消除的冲突', () => {
  // 独立夹具：当前上下文自身的 G ⊂ G D，锁定双方
  const st = {
    contexts: [{ id: 'r', parentId: null, name: 'R' }],
    commands: [
      { id: 'rg', contextId: 'r', name: 'root-g', sequenceTokens: ['g'], sequenceLabel: 'G', description: '' },
      { id: 'rgg', contextId: 'r', name: 'root-gd', sequenceTokens: ['g', 'd'], sequenceLabel: 'G D', description: '' },
    ],
  };
  const res = resolveConflicts(st, 'r', { candidates: ['w', 'q'], lockedCommandIds: ['rg', 'rgg'] });
  assert.equal(res.solvable, false);
  assert.equal(res.unresolved.length, 1);
  assert.equal(res.unresolved[0].kind, 'immutable');
  assert.match(res.unresolved[0].reason, /锁定/);
  assert.ok(res.unresolved[0].blockedCommands.length >= 2);
});

test('冲突消解：候选池为空且存在可改冲突时无解（pool），扩池后有解', () => {
  // 独立夹具：仅当前上下文的 G ⊂ G D（无祖先间冲突，扩充候选即可解）
  const st = {
    contexts: [{ id: 'r', parentId: null, name: 'R' }],
    commands: [
      { id: 'g1', contextId: 'r', name: 'go', sequenceTokens: ['g'], sequenceLabel: 'G', description: '' },
      { id: 'g2', contextId: 'r', name: 'gd', sequenceTokens: ['g', 'd'], sequenceLabel: 'G D', description: '' },
    ],
  };
  const noPool = resolveConflicts(st, 'r', { candidates: [] });
  assert.equal(noPool.solvable, false);
  assert.ok(noPool.unresolved.every((u) => u.kind === 'pool'));
  const withPool = resolveConflicts(st, 'r', { candidates: ['w', 'q'] });
  assert.equal(withPool.solvable, true);
});

test('冲突消解：最多改动数限制触发 budget 诊断', () => {
  const st = {
    contexts: [{ id: 'r', parentId: null, name: 'R' }],
    commands: [
      { id: 'g1', contextId: 'r', name: 'go', sequenceTokens: ['g'], sequenceLabel: 'G', description: '' },
      { id: 'g2', contextId: 'r', name: 'gd', sequenceTokens: ['g', 'd'], sequenceLabel: 'G D', description: '' },
    ],
  };
  // maxChanges=0：当前冲突数 > 0 必然无解，且单冲突最小改动为 1
  const res = resolveConflicts(st, 'r', { candidates: ['w', 'q'], maxChanges: 0 });
  assert.equal(res.solvable, false);
  assert.ok(res.unresolved.some((u) => u.kind === 'budget'));
  const budgetOne = res.unresolved.find((u) => u.kind === 'budget');
  assert.ok(budgetOne.minChanges >= 1);
});

test('冲突消解：锁定同层重复的一方时，方案强制改另一方', () => {
  const st = {
    contexts: [{ id: 'r', parentId: null, name: 'R' }],
    commands: [
      { id: 'x1', contextId: 'r', name: 'x-one', sequenceTokens: ['x'], sequenceLabel: 'X', description: '' },
      { id: 'x2', contextId: 'r', name: 'x-two', sequenceTokens: ['x'], sequenceLabel: 'X', description: '' },
    ],
  };
  const res = resolveConflicts(st, 'r', { candidates: ['w', 'q'], lockedCommandIds: ['x1'] });
  assert.equal(res.solvable, true);
  const changed = new Set(res.changes.map((c) => c.commandId));
  assert.ok(!changed.has('x1'), '锁定的命令不能改');
  assert.ok(changed.has('x2'), '未锁定的重复方必须离开');
});

test('冲突消解：优先最小改动数，其次总按键数与方案字典序', () => {
  // 独立状态：root 仅有 G ⊂ G K。改单键 G→Q（1 键）与改 G K→Q X（2 键）都只需
  // 1 条改动，总按键数更优的是改 G；单键候选按 label 排序 Q<W，字典序最小。
  const st = {
    contexts: [{ id: 'r', parentId: null, name: 'R' }],
    commands: [
      { id: 'rg', contextId: 'r', name: 'root-g', sequenceTokens: ['g'], sequenceLabel: 'G', description: '' },
      { id: 'rgg', contextId: 'r', name: 'root-gk', sequenceTokens: ['g', 'k'], sequenceLabel: 'G K', description: '' },
    ],
  };
  const res = resolveConflicts(st, 'r', { candidates: ['w', 'q'] });
  assert.equal(res.solvable, true);
  assert.equal(res.stats.changedCommandCount, 1);
  assert.equal(res.stats.totalPresses, 1);
  assert.deepEqual(res.changes.map((c) => c.commandId), ['rg']);
  assert.equal(res.changes[0].toLabel, 'Q');
});

test('冲突消解：方案不引入新冲突（含跨层前缀）', () => {
  // 独立夹具：root 提供 G K（祖先），当前 h 的 G、G D 与其形成前缀链；
  // 候选全部是非 g 前缀的安全键，方案不应把任何命令落到 G 前缀上。
  const st = {
    contexts: [
      { id: 'r', parentId: null, name: 'R' },
      { id: 'h', parentId: 'r', name: 'H' },
    ],
    commands: [
      { id: 'rkk', contextId: 'r', name: 'root-gk', sequenceTokens: ['g', 'k'], sequenceLabel: 'G K', description: '' },
      { id: 'hg', contextId: 'h', name: 'h-go', sequenceTokens: ['g'], sequenceLabel: 'G', description: '' },
      { id: 'hgd', contextId: 'h', name: 'h-gd', sequenceTokens: ['g', 'd'], sequenceLabel: 'G D', description: '' },
    ],
  };
  const res = resolveConflicts(st, 'h', { candidates: ['w', 'q', 'y'] });
  assert.equal(res.solvable, true);
  for (const ch of res.changes) {
    assert.ok(!ch.toTokens[0].startsWith('g'), `改动 ${ch.commandId} 不应落到 G 前缀上：${ch.toLabel}`);
  }
});

test('冲突消解：同层重复双方都是祖先命令、当前无同名命令时为结构不可改', () => {
  // A 上下文本身没有定义命令，冲突（Y 重复）来自 A 自身——换到无自身命令的视角：
  // 在 b 审校时 root 与 a 的命令都是祖先；构造一个当前上下文无任何命令且祖先有前缀冲突
  const st = {
    contexts: [
      { id: 'r', parentId: null, name: 'R' },
      { id: 'c', parentId: 'r', name: 'C' },
    ],
    commands: [
      { id: 'p1', contextId: 'r', name: 'pre', sequenceTokens: ['g'], sequenceLabel: 'G', description: '' },
      { id: 'p2', contextId: 'r', name: 'ext', sequenceTokens: ['g', 'd'], sequenceLabel: 'G D', description: '' },
    ],
  };
  const res = resolveConflicts(st, 'c', { candidates: ['w', 'q'] });
  assert.equal(res.solvable, false);
  assert.ok(res.unresolved.some((u) => u.kind === 'immutable'));
  assert.ok(res.unresolved[0].blockedCommands.every((p) => p.definedHere === false));
});

test('冲突消解：同层覆盖可消除祖先前缀冲突（当前命令 shadow 祖先）', () => {
  // root 只有 G K；h 自己定义了 G，与祖先 G K 构成跨层前缀冲突。
  // 把 h 的命令改到 g k 即可 shadow 祖先组，冲突消失（祖先侧无自身前缀冲突）。
  const st = {
    contexts: [
      { id: 'r', parentId: null, name: 'R' },
      { id: 'h', parentId: 'r', name: 'H' },
    ],
    commands: [
      { id: 'rkk', contextId: 'r', name: 'root-gk', sequenceTokens: ['g', 'k'], sequenceLabel: 'G K', description: '' },
      // 基线冲突：h 的 G 与 root 的 G K（跨层前缀）
      { id: 'hg', contextId: 'h', name: 'h-g', sequenceTokens: ['g'], sequenceLabel: 'G', description: '' },
    ],
  };
  // 改到 g k 可 shadow 祖先组；但总按键数更优的单键 W 也能消解，
  // 优化器应选 W（1 键 < G K 的 2 键）。
  const res = resolveConflicts(st, 'h', { candidates: ['g k', 'w'] });
  assert.equal(res.solvable, true);
  const ch = res.changes.find((c) => c.commandId === 'hg');
  assert.ok(ch);
  assert.equal(ch.toLabel, 'W');
  assert.equal(res.stats.totalPresses, 1);
  // 同时验证 g k 方案也确实可行（shadow 祖先绑定，冲突为 0）
  const sim = {
    contexts: st.contexts,
    commands: st.commands.map((c) => (c.id === 'hg' ? { ...c, sequenceTokens: ['g', 'k'], sequenceLabel: 'G K' } : c)),
  };
  assert.equal(computeEffective(sim, 'h').conflicts.length, 0);
});

test('冲突消解：非法入参返回 400 语义错误', () => {
  assert.throws(() => resolveConflicts(resolveState, 'h', { candidates: ['a b c d'] }), /候选序列/);
  assert.throws(() => resolveConflicts(resolveState, 'h', { lockedCommandIds: ['nope'] }), /不存在/);
  assert.throws(() => resolveConflicts(resolveState, 'h', { maxChanges: -1 }), /最多改动数/);
  assert.throws(() => resolveConflicts(resolveState, 'missing', { candidates: ['w'] }), /上下文不存在/);
});

test('冲突消解：结果与命令定义顺序无关（字典序稳定）', () => {
  // 可解夹具：当前上下文自身的 G⊂G D + X 同层重复（无祖先间冲突）
  const fixture = {
    contexts: [{ id: 'r', parentId: null, name: 'R' }],
    commands: [
      { id: 'g1', contextId: 'r', name: 'go', sequenceTokens: ['g'], sequenceLabel: 'G', description: '' },
      { id: 'g2', contextId: 'r', name: 'gd', sequenceTokens: ['g', 'd'], sequenceLabel: 'G D', description: '' },
      { id: 'x1', contextId: 'r', name: 'x-one', sequenceTokens: ['x'], sequenceLabel: 'X', description: '' },
      { id: 'x2', contextId: 'r', name: 'x-two', sequenceTokens: ['x'], sequenceLabel: 'X', description: '' },
    ],
  };
  const opts = { candidates: ['w', 'q', 'y', 'z'] };
  const r1 = resolveConflicts(fixture, 'r', opts);
  assert.equal(r1.solvable, true);
  const shuffled = { contexts: [...fixture.contexts].reverse(), commands: [...fixture.commands].reverse() };
  const r2 = resolveConflicts(shuffled, 'r', opts);
  const strip = (r) => ({
    solvable: r.solvable,
    stats: { changed: r.stats.changedCommandCount, presses: r.stats.totalPresses },
    changes: r.changes.map((c) => [c.commandId, c.toTokens.join(' ')]),
  });
  assert.deepEqual(strip(r1), strip(r2));
});

test('冲突消解：纯只读，不修改输入状态', () => {
  const before = JSON.stringify(resolveState);
  resolveConflicts(resolveState, 'h', { candidates: ['w', 'q', 'y', 'z'] });
  assert.equal(JSON.stringify(resolveState), before);
});

console.log(`\n引擎测试全部通过：${passed} 项`);