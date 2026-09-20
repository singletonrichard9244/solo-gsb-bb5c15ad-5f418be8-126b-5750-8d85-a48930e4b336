const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const {
  parseSequence,
  buildIndex,
  applyDraft,
  previewSandbox,
  stateFingerprint,
  inspectStaleDraftOps,
} = require('./engine');
const seed = require('./seed');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const DATA_FILE = path.join(DATA_DIR, 'state.json');

let state = { contexts: [], commands: [] };

// ---- 写临界区 ----
// 所有变更（上下文/命令的增改删、沙盒发布）都串行经过同一把内存锁，
// 保证「核对指纹 → 校验草案 → 应用 → 原子落盘」之间不会被其他写入插入。
let writeChain = Promise.resolve();
function withWriteLock(fn) {
  const run = writeChain.then(fn, fn);
  // 不让单个失败中断后续排队的写入
  writeChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

async function init() {
  await fsp.mkdir(DATA_DIR, { recursive: true });
  if (fs.existsSync(DATA_FILE)) {
    try {
      const raw = await fsp.readFile(DATA_FILE, 'utf8');
      const parsed = JSON.parse(raw);
      state = { contexts: parsed.contexts || [], commands: parsed.commands || [] };
      return 'loaded';
    } catch (err) {
      console.warn('[store] 数据文件损坏，回退为初始数据：', err.message);
    }
  }
  state = {
    contexts: seed.contexts.map((c) => ({ ...c })),
    commands: seed.commands.map((c) => ({ ...c })),
  };
  await persist();
  return 'seeded';
}

/** 从数据文件重新载入内存状态（主要供测试重置夹具使用） */
async function reload() {
  return init();
}

function persist() {
  // 写入临时文件后 rename：单次落盘原子化，失败不会留下半截数据文件
  return new Promise((resolve, reject) => {
    fs.writeFile(DATA_FILE + '.tmp', JSON.stringify(state, null, 2), (err) => {
      if (err) return reject(err);
      fs.rename(DATA_FILE + '.tmp', DATA_FILE, (err2) => (err2 ? reject(err2) : resolve()));
    });
  });
}

function snapshot() {
  return {
    contexts: state.contexts.map((c) => ({ ...c })),
    commands: state.commands.map((c) => ({ ...c })),
  };
}

function getContext(id) {
  return state.contexts.find((c) => c.id === id) || null;
}

function assertContextExists(id) {
  const c = getContext(id);
  if (!c) throw Object.assign(new Error('上下文不存在'), { status: 404 });
  return c;
}

/** 收集某上下文的全部后代（用于级联删除） */
function descendantIds(contextId) {
  const index = buildIndex(state.contexts);
  const start = index.byId.get(contextId);
  if (!start) return [];
  const out = [];
  const walk = (node) => {
    out.push(node.id);
    for (const ch of node.children) walk(ch);
  };
  walk(start);
  return out;
}

async function createContext({ name, parentId = null, description = '' }) {
  return withWriteLock(() => createContextLocked({ name, parentId, description }));
}

async function createContextLocked({ name, parentId = null, description = '' }) {
  if (!name || !String(name).trim()) {
    throw Object.assign(new Error('上下文名称不能为空'), { status: 400 });
  }
  if (parentId) assertContextExists(parentId);
  const ctx = {
    id: `ctx-${randomUUID()}`,
    parentId: parentId || null,
    name: String(name).trim(),
    description: String(description || ''),
  };
  state.contexts.push(ctx);
  await persist();
  return ctx;
}

async function updateContext(id, patch) {
  return withWriteLock(() => updateContextLocked(id, patch));
}

async function updateContextLocked(id, patch) {
  const ctx = assertContextExists(id);
  if (patch.name !== undefined) {
    if (!String(patch.name).trim()) throw Object.assign(new Error('上下文名称不能为空'), { status: 400 });
    ctx.name = String(patch.name).trim();
  }
  if (patch.description !== undefined) ctx.description = String(patch.description);
  if (patch.parentId !== undefined) {
    const newParent = patch.parentId || null;
    if (newParent) {
      assertContextExists(newParent);
      if (newParent === id) throw Object.assign(new Error('不能把自身设为父级'), { status: 400 });
      if (descendantIds(id).includes(newParent)) {
        throw Object.assign(new Error('不能把上下文移动到自己的后代下（会形成环）'), { status: 400 });
      }
    }
    ctx.parentId = newParent;
  }
  await persist();
  return ctx;
}

async function deleteContext(id) {
  return withWriteLock(() => deleteContextLocked(id));
}

async function deleteContextLocked(id) {
  assertContextExists(id);
  const ids = new Set(descendantIds(id));
  state.contexts = state.contexts.filter((c) => !ids.has(c.id));
  state.commands = state.commands.filter((cmd) => !ids.has(cmd.contextId));
  await persist();
  return { deletedContexts: ids.size };
}

async function createCommand({ contextId, name, sequence, description = '' }) {
  return withWriteLock(() => createCommandLocked({ contextId, name, sequence, description }));
}

async function createCommandLocked({ contextId, name, sequence, description = '' }) {
  assertContextExists(contextId);
  if (!name || !String(name).trim()) {
    throw Object.assign(new Error('命令名称不能为空'), { status: 400 });
  }
  const parsed = parseSequence(sequence);
  if (!parsed.ok) throw Object.assign(new Error(parsed.error), { status: 400 });
  const cmd = {
    id: `cmd-${randomUUID()}`,
    contextId,
    name: String(name).trim(),
    description: String(description || ''),
    sequenceRaw: String(sequence),
    sequenceTokens: parsed.tokens,
    sequenceLabel: parsed.label,
  };
  state.commands.push(cmd);
  await persist();
  return cmd;
}

async function updateCommand(id, patch) {
  return withWriteLock(() => updateCommandLocked(id, patch));
}

async function updateCommandLocked(id, patch) {
  const cmd = state.commands.find((c) => c.id === id);
  if (!cmd) throw Object.assign(new Error('命令不存在'), { status: 404 });
  if (patch.name !== undefined) {
    if (!String(patch.name).trim()) throw Object.assign(new Error('命令名称不能为空'), { status: 400 });
    cmd.name = String(patch.name).trim();
  }
  if (patch.description !== undefined) cmd.description = String(patch.description);
  if (patch.contextId !== undefined) {
    assertContextExists(patch.contextId);
    cmd.contextId = patch.contextId;
  }
  if (patch.sequence !== undefined) {
    const parsed = parseSequence(patch.sequence);
    if (!parsed.ok) throw Object.assign(new Error(parsed.error), { status: 400 });
    cmd.sequenceRaw = String(patch.sequence);
    cmd.sequenceTokens = parsed.tokens;
    cmd.sequenceLabel = parsed.label;
  }
  await persist();
  return cmd;
}

async function deleteCommand(id) {
  return withWriteLock(() => deleteCommandLocked(id));
}

async function deleteCommandLocked(id) {
  const before = state.commands.length;
  state.commands = state.commands.filter((c) => c.id !== id);
  if (state.commands.length === before) throw Object.assign(new Error('命令不存在'), { status: 404 });
  await persist();
  return { ok: true };
}

/**
 * 沙盒草案发布（在单次写临界区内）：
 * 1. 重新核对预演时返回的基线指纹：与当前状态不一致即拒绝（409，
 *    code=BASELINE_CHANGED），返回当前版本指纹与已失效操作，不产生任何写入；
 * 2. 复用 applyDraft / previewSandbox 的同一套草案校验与生效规则；
 *    模拟状态出现「新增」的 duplicate / prefix 冲突则拒绝（409，
 *    code=DRAFT_CONFLICTS），不落盘任何内容（基线未变，草案保留可直接调整）；
 * 3. 全部通过后才把草案写入内存状态并以 temp+rename 原子落盘：
 *    更新/删除作用于真实命令，新增命令分配真实 cmd-<uuid> id。
 *
 * 任何拒绝路径都在修改 state 之前返回，保证绝不部分落盘。
 */
async function publishDraft(draft, baselineFingerprint) {
  return withWriteLock(() => publishDraftLocked(draft, baselineFingerprint));
}

async function publishDraftLocked(draft, baselineFingerprint) {
  if (typeof baselineFingerprint !== 'string' || !baselineFingerprint.trim()) {
    throw Object.assign(new Error('发布需要预演返回的基线版本指纹 baselineFingerprint'), {
      status: 400,
      code: 'BAD_REQUEST',
    });
  }
  const d = draft || {};
  const size =
    (Array.isArray(d.adds) ? d.adds.length : 0) +
    (Array.isArray(d.updates) ? d.updates.length : 0) +
    (Array.isArray(d.deletes) ? d.deletes.length : 0);
  if (size === 0) {
    throw Object.assign(new Error('草案为空：没有可发布的新增 / 改序列 / 删除操作'), {
      status: 400,
      code: 'BAD_REQUEST',
    });
  }

  // 1) 临界区内重新核对基线指纹
  const currentFingerprint = stateFingerprint(state);
  if (currentFingerprint !== baselineFingerprint) {
    throw Object.assign(new Error('基线数据已变化，请基于最新数据重新预演后再发布'), {
      status: 409,
      code: 'BASELINE_CHANGED',
      details: {
        current: {
          fingerprint: currentFingerprint,
          contextCount: state.contexts.length,
          commandCount: state.commands.length,
        },
        invalidated: inspectStaleDraftOps(state, draft),
      },
    });
  }

  // 2) 复用草案校验：非法草案直接 400（applyDraft 在副本上计算，不触碰 state）
  const { state: simState, draftOps, summary } = applyDraft(state, draft);

  // 3) 复用预演：只允许发布「无新增 duplicate / prefix 冲突」的草案
  const preview = previewSandbox(state, draft);
  const newConflicts = [];
  for (const ctx of preview.contexts) {
    for (const c of ctx.duplicate.appeared) {
      newConflicts.push({
        type: 'duplicate',
        goalId: c.goalId,
        contextId: ctx.contextId,
        contextPath: ctx.contextPath,
        sequenceLabel: c.sequenceLabel,
        commandIds: c.parties.map((p) => p.commandId).sort(),
      });
    }
    for (const c of ctx.prefix.appeared) {
      newConflicts.push({
        type: 'prefix',
        goalId: c.goalId,
        contextId: ctx.contextId,
        contextPath: ctx.contextPath,
        prefixSequenceLabel: c.prefixSequenceLabel,
        extensionSequenceLabel: c.extensionSequenceLabel,
        commandIds: c.parties.map((p) => p.commandId).sort(),
      });
    }
  }
  newConflicts.sort((a, b) =>
    a.goalId === b.goalId
      ? a.contextId < b.contextId
        ? -1
        : a.contextId > b.contextId
          ? 1
          : 0
      : a.goalId < b.goalId
        ? -1
        : 1,
  );
  if (newConflicts.length > 0) {
    throw Object.assign(new Error('预演显示草案引入了新的同层重复 / 前缀冲突，请调整后重新预演再发布'), {
      status: 409,
      code: 'DRAFT_CONFLICTS',
      details: {
        baseline: {
          fingerprint: currentFingerprint,
          contextCount: state.contexts.length,
          commandCount: state.commands.length,
        },
        newConflicts,
      },
    });
  }

  // 4) 全部通过：把模拟状态写入内存。新增命令用 draftId -> 真实 id 映射后重建，
  //    避免真实命令使用前端生成的临时 id。
  const idMap = new Map();
  const contexts = simState.contexts.map((c) => ({ ...c }));
  const commands = simState.commands.map((cmd) => {
    if (draftOps.get(cmd.id) === 'add') {
      const realId = `cmd-${randomUUID()}`;
      idMap.set(cmd.id, realId);
      return { ...cmd, id: realId };
    }
    return { ...cmd, sequenceTokens: [...cmd.sequenceTokens] };
  });

  state = { contexts, commands };
  await persist();

  return {
    format: 'shortcut-sandbox-publish-v1',
    publishedAt: new Date().toISOString(),
    counts: { adds: summary.adds, updates: summary.updates, deletes: summary.deletes },
    addedCommands: summary.addedCommandIds.map((draftId) => {
      const cmd = commands.find((c) => c.id === idMap.get(draftId));
      return {
        draftId,
        commandId: idMap.get(draftId),
        name: cmd ? cmd.name : '',
        contextId: cmd ? cmd.contextId : null,
      };
    }),
    updatedCommandIds: summary.updatedCommandIds,
    deletedCommandIds: summary.deletedCommandIds,
    baseline: {
      fingerprint: stateFingerprint(state),
      contextCount: state.contexts.length,
      commandCount: state.commands.length,
    },
  };
}

module.exports = {
  init,
  reload,
  snapshot,
  createContext,
  updateContext,
  deleteContext,
  createCommand,
  updateCommand,
  deleteCommand,
  publishDraft,
  descendantIds,
};
