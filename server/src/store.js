const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const {
  parseSequence,
  buildIndex,
  stateFingerprint,
  inspectDraftOps,
  prepareSandboxCommit,
} = require('./engine');
const seed = require('./seed');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const DATA_FILE = path.join(DATA_DIR, 'state.json');

let state = { contexts: [], commands: [] };

/**
 * 写操作临界区：所有会修改内存状态并落盘的操作都经由此队列串行执行，
 * 保证「核对指纹 → 校验草案 → 原子写入」之间不会被其它写操作插入。
 */
let writeQueue = Promise.resolve();
function withWriteLock(fn) {
  const run = writeQueue.then(fn);
  writeQueue = run.catch(() => {});
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

/** 把给定状态原子写入数据文件（tmp + rename），并替换内存状态 */
function persistState(nextState) {
  return new Promise((resolve, reject) => {
    fs.writeFile(DATA_FILE + '.tmp', JSON.stringify(nextState, null, 2), (err) => {
      if (err) return reject(err);
      fs.rename(DATA_FILE + '.tmp', DATA_FILE, (err2) => {
        if (err2) return reject(err2);
        state = nextState;
        resolve();
      });
    });
  });
}

function persist() {
  // 简单串行化写入，避免并发覆盖
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

/** 当前数据版本的指纹（与预演响应中的 baselineFingerprint 同一口径） */
function fingerprint() {
  return stateFingerprint(state);
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

async function deleteContextLocked(id) {
  assertContextExists(id);
  const ids = new Set(descendantIds(id));
  state.contexts = state.contexts.filter((c) => !ids.has(c.id));
  state.commands = state.commands.filter((cmd) => !ids.has(cmd.contextId));
  await persist();
  return { deletedContexts: ids.size };
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

async function deleteCommandLocked(id) {
  const before = state.commands.length;
  state.commands = state.commands.filter((c) => c.id !== id);
  if (state.commands.length === before) throw Object.assign(new Error('命令不存在'), { status: 404 });
  await persist();
  return { ok: true };
}

// ---- 对外写接口：统一进入写临界区，串行执行 ----
const createContext = (body) => withWriteLock(() => createContextLocked(body));
const updateContext = (id, patch) => withWriteLock(() => updateContextLocked(id, patch));
const deleteContext = (id) => withWriteLock(() => deleteContextLocked(id));
const createCommand = (body) => withWriteLock(() => createCommandLocked(body));
const updateCommand = (id, patch) => withWriteLock(() => updateCommandLocked(id, patch));
const deleteCommand = (id) => withWriteLock(() => deleteCommandLocked(id));

/**
 * 发布沙盒草案（在单次写临界区内完成全部核对与落盘）：
 * 1. 重新核对基线指纹：数据已被其它操作修改时抛 409（code: sandbox-stale），
 *    携带当前指纹与失效操作清单，不写入任何数据；
 * 2. 复用与预演完全一致的草案校验（非法草案抛 400）；
 * 3. 拒绝引入新增 duplicate / prefix 冲突的草案（抛 409，code: sandbox-conflicts）；
 * 4. 全部通过后一次性原子写入（tmp + rename），绝不部分落盘。
 *
 * 返回 { fingerprint, counts, addedCommands, updatedCommandIds, deletedCommandIds }。
 */
async function commitSandboxDraft(draft, expectedFingerprint) {
  return withWriteLock(async () => {
    const currentFingerprint = stateFingerprint(state);
    if (expectedFingerprint !== currentFingerprint) {
      const inspection = inspectDraftOps(state, draft);
      throw Object.assign(new Error('数据已变化：预演基线已过期，请重新预演后再发布'), {
        status: 409,
        code: 'sandbox-stale',
        details: {
          currentFingerprint,
          invalidCount: inspection.invalidCount,
          invalid: inspection.invalid,
        },
      });
    }

    // 指纹一致：复用草案校验与冲突门禁（非法抛 400，引入新冲突抛 409）
    const { simState, summary } = prepareSandboxCommit(state, draft);

    // 新增命令在预演中使用草案临时 id；落盘前换成正式 id
    const addedCommands = [];
    const finalCommands = simState.commands.map((cmd) => {
      if (!summary.addedCommandIds.includes(cmd.id)) return cmd;
      const published = { ...cmd, id: `cmd-${randomUUID()}` };
      addedCommands.push({
        draftId: cmd.id,
        commandId: published.id,
        name: published.name,
        contextId: published.contextId,
        sequenceLabel: published.sequenceLabel,
      });
      return published;
    });

    await persistState({ contexts: simState.contexts, commands: finalCommands });

    return {
      fingerprint: stateFingerprint(state),
      counts: { adds: summary.adds, updates: summary.updates, deletes: summary.deletes },
      addedCommands: addedCommands.sort((a, b) => (a.draftId < b.draftId ? -1 : a.draftId > b.draftId ? 1 : 0)),
      updatedCommandIds: summary.updatedCommandIds,
      deletedCommandIds: summary.deletedCommandIds,
    };
  });
}

module.exports = {
  init,
  snapshot,
  fingerprint,
  createContext,
  updateContext,
  deleteContext,
  createCommand,
  updateCommand,
  deleteCommand,
  commitSandboxDraft,
  descendantIds,
};
