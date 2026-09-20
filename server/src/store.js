const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { parseSequence, buildIndex } = require('./engine');
const seed = require('./seed');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const DATA_FILE = path.join(DATA_DIR, 'state.json');

let state = { contexts: [], commands: [] };

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
  assertContextExists(id);
  const ids = new Set(descendantIds(id));
  state.contexts = state.contexts.filter((c) => !ids.has(c.id));
  state.commands = state.commands.filter((cmd) => !ids.has(cmd.contextId));
  await persist();
  return { deletedContexts: ids.size };
}

async function createCommand({ contextId, name, sequence, description = '' }) {
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
  const before = state.commands.length;
  state.commands = state.commands.filter((c) => c.id !== id);
  if (state.commands.length === before) throw Object.assign(new Error('命令不存在'), { status: 404 });
  await persist();
  return { ok: true };
}

module.exports = {
  init,
  snapshot,
  createContext,
  updateContext,
  deleteContext,
  createCommand,
  updateCommand,
  deleteCommand,
  descendantIds,
};
