/**
 * 快捷键审校引擎
 * - 最近祖先规则：沿 contextId → parent 向上查找，最深层（最近祖先）的绑定生效
 * - 同层相同序列：重复绑定，双方均触发但标记 duplicate 冲突
 * - 前缀冲突：任一生效序列是另一生效序列的严格前缀时，双方标记 prefix 冲突
 * - 被更深层同序列覆盖的祖先绑定标记为 shadowed（不生效）
 */

const MAX_PRESSES = 3;

const MODIFIERS = new Set(['ctrl', 'alt', 'shift', 'meta']);

/**
 * 规范化单次按键（支持 Ctrl+K 这种组合键，算作“一次按键”）。
 * 返回 { ok, token, error }
 */
function canonicalPress(raw) {
  const segment = String(raw || '').trim().toLowerCase();
  if (!segment) return { ok: false, error: '空按键' };
  const parts = segment
    .split('+')
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length === 0) return { ok: false, error: '空按键' };

  const mods = [];
  const keys = [];
  for (const p of parts) {
    if (MODIFIERS.has(p)) {
      if (!mods.includes(p)) mods.push(p);
    } else {
      keys.push(p);
    }
  }
  if (keys.length !== 1) {
    return { ok: false, error: `按键 "${raw}" 必须恰好包含一个主键（修饰键：Ctrl/Alt/Shift/Meta）` };
  }
  const order = ['ctrl', 'alt', 'shift', 'meta'];
  mods.sort((a, b) => order.indexOf(a) - order.indexOf(b));
  // 规范展示：Ctrl+K
  const pretty = [...mods, keys[0]]
    .map((p) => (MODIFIERS.has(p) ? p[0].toUpperCase() + p.slice(1) : p.length === 1 ? p.toUpperCase() : p))
    .join('+');
  return { ok: true, token: [...mods, keys[0]].join('+'), pretty };
}

/**
 * 解析序列输入。接受空格或逗号分隔的 1~3 次按键，例如：
 *   "g l"  /  "ctrl+k, x"  /  "Ctrl+Shift+p"
 */
function parseSequence(raw) {
  const text = String(raw || '').trim();
  if (!text) return { ok: false, error: '请输入 1~3 次按键' };
  const segments = text.split(/[\s,]+/).filter(Boolean);
  if (segments.length < 1 || segments.length > MAX_PRESSES) {
    return { ok: false, error: `序列必须由 1~${MAX_PRESSES} 次按键组成，当前 ${segments.length} 次` };
  }
  const tokens = [];
  const labels = [];
  for (const seg of segments) {
    const r = canonicalPress(seg);
    if (!r.ok) return { ok: false, error: r.error };
    tokens.push(r.token);
    labels.push(r.pretty);
  }
  return { ok: true, tokens, label: labels.join(' ') };
}

function seqKey(tokens) {
  return tokens.join('');
}

function isPrefix(shorter, longer) {
  if (shorter.length >= longer.length) return false;
  return shorter.every((t, i) => t === longer[i]);
}

function buildIndex(contexts) {
  const byId = new Map();
  const roots = [];
  for (const c of contexts) {
    byId.set(c.id, { ...c, children: [] });
  }
  for (const c of byId.values()) {
    if (c.parentId && byId.has(c.parentId)) {
      byId.get(c.parentId).children.push(c);
    } else {
      roots.push(c);
    }
  }
  return { byId, roots };
}

/** 从某上下文向上到根的链（含自身），自身在前 */
function ancestorChain(index, contextId) {
  const chain = [];
  let cur = index.byId.get(contextId);
  const guard = new Set();
  while (cur) {
    if (guard.has(cur.id)) break;
    guard.add(cur.id);
    chain.push(cur);
    cur = cur.parentId ? index.byId.get(cur.parentId) : null;
  }
  return chain;
}

function contextPath(index, contextId) {
  const chain = ancestorChain(index, contextId).reverse(); // 根 → 当前
  return chain.map((c) => c.name).join(' / ');
}

/**
 * 计算指定上下文下生效的全部绑定。
 * 返回 {
 *   contextId, contextPath, chain: [{id,name,depth}],
 *   entries: 所有绑定（含 shadowed）,
 *   effectiveGroups: 按序列分组的生效绑定,
 *   conflicts: 冲突清单（duplicate / prefix）
 * }
 */
function computeEffective(state, contextId) {
  const index = buildIndex(state.contexts);
  if (!index.byId.has(contextId)) {
    throw Object.assign(new Error('上下文不存在'), { status: 404 });
  }
  const chain = ancestorChain(index, contextId); // [自身, 父, ..., 根]
  const pathStr = contextPath(index, contextId);

  // 仅收集链上上下文定义的命令；链上深度：自身 0。按由近到远的深度排序处理
  const chainIds = new Set(chain.map((c) => c.id));
  const depthOf = new Map(chain.map((c, i) => [c.id, i]));

  const owned = state.commands
    .filter((cmd) => chainIds.has(cmd.contextId))
    .map((cmd) => ({
      cmd,
      contextId: cmd.contextId,
      ownerDepth: depthOf.get(cmd.contextId),
      contextPath: contextPath(index, cmd.contextId),
    }))
    .sort((a, b) => a.ownerDepth - b.ownerDepth);

  const groupsMap = new Map(); // seqKey -> { tokens, label, commands:[record...] }
  const shadowed = []; // 被覆盖的祖先绑定

  for (const record of owned) {
    const { cmd } = record;
    const key = seqKey(cmd.sequenceTokens);
    const existing = groupsMap.get(key);
    if (!existing) {
      groupsMap.set(key, {
        seqKey: key,
        tokens: [...cmd.sequenceTokens],
        label: cmd.sequenceLabel,
        commands: [record],
      });
    } else if (record.ownerDepth === existing.commands[0].ownerDepth) {
      existing.commands.push(record); // 同层重复（duplicate 冲突，双方均生效）
    } else {
      // 更深祖先（更大 depth）的同序列绑定被最近祖先覆盖
      shadowed.push({ ...record, overriddenByDepth: existing.commands[0].ownerDepth });
    }
  }

  // 组状态：同层多命令 => duplicate
  const effectiveGroups = [...groupsMap.values()].map((g) => ({
    ...g,
    duplicate: g.commands.length > 1,
  }));

  // 前缀冲突：生效组两两比较（跨越不同层级也算）
  const prefixPairs = []; // [shortGroup, longGroup]
  for (let i = 0; i < effectiveGroups.length; i++) {
    for (let j = 0; j < effectiveGroups.length; j++) {
      if (i === j) continue;
      const a = effectiveGroups[i];
      const b = effectiveGroups[j];
      if (isPrefix(a.tokens, b.tokens)) {
        prefixPairs.push([a, b]);
      }
    }
  }
  const prefixShortKeys = new Set(prefixPairs.map(([a]) => a.seqKey));
  const prefixLongKeys = new Set(prefixPairs.map(([, b]) => b.seqKey));

  // 汇总 entries
  const entries = [];
  for (const g of effectiveGroups) {
    const prefixRole = prefixShortKeys.has(g.seqKey)
      ? 'prefix'
      : prefixLongKeys.has(g.seqKey)
        ? 'extension'
        : null;
    for (const rec of g.commands) {
      entries.push({
        commandId: rec.cmd.id,
        name: rec.cmd.name,
        description: rec.cmd.description || '',
        contextId: rec.contextId,
        contextPath: rec.contextPath,
        ownerDepth: rec.ownerDepth,
        sequenceTokens: g.tokens,
        sequenceLabel: g.label,
        state: g.duplicate ? 'duplicate' : 'active',
        shadowedBy: null,
        duplicate: g.duplicate,
        prefix: prefixRole, // 'prefix' | 'extension' | null
      });
    }
  }
  for (const rec of shadowed) {
    entries.push({
      commandId: rec.cmd.id,
      name: rec.cmd.name,
      description: rec.cmd.description || '',
      contextId: rec.contextId,
      contextPath: rec.contextPath,
      ownerDepth: rec.ownerDepth,
      sequenceTokens: rec.cmd.sequenceTokens,
      sequenceLabel: rec.cmd.sequenceLabel,
      state: 'shadowed',
      shadowedBy: chain[rec.overriddenByDepth]?.id ?? null,
      duplicate: false,
      prefix: null,
    });
  }
  entries.sort((a, b) => a.sequenceLabel.localeCompare(b.sequenceLabel) || a.ownerDepth - b.ownerDepth);

  // 冲突清单
  const conflicts = [];
  for (const g of effectiveGroups.filter((g) => g.duplicate)) {
    conflicts.push({
      type: 'duplicate',
      kindLabel: '同层序列重复',
      sequenceLabel: g.label,
      sequenceTokens: g.tokens,
      parties: g.commands.map((rec) => ({
        commandId: rec.cmd.id,
        name: rec.cmd.name,
        contextId: rec.contextId,
        contextPath: rec.contextPath,
        sequenceLabel: g.label,
        shortestLabel: g.label,
      })),
    });
  }
  for (const [shortG, longG] of prefixPairs) {
    conflicts.push({
      type: 'prefix',
      kindLabel: '前缀冲突',
      prefixSequenceLabel: shortG.label,
      extensionSequenceLabel: longG.label,
      prefixTokens: shortG.tokens,
      extensionTokens: longG.tokens,
      parties: [
        ...shortG.commands.map((rec) => ({
          commandId: rec.cmd.id,
          name: rec.cmd.name,
          contextId: rec.contextId,
          contextPath: rec.contextPath,
          sequenceLabel: shortG.label,
          shortestLabel: shortG.label,
          role: 'prefix',
        })),
        ...longG.commands.map((rec) => ({
          commandId: rec.cmd.id,
          name: rec.cmd.name,
          contextId: rec.contextId,
          contextPath: rec.contextPath,
          sequenceLabel: longG.label,
          shortestLabel: longG.label,
          role: 'extension',
        })),
      ],
    });
  }

  return {
    contextId,
    contextPath: pathStr,
    chain: chain.map((c, i) => ({ id: c.id, name: c.name, depth: i })).reverse(),
    entries,
    effectiveGroups,
    conflicts,
  };
}

/**
 * 逐键模拟：给定已经按下的按键缓冲，返回当前状态。
 * status:
 *   idle       尚未输入
 *   triggered  精确命中，命令已触发
 *   waiting    已构成某些命令序列的前缀，等待后续按键
 *   no-match   无任何匹配（含缓冲到 3 键仍未命中）
 */
function evaluateKey(state, contextId, bufferTokens) {
  const eff = computeEffective(state, contextId);
  const buffer = bufferTokens || [];

  if (buffer.length === 0) {
    return { status: 'idle', buffer, bufferLabel: '', triggered: [], candidates: [], effective: eff };
  }

  const bufferLabel = buffer.map((t) => pressToPretty(t)).join(' ');
  const groups = eff.effectiveGroups;

  const exact = groups.filter((g) => g.tokens.length === buffer.length && g.tokens.every((t, i) => t === buffer[i]));
  const prefixed = groups.filter((g) => isPrefix(buffer, g.tokens));

  const toCandidate = (g) => ({
    sequenceLabel: g.label,
    sequenceTokens: g.tokens,
    commands: g.commands.map((rec) => ({
      commandId: rec.cmd.id,
      name: rec.cmd.name,
      contextPath: rec.contextPath,
      contextId: rec.contextId,
    })),
    remaining: g.tokens.length - buffer.length,
  });

  if (exact.length > 0) {
    const triggered = [];
    for (const g of exact) {
      for (const rec of g.commands) {
        triggered.push({
          commandId: rec.cmd.id,
          name: rec.cmd.name,
          description: rec.cmd.description || '',
          contextPath: rec.contextPath,
          sequenceLabel: g.label,
          duplicate: g.duplicate,
        });
      }
    }
    // 精确命中的同时若仍是更长序列前缀，给出提示候选
    return {
      status: 'triggered',
      buffer,
      bufferLabel,
      triggered,
      candidates: prefixed.map(toCandidate),
      effective: eff,
    };
  }

  if (prefixed.length > 0 && buffer.length < MAX_PRESSES) {
    return {
      status: 'waiting',
      buffer,
      bufferLabel,
      triggered: [],
      candidates: prefixed.map(toCandidate).sort((a, b) => a.remaining - b.remaining),
      effective: eff,
    };
  }

  return { status: 'no-match', buffer, bufferLabel, triggered: [], candidates: [], effective: eff };
}

const DEFAULT_REPLAY_TIMEOUT_MS = 800;

/** 把生效组映射为逐键候选（还差几键） */
function groupToCandidate(g, bufferLength) {
  return {
    sequenceLabel: g.label,
    sequenceTokens: g.tokens,
    commands: g.commands.map((rec) => ({
      commandId: rec.cmd.id,
      name: rec.cmd.name,
      contextPath: rec.contextPath,
      contextId: rec.contextId,
    })),
    remaining: g.tokens.length - bufferLength,
  };
}

/** 把精确命中的生效组展开为触发命令负载（含 duplicate 标记） */
function groupsToTriggered(exactGroups) {
  const triggered = [];
  for (const g of exactGroups) {
    for (const rec of g.commands) {
      triggered.push({
        commandId: rec.cmd.id,
        name: rec.cmd.name,
        description: rec.cmd.description || '',
        contextPath: rec.contextPath,
        sequenceLabel: g.label,
        duplicate: g.duplicate,
      });
    }
  }
  return triggered;
}

const badReplay = (message) => Object.assign(new Error(message), { status: 400 });

/**
 * 时序回放：按带相对时间戳的按键时间线，复用 computeEffective 的生效绑定判定。
 *
 * 规则：
 * - 短序列既精确命中又是更长生效序列前缀时进入 pending（待定）；阈值内续键匹配
 *   长序列则触发长序列，超过当前按键配置的阈值则超时触发短序列；
 * - 无任何匹配时丢弃旧缓冲、从当前按键重新起算（restart），不吞键；
 * - 每次按键/超时产出一个事件，事件按其在时间线上发生的时刻排序。
 *
 * options:
 *   timeoutMs: 全局超时阈值（毫秒，默认 800）；每次按键可用自身 timeoutMs 覆盖
 * input:
 *   { presses: [{ token | press, timeMs, timeoutMs? }] }
 */
function replayTimeline(state, contextId, input, options = {}) {
  const globalTimeout = Number.isFinite(Number(options.timeoutMs))
    ? Number(options.timeoutMs)
    : DEFAULT_REPLAY_TIMEOUT_MS;
  if (!Number.isInteger(globalTimeout) || globalTimeout < 0) {
    throw badReplay('超时阈值必须是非负整数毫秒');
  }

  const rawPresses = Array.isArray(input?.presses) ? input.presses : null;
  if (!rawPresses) throw badReplay('回放需要 presses（带时间戳的按键数组）');
  if (rawPresses.length === 0) throw badReplay('回放至少需要一次按键');

  const presses = [];
  for (const p of rawPresses) {
    const rawPress = p && typeof p === 'object' ? p.press ?? p.token : p;
    const canonical = canonicalPress(rawPress);
    if (!canonical.ok) throw badReplay(`第 ${presses.length + 1} 次按键无效：${canonical.error}`);
    const t = Number(p && p.timeMs);
    if (!Number.isFinite(t) || t < 0) throw badReplay(`第 ${presses.length + 1} 次按键的 timeMs 必须是非负数`);
    let timeoutMs = globalTimeout;
    if (p && p.timeoutMs !== undefined && p.timeoutMs !== null) {
      timeoutMs = Number(p.timeoutMs);
      if (!Number.isInteger(timeoutMs) || timeoutMs < 0) {
        throw badReplay(`第 ${presses.length + 1} 次按键的 timeoutMs 必须是非负整数毫秒`);
      }
    }
    presses.push({ token: canonical.token, pretty: canonical.pretty, timeMs: t, timeoutMs });
  }
  for (let i = 1; i < presses.length; i++) {
    if (presses[i].timeMs < presses[i - 1].timeMs) {
      throw badReplay(`第 ${i + 1} 次按键的时间早于上一次，时间线必须单调不减`);
    }
  }

  const eff = computeEffective(state, contextId);
  const groups = eff.effectiveGroups;
  const events = [];
  let buffer = [];
  let pending = null; // { commands, groups, deadlineMs, timeoutMs } 待定的短序列
  let lastEventTime = 0;
  let prevNoMatch = false; // 上一按键完全无匹配（已丢弃），下一按键需标记重新起算

  const emit = (event) => {
    events.push({
      seq: events.length + 1,
      timeMs: event.timeMs,
      deltaMs: event.timeMs - lastEventTime,
      ...event,
    });
    lastEventTime = event.timeMs;
  };

  /** 超时结算待定短序列；pending 被消费后置空 */
  const flushPending = () => {
    const held = pending;
    pending = null;
    prevNoMatch = false;
    emit({
      type: 'timeout',
      timeMs: held.deadlineMs,
      status: 'timeout',
      buffer: [...held.groups[0].tokens],
      bufferLabel: held.groups[0].label,
      token: null,
      pretty: null,
      note: `超过 ${held.timeoutMs}ms 未续键，触发待定短序列`,
      timeoutMs: held.timeoutMs,
      triggered: groupsToTriggered(held.groups),
      candidates: [],
      held: [],
      restartFrom: false,
    });
    buffer = [];
  };

  for (const press of presses) {
    // 续键到达时待定阈值已到：先补发超时事件，触发短序列
    if (pending && press.timeMs > pending.deadlineMs) flushPending();

    const timeoutMs = press.timeoutMs;
    const restarted = buffer.length > 0 || prevNoMatch; // 当前键之前已有（未结算的）缓冲
    // 重新起算时被丢弃的内容：含此前缓冲 + 追加当前键后仍不匹配的完整串
    const discardedTokens = [...buffer, press.token];
    const discardedLabel = discardedTokens.map((t) => pressToPretty(t)).join(' ');
    const droppedHeld = pending ? pending.commands.map((c) => c.commandId) : [];

    buffer = [...buffer, press.token];
    const bufferLabel = buffer.map((t) => pressToPretty(t)).join(' ');

    const exact = groups.filter(
      (g) => g.tokens.length === buffer.length && g.tokens.every((t, i) => t === buffer[i]),
    );
    const prefixed = groups.filter((g) => isPrefix(buffer, g.tokens));

    const base = {
      type: 'press',
      timeMs: press.timeMs,
      token: press.token,
      pretty: press.pretty,
      timeoutMs,
    };
    const restartInfo = restarted
      ? { restartFrom: true, discardedTokens: [...buffer], discardedLabel, droppedHeld }
      : { restartFrom: false };
    const restartNote = (tail) =>
      restarted ? `旧缓冲 ${discardedLabel} 无匹配，从当前按键重新起算；${tail}` : tail;

    if (exact.length > 0 && prefixed.length > 0) {
      // 精确命中短序列且是更长序列前缀：进入待定，不立即触发
      const held = groupsToTriggered(exact);
      pending = { commands: held, groups: exact, deadlineMs: press.timeMs + timeoutMs, timeoutMs };
      prevNoMatch = false;
      emit({
        ...base,
        ...restartInfo,
        buffer: [...buffer],
        bufferLabel,
        status: 'pending',
        note: restarted
          ? restartNote(`精确命中且为前缀，待定 ${timeoutMs}ms`)
          : `精确命中且为更长序列前缀，${timeoutMs}ms 内续键触发长序列，超时触发短序列`,
        triggered: [],
        candidates: prefixed.map((g) => groupToCandidate(g, buffer.length)),
        held,
      });
    } else if (exact.length > 0) {
      pending = null;
      prevNoMatch = false;
      buffer = [];
      emit({
        ...base,
        ...restartInfo,
        buffer: restarted ? [press.token] : [...buffer],
        bufferLabel: restarted ? press.pretty : bufferLabel,
        status: 'triggered',
        note: restarted ? restartNote('当前按键精确命中') : '',
        triggered: groupsToTriggered(exact),
        candidates: [],
        held: [],
      });
    } else if (prefixed.length > 0 && buffer.length < MAX_PRESSES) {
      // 纯前缀等待：保留此前待定短序列的截止时刻（若有）
      prevNoMatch = false;
      emit({
        ...base,
        ...restartInfo,
        buffer: [...buffer],
        bufferLabel,
        status: 'waiting',
        note: restarted
          ? restartNote('当前按键构成更长序列前缀')
          : pending
            ? `待定短序列保留至 ${pending.deadlineMs}ms，继续续键匹配长序列`
            : '已构成更长序列的前缀，等待后续按键',
        triggered: [],
        candidates: prefixed
          .map((g) => groupToCandidate(g, buffer.length))
          .sort((a, b) => a.remaining - b.remaining),
        held: pending ? pending.commands : [],
      });
    } else {
      // 无匹配：丢弃全部旧缓冲（含待定短序列），从当前按键单独重新判定，避免吞键
      pending = null;
      buffer = [press.token];
      const reExact = groups.filter((g) => g.tokens.length === 1 && g.tokens[0] === press.token);
      const rePrefixed = groups.filter((g) => isPrefix([press.token], g.tokens));

      if (reExact.length > 0 && rePrefixed.length > 0) {
        const held = groupsToTriggered(reExact);
        pending = { commands: held, groups: reExact, deadlineMs: press.timeMs + timeoutMs, timeoutMs };
        prevNoMatch = false;
        emit({
          ...base,
          ...restartInfo,
          buffer: [press.token],
          bufferLabel: press.pretty,
          status: 'pending',
          note: restartNote(`精确命中且为前缀，待定 ${timeoutMs}ms`),
          triggered: [],
          candidates: rePrefixed.map((g) => groupToCandidate(g, 1)),
          held,
        });
      } else if (reExact.length > 0) {
        buffer = [];
        prevNoMatch = false;
        emit({
          ...base,
          ...restartInfo,
          buffer: [press.token],
          bufferLabel: press.pretty,
          status: 'triggered',
          note: restarted ? restartNote('当前按键精确命中') : '',
          triggered: groupsToTriggered(reExact),
          candidates: [],
          held: [],
        });
      } else if (rePrefixed.length > 0) {
        prevNoMatch = false;
        emit({
          ...base,
          ...restartInfo,
          buffer: [press.token],
          bufferLabel: press.pretty,
          status: 'waiting',
          note: restarted ? restartNote('当前按键构成更长序列前缀') : '',
          triggered: [],
          candidates: rePrefixed
            .map((g) => groupToCandidate(g, 1))
            .sort((a, b) => a.remaining - b.remaining),
          held: [],
        });
      } else {
        // 当前键单独也无匹配：完全丢弃（buffer 清空），下一按键重新起算且不吞键
        buffer = [];
        pending = null;
        prevNoMatch = true;
        emit({
          ...base,
          ...restartInfo,
          buffer: [],
          bufferLabel: '',
          status: 'no-match',
          note: restarted
            ? `旧缓冲 ${discardedLabel} 无匹配，当前按键也不匹配，已丢弃并从下一次按键重新起算`
            : '无任何匹配序列，已丢弃并从下一次按键重新起算',
          triggered: [],
          candidates: [],
          held: [],
        });
      }
    }
  }

  // 时间线结束时仍有待定短序列：超时触发
  if (pending) flushPending();

  const fired = events
    .filter((e) => e.triggered.length > 0)
    .map((e) => ({ atMs: e.timeMs, eventType: e.type, commands: e.triggered }));

  return {
    format: 'shortcut-replay-v1',
    contextId,
    contextPath: eff.contextPath,
    timeoutMs: globalTimeout,
    pressCount: presses.length,
    status: prevNoMatch ? 'no-match' : pending ? 'pending' : buffer.length > 0 ? 'waiting' : 'idle',
    durationMs: events.length > 0 ? events[events.length - 1].timeMs : 0,
    firedCount: fired.length,
    events,
    fired,
  };
}

/** 收集某上下文子树内的全部叶子上下文（无子上下文） */
function descendantLeaves(index, contextId) {
  const start = index.byId.get(contextId);
  if (!start) return [];
  const out = [];
  const walk = (node) => {
    if (node.children.length === 0) out.push(node);
    else node.children.forEach(walk);
  };
  walk(start);
  return out;
}

/**
 * 冲突的稳定身份：同一组命令形成的冲突在不同叶子下视为同一个测试目标。
 * - duplicate：dup:<双方命令id排序>
 * - prefix：pre:<前缀方命令id排序>::<延伸方命令id排序>
 */
function conflictGoalId(conflict) {
  if (conflict.type === 'duplicate') {
    const ids = conflict.parties.map((p) => p.commandId).sort();
    return `dup:${ids.join(',')}`;
  }
  const prefixIds = conflict.parties
    .filter((p) => p.role === 'prefix')
    .map((p) => p.commandId)
    .sort();
  const extensionIds = conflict.parties
    .filter((p) => p.role === 'extension')
    .map((p) => p.commandId)
    .sort();
  return `pre:${prefixIds.join(',')}::${extensionIds.join(',')}`;
}

function setCoversAll(container, subset) {
  for (const g of subset) if (!container.has(g)) return false;
  return true;
}

/** 路径数组字典序比较（排序后比较；短前缀更小） */
function lexLessPaths(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] < b[i]) return true;
    if (a[i] > b[i]) return false;
  }
  return a.length < b.length;
}

/**
 * 精确集合覆盖：在候选集合中找出覆盖 universe 所需候选数量最少的组合。
 * candidates 已按 contextPath 字典序升序排列；同解（数量相同）时保留
 * 入选路径排序后字典序最小的组合，保证结果稳定、与数据顺序无关。
 * 分支限界（MRV 选目标 + 覆盖数下界 + 贪心初始上界 + 记忆剪枝），精确求解。
 */
function minimumSetCover(candidates, universe) {
  if (universe.size === 0 || candidates.length === 0) return [];

  // 按路径字典序排序，使支配精简与平局判定不依赖调用方的传入顺序
  const sorted = candidates
    .slice()
    .sort((a, b) => (a.contextPath < b.contextPath ? -1 : a.contextPath > b.contextPath ? 1 : 0));

  // 支配精简：仅允许“路径字典序更小且覆盖为超集”的候选淘汰后者，
  // 这样不会丢掉可能构成字典序更优同解的候选。
  const alive = sorted.map(() => true);
  for (let b = 1; b < sorted.length; b++) {
    for (let a = 0; a < b; a++) {
      if (alive[a] && setCoversAll(sorted[a].covers, sorted[b].covers)) {
        alive[b] = false;
        break;
      }
    }
  }
  const sets = sorted.filter((_, i) => alive[i]);

  // 贪心求一个可行上界（同等新增覆盖数时取路径更小者）
  const greedyPick = () => {
    const remaining = new Set(universe);
    const picked = [];
    while (remaining.size > 0) {
      let bestIdx = -1;
      let bestCount = -1;
      sets.forEach((c, ci) => {
        let n = 0;
        for (const g of c.covers) if (remaining.has(g)) n++;
        if (
          n > bestCount ||
          (n === bestCount && bestIdx >= 0 && c.contextPath < sets[bestIdx].contextPath)
        ) {
          bestIdx = ci;
          bestCount = n;
        }
      });
      picked.push(bestIdx);
      for (const g of sets[bestIdx].covers) remaining.delete(g);
    }
    return picked;
  };

  let bestChosen = greedyPick();
  let bestPaths = bestChosen.map((ci) => sets[ci].contextPath).sort();
  const chosen = [];
  const memo = new Map(); // remaining 签名 -> 到达它时最少的已选数量（仅严格更劣才剪枝）

  const consider = () => {
    const paths = chosen.map((ci) => sets[ci].contextPath).sort();
    if (paths.length < bestPaths.length || (paths.length === bestPaths.length && lexLessPaths(paths, bestPaths))) {
      bestPaths = paths;
      bestChosen = chosen.slice();
    }
  };

  const dfs = (remaining) => {
    if (remaining.size === 0) {
      consider();
      return;
    }
    const key = [...remaining].sort().join('|');
    const prevDepth = memo.get(key);
    if (prevDepth !== undefined && prevDepth < chosen.length) return;
    memo.set(key, chosen.length);

    // 下界：剩余目标数 / 单集合最大新增覆盖数
    let maxCoverage = 0;
    for (const c of sets) {
      let n = 0;
      for (const g of c.covers) if (remaining.has(g)) n++;
      if (n > maxCoverage) maxCoverage = n;
    }
    if (chosen.length + Math.ceil(remaining.size / maxCoverage) > bestPaths.length) return;

    // MRV：选能覆盖它的候选数最少的未覆盖目标分支；候选保持路径字典序
    let branchSets = null;
    for (const goal of remaining) {
      const cs = [];
      sets.forEach((c, ci) => {
        if (c.covers.has(goal)) cs.push(ci);
      });
      if (!branchSets || cs.length < branchSets.length) {
        branchSets = cs;
        if (cs.length === 1) break;
      }
    }

    for (const ci of branchSets) {
      chosen.push(ci);
      const next = new Set(remaining);
      for (const g of sets[ci].covers) next.delete(g);
      dfs(next);
      chosen.pop();
    }
  };

  dfs(new Set(universe));
  return bestChosen.map((ci) => sets[ci]);
}

/**
 * 叶子分析：在全部叶子上下文上复用 computeEffective 的生效规则，
 * 汇总每条命令可触发的叶子、被覆盖的位置（shadower）与叶子可见冲突
 * （冲突以参与命令集合判定身份）。供回归套件与变更沙盒预演共用。
 */
function analyzeLeaves(state) {
  const index = buildIndex(state.contexts);
  const leaves = [...index.byId.values()]
    .filter((c) => c.children.length === 0)
    .map((c) => ({ id: c.id, path: contextPath(index, c.id) }))
    .sort((a, b) => (a.path === b.path ? (a.id < b.id ? -1 : 1) : a.path < b.path ? -1 : 1));

  // 每个叶子跑一次现有审校规则
  const reviews = leaves.map((leaf) => ({ leaf, eff: computeEffective(state, leaf.id) }));

  const triggerLeafIds = new Map(); // commandId -> 可触发它的叶子 id 列表
  const shadowerCounter = new Map(); // commandId -> Map(覆盖者 contextId -> 叶子数)
  const conflictGoals = new Map(); // goalId -> 冲突对象（代表）

  for (const { leaf, eff } of reviews) {
    for (const e of eff.entries) {
      if (e.state === 'shadowed') {
        if (e.shadowedBy) {
          if (!shadowerCounter.has(e.commandId)) shadowerCounter.set(e.commandId, new Map());
          const m = shadowerCounter.get(e.commandId);
          m.set(e.shadowedBy, (m.get(e.shadowedBy) || 0) + 1);
        }
      } else if (!triggerLeafIds.has(e.commandId)) {
        triggerLeafIds.set(e.commandId, [leaf.id]);
      } else {
        triggerLeafIds.get(e.commandId).push(leaf.id);
      }
    }
    for (const c of eff.conflicts) {
      const goalId = conflictGoalId(c);
      if (!conflictGoals.has(goalId)) conflictGoals.set(goalId, c);
    }
  }
  return { index, leaves, reviews, triggerLeafIds, shadowerCounter, conflictGoals };
}

/**
 * 不可触发命令：不在任何叶子生效的命令，单列原因与覆盖位置。
 * analysis 可选，传入 analyzeLeaves 的结果以避免重复计算。
 */
function listUnreachableCommands(state, analysis) {
  const { index, triggerLeafIds, shadowerCounter } = analysis || analyzeLeaves(state);
  const unreachableCommands = [];
  for (const cmd of state.commands) {
    if (triggerLeafIds.has(cmd.id)) continue;
    const leavesUnder = descendantLeaves(index, cmd.contextId);
    let reason;
    let shadowedBy = [];
    if (leavesUnder.length === 0) {
      reason = '所属上下文的子树中不存在叶子上下文，没有可执行该命令的测试位置';
    } else {
      const m = shadowerCounter.get(cmd.id);
      if (m && m.size > 0) {
        shadowedBy = [...m.keys()]
          .map((sid) => ({ contextId: sid, contextPath: contextPath(index, sid) }))
          .sort((a, b) => (a.contextPath < b.contextPath ? -1 : a.contextPath > b.contextPath ? 1 : 0));
        reason =
          `序列「${cmd.sequenceLabel}」在所属上下文（${contextPath(index, cmd.contextId)}）子树下的全部 ` +
          `${leavesUnder.length} 个叶子上下文中均被更近祖先的同序列绑定覆盖（shadowed，覆盖位置：` +
          `${shadowedBy.map((s) => s.contextPath).join('、')}），任何叶子都无法触发该命令`;
      } else {
        reason = '该命令未出现在任何叶子上下文的生效绑定中，无法从叶子上下文触发';
      }
    }
    unreachableCommands.push({
      commandId: cmd.id,
      name: cmd.name,
      description: cmd.description || '',
      contextId: cmd.contextId,
      contextPath: contextPath(index, cmd.contextId),
      sequenceTokens: cmd.sequenceTokens,
      sequenceLabel: cmd.sequenceLabel,
      reason,
      shadowedBy,
    });
  }
  unreachableCommands.sort((a, b) =>
    a.contextPath === b.contextPath
      ? a.sequenceLabel.localeCompare(b.sequenceLabel) || (a.commandId < b.commandId ? -1 : 1)
      : a.contextPath < b.contextPath
        ? -1
        : 1,
  );
  return unreachableCommands;
}

/**
 * 回归套件生成：
 * 1. 以全部叶子上下文为候选，复用 computeEffective 的生效规则；
 * 2. 测试目标 = 每条可在某个叶子触发的命令 + 每个可在某个叶子观察到的
 *    同层重复（duplicate）/ 前缀冲突（prefix），冲突以参与命令集合判定身份；
 * 3. 精确集合覆盖选出叶子数量最少的套件，同解按上下文路径字典序稳定选择；
 * 4. 任何叶子都无法触发的命令列入 unreachableCommands 并给出原因，不计入覆盖。
 */
function generateRegressionSuite(state) {
  const analysis = analyzeLeaves(state);
  const { leaves, reviews, triggerLeafIds, conflictGoals } = analysis;

  // 不可触发命令：不在任何叶子生效的命令，单列原因且不计入覆盖目标
  const unreachableCommands = listUnreachableCommands(state, analysis);

  // 覆盖目标全集：可触发命令 + 叶子可见冲突
  const universe = new Set();
  for (const id of triggerLeafIds.keys()) universe.add(`cmd:${id}`);
  for (const id of conflictGoals.keys()) universe.add(id);

  // 候选叶子及其覆盖的目标集合
  const candidates = reviews
    .map(({ leaf, eff }) => {
      const covers = new Set();
      for (const e of eff.entries) {
        if (e.state !== 'shadowed') covers.add(`cmd:${e.commandId}`);
      }
      for (const c of eff.conflicts) covers.add(conflictGoalId(c));
      return { contextId: leaf.id, contextPath: leaf.path, covers, eff };
    })
    .filter((c) => c.covers.size > 0);
  // leaves 已按路径排序，candidates 保持路径字典序，供集合覆盖平局判定使用

  const selected = minimumSetCover(candidates, universe);
  const selectedIds = new Set(selected.map((c) => c.contextId));

  const suite = selected.map((c) => {
    const eff = c.eff;
    const inputs = eff.effectiveGroups
      .slice()
      .sort((a, b) => a.label.localeCompare(b.label))
      .map((g) => ({
        sequenceLabel: g.label,
        sequenceTokens: g.tokens,
        duplicate: g.duplicate,
        expectedCommands: g.commands
          .map((rec) => ({
            commandId: rec.cmd.id,
            name: rec.cmd.name,
            contextPath: rec.contextPath,
          }))
          .sort((a, b) => a.name.localeCompare(b.name) || (a.commandId < b.commandId ? -1 : 1)),
      }));
    return {
      contextId: c.contextId,
      contextPath: c.contextPath,
      inputs,
      expectedConflicts: eff.conflicts,
      coveredGoals: [...c.covers].sort(),
    };
  });
  suite.sort((a, b) => (a.contextPath < b.contextPath ? -1 : a.contextPath > b.contextPath ? 1 : 0));

  let duplicateConflictCount = 0;
  let prefixConflictCount = 0;
  for (const c of conflictGoals.values()) {
    if (c.type === 'duplicate') duplicateConflictCount++;
    else prefixConflictCount++;
  }

  const coveredGoals = new Set();
  for (const c of selected) for (const g of c.covers) coveredGoals.add(g);
  const coveredCommandCount = [...coveredGoals].filter((g) => g.startsWith('cmd:')).length;

  return {
    generatedAt: new Date().toISOString(),
    stats: {
      leafCount: leaves.length,
      candidateCount: candidates.length,
      selectedContextCount: suite.length,
      commandCount: state.commands.length,
      triggerableCommandCount: triggerLeafIds.size,
      coveredCommandCount,
      unreachableCommandCount: unreachableCommands.length,
      conflictCount: conflictGoals.size,
      duplicateConflictCount,
      prefixConflictCount,
      inputSequenceCount: suite.reduce((n, tc) => n + tc.inputs.length, 0),
      coverableGoalCount: universe.size,
      coveredGoalCount: coveredGoals.size,
    },
    suite,
    candidates: candidates.map((c) => ({
      contextId: c.contextId,
      contextPath: c.contextPath,
      goalCount: c.covers.size,
      selected: selectedIds.has(c.contextId),
    })),
    unreachableCommands,
  };
}

function pressToPretty(token) {
  const MOD_PRETTY = { ctrl: 'Ctrl', alt: 'Alt', shift: 'Shift', meta: 'Meta' };
  return token
    .split('+')
    .map((p) => (MOD_PRETTY[p] ? MOD_PRETTY[p] : p.length === 1 ? p.toUpperCase() : p))
    .join('+');
}

/* ================= 变更沙盒预演 ================= */

/**
 * 把草案（新增 / 改序列 / 删除）应用到状态副本上，返回模拟状态。
 * 纯内存计算：不触碰持久化数据，也不修改传入的 baseState；
 * 所有校验失败均抛出 400，保证非法草案不会产生任何副作用。
 *
 * draft = {
 *   adds:    [{ draftId?, contextId, name, sequence, description? }]
 *   updates: [{ commandId, sequence }]      // 仅改序列
 *   deletes: [commandId, ...]               // 也接受 { commandId }
 * }
 */
function applyDraft(baseState, draft) {
  const d = draft || {};
  const adds = Array.isArray(d.adds) ? d.adds : [];
  const updates = Array.isArray(d.updates) ? d.updates : [];
  const deletes = Array.isArray(d.deletes) ? d.deletes : [];

  const bad = (message) => Object.assign(new Error(message), { status: 400 });

  const contexts = baseState.contexts.map((c) => ({ ...c }));
  const contextIds = new Set(contexts.map((c) => c.id));
  let commands = baseState.commands.map((c) => ({ ...c, sequenceTokens: [...c.sequenceTokens] }));

  const draftOps = new Map(); // commandId -> 'add' | 'update' | 'delete'

  // 1) 删除
  const deletedIds = new Set();
  for (const raw of deletes) {
    const id = typeof raw === 'string' ? raw : raw && raw.commandId;
    if (!id) throw bad('删除操作缺少命令 id');
    if (deletedIds.has(id)) throw bad(`草案中重复删除同一命令：${id}`);
    if (!commands.some((c) => c.id === id)) throw bad(`要删除的命令不存在：${id}`);
    deletedIds.add(id);
    draftOps.set(id, 'delete');
  }
  commands = commands.filter((c) => !deletedIds.has(c.id));

  // 2) 改序列
  const updatedIds = new Set();
  for (const u of updates) {
    if (!u || typeof u.commandId !== 'string' || !u.commandId) {
      throw bad('改序列操作缺少 commandId');
    }
    const id = u.commandId;
    if (deletedIds.has(id)) throw bad(`命令 ${id} 已在草案中删除，不能再修改序列`);
    if (updatedIds.has(id)) throw bad(`草案中重复修改同一命令的序列：${id}`);
    const cmd = commands.find((c) => c.id === id);
    if (!cmd) throw bad(`要修改序列的命令不存在：${id}`);
    const parsed = parseSequence(u.sequence);
    if (!parsed.ok) throw bad(`命令「${cmd.name}」的新序列无效：${parsed.error}`);
    cmd.sequenceRaw = String(u.sequence);
    cmd.sequenceTokens = parsed.tokens;
    cmd.sequenceLabel = parsed.label;
    updatedIds.add(id);
    draftOps.set(id, 'update');
  }

  // 3) 新增（draftId 由前端生成并在草案内保持稳定；缺省时按位置生成）
  const addedIds = new Set();
  adds.forEach((a, i) => {
    if (!a || typeof a !== 'object') throw bad('新增操作格式不正确');
    const draftId =
      typeof a.draftId === 'string' && a.draftId.trim() ? a.draftId.trim() : `draft-add-${i + 1}`;
    if (addedIds.has(draftId) || commands.some((c) => c.id === draftId)) {
      throw bad(`新增命令的 id 与现有命令或草案重复：${draftId}`);
    }
    if (!contextIds.has(a.contextId)) throw bad(`新增命令的上下文不存在：${a.contextId}`);
    if (!a.name || !String(a.name).trim()) throw bad('新增命令的名称不能为空');
    const parsed = parseSequence(a.sequence);
    if (!parsed.ok) {
      throw bad(`新增命令「${String(a.name).trim()}」的序列无效：${parsed.error}`);
    }
    addedIds.add(draftId);
    draftOps.set(draftId, 'add');
    commands.push({
      id: draftId,
      contextId: a.contextId,
      name: String(a.name).trim(),
      description: String(a.description || ''),
      sequenceRaw: String(a.sequence),
      sequenceTokens: parsed.tokens,
      sequenceLabel: parsed.label,
    });
  });

  return {
    state: { contexts, commands },
    draftOps,
    summary: {
      adds: addedIds.size,
      updates: updatedIds.size,
      deletes: deletedIds.size,
      addedCommandIds: [...addedIds].sort(),
      updatedCommandIds: [...updatedIds].sort(),
      deletedCommandIds: [...deletedIds].sort(),
    },
  };
}

/** 以稳定身份对两个列表做「新增 / 消失」配对（身份由 identityOf 给出） */
function diffByIdentity(baseItems, simItems, identityOf) {
  const baseKeys = new Set(baseItems.map(identityOf));
  const simKeys = new Set(simItems.map(identityOf));
  return {
    appeared: simItems.filter((item) => !baseKeys.has(identityOf(item))),
    disappeared: baseItems.filter((item) => !simKeys.has(identityOf(item))),
  };
}

/**
 * 变更沙盒预演：
 * 1. 在同一份草案上分别计算基线（当前状态）与模拟状态（应用草案后的内存副本）；
 * 2. 按上下文汇总生效绑定 / shadowed / duplicate / prefix 的新增与消失；
 *    不可触发命令为全局汇总（定义位置随条目给出）；
 * 3. 绑定以「命令 + 序列」配对，冲突以参与命令集合的稳定身份（conflictGoalId）配对；
 *    全部输出按稳定键排序，结果与数据顺序、草案操作顺序无关。
 */
function previewSandbox(baseState, draft) {
  const { state: simState, draftOps, summary } = applyDraft(baseState, draft);

  const simIndex = buildIndex(simState.contexts);
  const contextIds = [...simIndex.byId.keys()];

  // 绑定身份：同一命令绑定到同一序列视为同一绑定（改序列 => 旧绑定消失 + 新绑定出现）
  const bindingIdentity = (e) => `${e.commandId}\n${e.sequenceTokens.join('\n')}`;
  const byBinding = (a, b) =>
    a.sequenceLabel.localeCompare(b.sequenceLabel) ||
    (a.commandId < b.commandId ? -1 : a.commandId > b.commandId ? 1 : 0);
  const byGoalId = (a, b) => (a.goalId < b.goalId ? -1 : a.goalId > b.goalId ? 1 : 0);

  const toBindingItem = (e) => ({
    commandId: e.commandId,
    name: e.name,
    description: e.description || '',
    contextId: e.contextId,
    contextPath: e.contextPath,
    sequenceTokens: e.sequenceTokens,
    sequenceLabel: e.sequenceLabel,
    shortestLabel: e.sequenceLabel, // 绑定条目的最短触发输入即其序列本身
    state: e.state,
    shadowedBy: e.shadowedBy || null,
    draftOp: draftOps.get(e.commandId) || null,
  });

  const toConflictItem = (c) => ({
    ...c,
    goalId: conflictGoalId(c),
    parties: c.parties
      .map((p) => ({ ...p, draftOp: draftOps.get(p.commandId) || null }))
      .sort((a, b) => (a.commandId < b.commandId ? -1 : a.commandId > b.commandId ? 1 : 0)),
  });

  const contextDiffs = [];
  for (const contextId of contextIds) {
    const baseEff = computeEffective(baseState, contextId);
    const simEff = computeEffective(simState, contextId);

    const effective = diffByIdentity(
      baseEff.entries.filter((e) => e.state !== 'shadowed').map(toBindingItem),
      simEff.entries.filter((e) => e.state !== 'shadowed').map(toBindingItem),
      bindingIdentity,
    );
    const shadowed = diffByIdentity(
      baseEff.entries.filter((e) => e.state === 'shadowed').map(toBindingItem),
      simEff.entries.filter((e) => e.state === 'shadowed').map(toBindingItem),
      bindingIdentity,
    );
    const conflicts = diffByIdentity(
      baseEff.conflicts.map(toConflictItem),
      simEff.conflicts.map(toConflictItem),
      (c) => c.goalId,
    );

    const duplicate = {
      appeared: conflicts.appeared.filter((c) => c.type === 'duplicate').sort(byGoalId),
      disappeared: conflicts.disappeared.filter((c) => c.type === 'duplicate').sort(byGoalId),
    };
    const prefix = {
      appeared: conflicts.appeared.filter((c) => c.type === 'prefix').sort(byGoalId),
      disappeared: conflicts.disappeared.filter((c) => c.type === 'prefix').sort(byGoalId),
    };
    effective.appeared.sort(byBinding);
    effective.disappeared.sort(byBinding);
    shadowed.appeared.sort(byBinding);
    shadowed.disappeared.sort(byBinding);

    const changeCount =
      effective.appeared.length +
      effective.disappeared.length +
      shadowed.appeared.length +
      shadowed.disappeared.length +
      duplicate.appeared.length +
      duplicate.disappeared.length +
      prefix.appeared.length +
      prefix.disappeared.length;

    if (changeCount > 0) {
      contextDiffs.push({
        contextId,
        contextPath: simEff.contextPath,
        changeCount,
        effective,
        shadowed,
        duplicate,
        prefix,
      });
    }
  }
  contextDiffs.sort((a, b) =>
    a.contextPath === b.contextPath
      ? a.contextId < b.contextId
        ? -1
        : 1
      : a.contextPath < b.contextPath
        ? -1
        : 1,
  );

  // 不可触发命令：全局（任何叶子都无法触发），按 commandId 配对
  const withDraftOp = (u) => ({ ...u, draftOp: draftOps.get(u.commandId) || null });
  const unreachableRaw = diffByIdentity(
    listUnreachableCommands(baseState),
    listUnreachableCommands(simState),
    (u) => u.commandId,
  );
  const unreachable = {
    appeared: unreachableRaw.appeared.map(withDraftOp),
    disappeared: unreachableRaw.disappeared.map(withDraftOp),
  };

  const sum = (sel) => contextDiffs.reduce((n, c) => n + sel(c).length, 0);
  const stats = {
    contextCount: contextIds.length,
    changedContextCount: contextDiffs.length,
    effectiveAppeared: sum((c) => c.effective.appeared),
    effectiveDisappeared: sum((c) => c.effective.disappeared),
    shadowedAppeared: sum((c) => c.shadowed.appeared),
    shadowedDisappeared: sum((c) => c.shadowed.disappeared),
    duplicateAppeared: sum((c) => c.duplicate.appeared),
    duplicateDisappeared: sum((c) => c.duplicate.disappeared),
    prefixAppeared: sum((c) => c.prefix.appeared),
    prefixDisappeared: sum((c) => c.prefix.disappeared),
    unreachableAppeared: unreachable.appeared.length,
    unreachableDisappeared: unreachable.disappeared.length,
  };
  stats.totalChanges =
    stats.effectiveAppeared +
    stats.effectiveDisappeared +
    stats.shadowedAppeared +
    stats.shadowedDisappeared +
    stats.duplicateAppeared +
    stats.duplicateDisappeared +
    stats.prefixAppeared +
    stats.prefixDisappeared +
    stats.unreachableAppeared +
    stats.unreachableDisappeared;

  return {
    generatedAt: new Date().toISOString(),
    draft: summary,
    stats,
    contexts: contextDiffs,
    unreachable,
  };
}

/* ================= 冲突消解（改键方案搜索） ================= */

// 方案内部使用的序列/字段分隔符（不会出现在规范 token 中）
const PLAN_SEP = '';
const PLAN_FIELD_SEP = '';

function planSeqKey(tokens) {
  return tokens.join(PLAN_SEP);
}

/** 冲突的序列签名（只依赖序列，不依赖参与命令）：判定某冲突在改键后是否仍存在 */
function conflictSignature(conflict) {
  if (conflict.type === 'duplicate') return `dup:${planSeqKey(conflict.sequenceTokens)}`;
  return `pre:${planSeqKey(conflict.prefixTokens)}::${planSeqKey(conflict.extensionTokens)}`;
}

/** 字符串数组字典序（短前缀更小），用于方案之间的第三级比较 */
function lexLessStringArray(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] < b[i]) return true;
    if (a[i] > b[i]) return false;
  }
  return a.length < b.length;
}

/**
 * 冲突消解：针对某上下文当前**生效**的 duplicate / prefix 冲突，搜索改键方案。
 *
 * 约束：
 * - 只允许修改**定义在当前上下文**的命令；祖先上下文的命令本就不可修改；
 * - lockedCommandIds 中的当前上下文命令保持原序列；
 * - 每条可改命令的新序列只能取自候选池（保持原序列不算改动）；
 * - maxChanges 限制改动命令条数（null/缺省 = 不限）。
 *
 * 搜索复用 computeEffective 的生效规则：每个完整指派在内存副本上重新计算
 * 生效绑定，要求冲突数为 0（且不引入任何新冲突）。
 * 优化目标依次为：①改动命令数最少；②改动后新序列总按键数最少；
 * ③方案字典序最小（改动按 commandId 排序后逐条比较新序列）。
 *
 * 返回 { solvable, changes, unresolved, ... }；无解时 unresolved 逐个列出
 * 无法消除的冲突与原因（immutable / budget / pool / entailed / combined）。
 */
function resolveConflicts(state, contextId, options = {}) {
  const bad = (message) => Object.assign(new Error(message), { status: 400 });

  // 上下文不存在时与 computeEffective 一样抛出 404
  const baseEff = computeEffective(state, contextId);

  // ---- 解析与校验入参 ----
  const lockedInput = options.lockedCommandIds;
  if (lockedInput !== undefined && lockedInput !== null && !Array.isArray(lockedInput)) {
    throw bad('lockedCommandIds 必须是命令 id 数组');
  }
  const allCmdIds = new Set(state.commands.map((c) => c.id));
  const lockedSet = new Set();
  for (const raw of lockedInput || []) {
    if (typeof raw !== 'string' || !raw) throw bad('锁定命令 id 必须是非空字符串');
    if (!allCmdIds.has(raw)) throw bad(`锁定的命令不存在：${raw}`);
    lockedSet.add(raw);
  }

  const candidateInput = options.candidates;
  if (candidateInput !== undefined && candidateInput !== null && !Array.isArray(candidateInput)) {
    throw bad('candidates 必须是候选序列数组');
  }
  const poolMap = new Map(); // seqKey -> { tokens, label, key }
  for (const raw of candidateInput || []) {
    const parsed = parseSequence(raw);
    if (!parsed.ok) throw bad(`候选序列「${raw}」无效：${parsed.error}`);
    const key = planSeqKey(parsed.tokens);
    if (!poolMap.has(key)) poolMap.set(key, { tokens: parsed.tokens, label: parsed.label, key });
  }

  let maxChanges = Infinity;
  if (options.maxChanges !== undefined && options.maxChanges !== null) {
    const n = Number(options.maxChanges);
    if (!Number.isInteger(n) || n < 0) throw bad('最多改动数必须是非负整数');
    maxChanges = n;
  }

  const index = buildIndex(state.contexts);
  const hereCommands = state.commands
    .filter((c) => c.contextId === contextId)
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  // ---- 变量：仅当前上下文定义的命令 ----
  const variables = hereCommands.map((cmd) => {
    const own = {
      tokens: [...cmd.sequenceTokens],
      label: cmd.sequenceLabel,
      key: planSeqKey(cmd.sequenceTokens),
      isOwn: true,
    };
    let values = [own];
    if (!lockedSet.has(cmd.id)) {
      const extras = [...poolMap.values()]
        .filter((v) => v.key !== own.key)
        .sort(
          (a, b) =>
            a.tokens.length - b.tokens.length ||
            (a.label < b.label ? -1 : a.label > b.label ? 1 : 0) ||
            (a.key < b.key ? -1 : 1),
        );
      values = [own, ...extras];
    }
    return { id: cmd.id, cmd, own, values, locked: lockedSet.has(cmd.id) };
  });
  const varById = new Map(variables.map((v) => [v.id, v]));

  // ---- 基线冲突（带稳定身份与序列签名）----
  const baseConflicts = baseEff.conflicts.map((c) => ({
    ...c,
    goalId: conflictGoalId(c),
    sig: conflictSignature(c),
  }));

  // 每个当前上下文命令参与的基线冲突（供结果标注“消除目标”）
  const participantGoals = new Map();
  for (const c of baseConflicts) {
    for (const p of c.parties) {
      if (!participantGoals.has(p.commandId)) participantGoals.set(p.commandId, []);
      participantGoals.get(p.commandId).push(c.goalId);
    }
  }

  // 基线中可见、且归属祖先层的生效序列（前缀判定的固定障碍；被当前命令
  // 精确同序列覆盖时整组 shadow，不算冲突）
  const ancestorVisibleGroups = [];
  for (const g of baseEff.effectiveGroups) {
    if (g.commands[0].ownerDepth > 0) {
      ancestorVisibleGroups.push({ key: planSeqKey(g.tokens), tokens: g.tokens });
    }
  }

  const byPoolValue = (a, b) =>
    a.tokens.length - b.tokens.length ||
    (a.label < b.label ? -1 : a.label > b.label ? 1 : 0) ||
    (planSeqKey(a.tokens) < planSeqKey(b.tokens) ? -1 : 1);

  const candidatesEcho = [...poolMap.values()]
    .map((v) => ({ tokens: v.tokens, label: v.label }))
    .sort(byPoolValue);

  const baseResult = {
    format: 'shortcut-conflict-resolution-v1',
    generatedAt: new Date().toISOString(),
    contextId,
    contextPath: baseEff.contextPath,
    constraints: {
      maxChanges: maxChanges === Infinity ? null : maxChanges,
      candidates: candidatesEcho,
      lockedCommandIds: [...lockedSet].sort(),
      movableCommandIds: variables.filter((v) => !v.locked).map((v) => v.id).sort(),
    },
    stats: {
      conflictCount: baseConflicts.length,
      duplicateCount: baseConflicts.filter((c) => c.type === 'duplicate').length,
      prefixCount: baseConflicts.filter((c) => c.type === 'prefix').length,
      definedHereCommandCount: variables.length,
      lockedHereCommandCount: variables.filter((v) => v.locked).length,
      candidateCount: poolMap.size,
      maxChanges: maxChanges === Infinity ? null : maxChanges,
      searchedNodes: 0,
    },
    conflicts: baseConflicts.map(({ sig, ...rest }) => rest),
  };

  // 无冲突即零改动方案
  if (baseConflicts.length === 0) {
    return {
      ...baseResult,
      solvable: true,
      stats: { ...baseResult.stats, changedCommandCount: 0, totalPresses: 0 },
      changes: [],
      unresolved: [],
      draft: { adds: [], updates: [], deletes: [] },
    };
  }

  const movableParticipants = (c) =>
    c.parties.filter((p) => varById.has(p.commandId) && !lockedSet.has(p.commandId));

  // ---- 分支限界搜索 ----
  // targetSigs 为 null：要求最终冲突数为 0；否则只要求目标签名全部消失（诊断用）。
  // poolOverride 非空时用该候选池替换用户池（仅用于无解诊断，保证有安全空位）。
  // forcedOwn 中的变量固定保持原序列（诊断单冲突时，非目标冲突参与方无法帮助
  // 目标签名消失，固定它们不损失该冲突的可解性）。
  const runSearch = ({ budget, targetSigs, poolOverride = null, forcedOwn = null, nodeLimit = 1_000_000 }) => {
    const effectivePool = poolOverride || poolMap;
    const assigned = new Map(); // commandId -> value
    for (const v of variables) {
      if (v.locked || (forcedOwn && forcedOwn.has(v.id))) assigned.set(v.id, v.own);
    }
    let best = null;
    let nodes = 0;
    let truncated = false;

    const branchingVars = variables.filter((v) => !assigned.has(v.id));

    // 每个变量在本次搜索中的取值（自身原序列优先；锁定变量只能保持原序列）
    const valuesOf = (v) => {
      if (v.locked) return [v.own];
      const extras = [...effectivePool.values()]
        .filter((x) => x.key !== v.own.key)
        .sort(
          (a, b) =>
            a.tokens.length - b.tokens.length ||
            (a.label < b.label ? -1 : a.label > b.label ? 1 : 0) ||
            (a.key < b.key ? -1 : 1),
        );
      return [v.own, ...extras];
    };

    const metrics = () => {
      let changes = 0;
      let presses = 0;
      const plan = [];
      for (const v of variables) {
        const val = assigned.get(v.id) || v.own;
        if (!val.isOwn) {
          changes++;
          presses += val.tokens.length;
          plan.push(`${v.id}${PLAN_FIELD_SEP}${val.key}`);
        }
      }
      plan.sort();
      return { changes, presses, plan };
    };

    /** 部分指派下某变量仍可选的值（增量剪枝；最终以 computeEffective 为准） */
    const legalValues = (v) => {
      const occupiedKeys = new Set();
      for (const [id, val] of assigned) {
        if (id !== v.id) occupiedKeys.add(val.key);
      }
      const shadowedAncestorKeys = new Set();
      for (const ag of ancestorVisibleGroups) if (occupiedKeys.has(ag.key)) shadowedAncestorKeys.add(ag.key);
      const out = [];
      outer: for (const val of valuesOf(v)) {
        for (const [id, other] of assigned) {
          if (id === v.id) continue;
          if (other.key === val.key) continue outer; // 同层重复
          if (isPrefix(val.tokens, other.tokens) || isPrefix(other.tokens, val.tokens)) continue outer;
        }
        for (const ag of ancestorVisibleGroups) {
          if (shadowedAncestorKeys.has(ag.key)) continue; // 祖先组已被当前命令覆盖
          if (ag.key === val.key) continue; // 本值精确覆盖祖先组（shadow，允许）
          if (isPrefix(val.tokens, ag.tokens) || isPrefix(ag.tokens, val.tokens)) continue outer;
        }
        out.push(val);
      }
      return out;
    };

    const applyAndReview = () => {
      const simCommands = state.commands.map((c) => {
        const v = varById.get(c.id);
        if (!v) return c;
        const val = assigned.get(c.id);
        if (!val || val.isOwn) return c;
        return {
          ...c,
          sequenceRaw: val.label,
          sequenceTokens: [...val.tokens],
          sequenceLabel: val.label,
        };
      });
      return computeEffective({ contexts: state.contexts, commands: simCommands }, contextId);
    };

    const consider = (m) => {
      if (
        !best ||
        m.changes < best.changes ||
        (m.changes === best.changes && m.presses < best.presses) ||
        (m.changes === best.changes && m.presses === best.presses && lexLessStringArray(m.plan, best.plan))
      ) {
        best = { ...m, assignment: new Map(assigned) };
      }
    };

    const dfs = () => {
      if (++nodes > nodeLimit) {
        truncated = true;
        return;
      }
      const m = metrics(); // 未指派变量按“保持原序列”计，改动数/按键数只可能增长
      if (m.changes > budget) return;
      if (best) {
        if (m.changes > best.changes) return;
        if (m.changes === best.changes && m.presses > best.presses) return;
      }

      const unassigned = branchingVars.filter((v) => !assigned.has(v.id));
      if (unassigned.length === 0) {
        const eff = applyAndReview();
        const ok = targetSigs
          ? !eff.conflicts.some((c) => targetSigs.has(conflictSignature(c)))
          : eff.conflicts.length === 0;
        if (ok) consider(m);
        return;
      }

      // MRV：可选值最少的未指派变量先分支（平局按 commandId，保证稳定）
      let picked = null;
      let pickedValues = null;
      for (const v of unassigned) {
        const vals = legalValues(v);
        if (vals.length === 0) return;
        if (
          !picked ||
          vals.length < pickedValues.length ||
          (vals.length === pickedValues.length && v.id < picked.id)
        ) {
          picked = v;
          pickedValues = vals;
        }
      }
      for (const val of pickedValues) {
        assigned.set(picked.id, val);
        dfs();
        assigned.delete(picked.id);
      }
    };

    dfs();
    return { best, nodes, truncated };
  };

  const mainSearch = runSearch({ budget: maxChanges, targetSigs: null });
  if (mainSearch.truncated && !mainSearch.best) {
    throw Object.assign(new Error('冲突消解搜索空间过大，请收窄候选池或减少参与命令后重试'), {
      status: 500,
    });
  }
  const best = mainSearch.best;
  const nodes = mainSearch.nodes;
  baseResult.stats.searchedNodes = nodes;

  const partyView = (p) => ({
    commandId: p.commandId,
    name: p.name,
    contextPath: p.contextPath,
    sequenceLabel: p.sequenceLabel,
    role: p.role || null,
    definedHere: varById.has(p.commandId),
    locked: lockedSet.has(p.commandId),
  });

  if (best) {
    const changes = variables
      .filter((v) => {
        const val = best.assignment.get(v.id);
        return val && !val.isOwn;
      })
      .map((v) => {
        const val = best.assignment.get(v.id);
        return {
          commandId: v.id,
          name: v.cmd.name,
          description: v.cmd.description || '',
          contextId: v.cmd.contextId,
          contextPath: contextPath(index, contextId),
          fromTokens: v.own.tokens,
          fromLabel: v.own.label,
          toTokens: val.tokens,
          toLabel: val.label,
          resolvesGoalIds: [...new Set(participantGoals.get(v.id) || [])].sort(),
        };
      });
    return {
      ...baseResult,
      solvable: true,
      stats: {
        ...baseResult.stats,
        changedCommandCount: best.changes,
        totalPresses: best.presses,
      },
      changes,
      unresolved: [],
      draft: {
        adds: [],
        updates: changes.map((c) => ({ commandId: c.commandId, sequence: c.toLabel })),
        deletes: [],
      },
    };
  }

  // ---- 无解：逐冲突诊断无法消除的原因 ----

  // 保证安全的扩展池：使用当前生效序列未占用的修饰键主键（单键），
  // 其首键与任何生效序列首键都不同，故既不会与生效序列重复也不可能互为前缀；
  // 仅用于无解诊断，区分“候选池不足”与“锁定/结构上不可消除”。
  const safePool = new Map();
  {
    const usedFirst = new Set();
    for (const g of baseEff.effectiveGroups) usedFirst.add(g.tokens[0]);
    const safeMods = ['meta', 'alt', 'ctrl', 'shift'];
    const letters = 'abcdefghijklmnopqrstuvwxyz'.split('');
    outerSafe: for (const mod of safeMods) {
      for (const letter of letters) {
        const token = `${mod}+${letter}`;
        if (usedFirst.has(token)) continue;
        const pretty = `${mod[0].toUpperCase() + mod.slice(1)}+${letter.toUpperCase()}`;
        const key = planSeqKey([token]);
        if (!safePool.has(key)) safePool.set(key, { tokens: [token], label: pretty, key });
        if (safePool.size >= 24) break outerSafe;
      }
    }
  }

  const unresolved = baseConflicts.map((c) => {
    const movable = movableParticipants(c);
    let kind;
    let reason;
    let minChanges = null;

    if (movable.length === 0) {
      kind = 'immutable';
      const ancestorParties = c.parties.filter((p) => !varById.has(p.commandId));
      if (c.type === 'prefix' && ancestorParties.length === c.parties.length) {
        const shortP = c.parties.find((p) => p.role === 'prefix');
        const longP = c.parties.find((p) => p.role === 'extension');
        reason =
          `前缀冲突的双方序列「${shortP.sequenceLabel}」与「${longP.sequenceLabel}」均由祖先上下文命令持有，` +
          `改键仅作用于当前上下文「${baseEff.contextPath}」：在当前上下文新增同序列绑定只会形成新的前缀对，无法消解该冲突。` +
          `请前往各命令的定义上下文调整，或解除相关命令的锁定。`;
      } else {
        const lockedNames = c.parties
          .filter((p) => varById.has(p.commandId) && lockedSet.has(p.commandId))
          .map((p) => `「${p.name}」`);
        const ancestorNames = c.parties
          .filter((p) => !varById.has(p.commandId))
          .map((p) => `「${p.name}」（${p.contextPath}）`);
        const bits = [];
        if (lockedNames.length) bits.push(`已锁定：${lockedNames.join('、')}`);
        if (ancestorNames.length) bits.push(`定义在祖先上下文、本就不可修改：${ancestorNames.join('、')}`);
        reason = `参与该冲突的命令均不可修改（${bits.join('；')}），当前上下文内没有可改键的冲突方。`;
      }
    } else {
      // 在“不限改动数”的条件下单独消解该冲突，先按用户候选池，再用保证安全的扩展池：
      // 据此区分是改动预算不足、用户候选池不足，还是锁定/前缀结构上的不可消除。
      // 非该冲突参与方的变量固定原序列：它们的改动不能让该冲突签名消失，
      // 固定后不改变“该冲突是否可单独消解”的结论，却把诊断搜索规模压到极小。
      const forced = new Set(
        variables
          .filter((v) => !c.parties.some((p) => p.commandId === v.id))
          .map((v) => v.id),
      );
      const diagOpts = { budget: Infinity, targetSigs: new Set([c.sig]), forcedOwn: forced, nodeLimit: 60_000 };
      const relaxed = runSearch(diagOpts);
      // 用户池即找到解（未截断）：候选池不是瓶颈
      if (relaxed.best && !relaxed.truncated) {
        minChanges = relaxed.best.changes;
        if (relaxed.best.changes > maxChanges) {
          kind = 'budget';
          reason =
            `在当前候选池与锁定条件下，仅消解该冲突就至少需要改动 ${relaxed.best.changes} 条命令，` +
            `超过“最多改动数”${maxChanges}。请放宽改动上限后重试。`;
        } else {
          // 单独可解（且预算足够），卡点在冲突之间的联合约束
          kind = 'entailed';
          reason =
            '该冲突单独可以消解，但与其他冲突在同一候选池/锁定条件下竞争无冲突空位，' +
            '不存在同时消解全部冲突的联合方案。请扩充候选池、解除部分锁定或放宽改动上限后重试。';
        }
      } else {
        // 用户池无解（或搜索被截断）：再用保证安全的扩展池判断是否结构性不可消除
        const relaxedSafe = runSearch({ ...diagOpts, poolOverride: safePool });
        if (!relaxedSafe.best || relaxedSafe.truncated) {
          kind = 'immutable';
          const lockedPartyNames = c.parties
            .filter((p) => varById.has(p.commandId) && lockedSet.has(p.commandId))
            .map((p) => `「${p.name}」`);
          if (c.type === 'prefix') {
            reason =
              `即使为可改命令提供充足的安全候选序列，该前缀冲突仍无法消解：未锁定冲突方一旦离开当前序列，` +
              `双方的前缀关系会暴露为祖先上下文之间（或与被锁定命令之间）无法修改的冲突` +
              (lockedPartyNames.length ? `，且被锁定的冲突方 ${lockedPartyNames.join('、')} 必须保留原序列` : '') +
              '。请解除相关锁定，或前往祖先上下文调整命令。';
          } else {
            reason =
              `即使提供充足候选序列仍无法消解该同层重复：冲突方均被锁定或位于祖先上下文` +
              (lockedPartyNames.length ? `（锁定：${lockedPartyNames.join('、')}）` : '') + '。';
          }
        } else {
          kind = 'pool';
          minChanges = relaxedSafe.best.changes;
          const lockedPartyNames = c.parties
            .filter((p) => varById.has(p.commandId) && lockedSet.has(p.commandId))
            .map((p) => `「${p.name}」`);
          reason =
            `候选序列池中不存在能避开当前全部生效序列（含严格前缀关系）的空位：` +
            `未锁定的冲突方${movable.map((p) => `「${p.name}」`).join('、')}无论改到哪个候选序列，都会与生效序列重复或互为前缀` +
            (lockedPartyNames.length ? `（被锁定的冲突方 ${lockedPartyNames.join('、')} 必须保留原序列）` : '') +
            '。请扩充候选池（例如加入带修饰键或更长的序列）后重试。';
        }
      }
    }

    return {
      goalId: c.goalId,
      type: c.type,
      kind,
      reason,
      minChanges,
      conflict: (() => {
        const { sig, ...rest } = c;
        return rest;
      })(),
      blockedCommands: c.parties.map(partyView),
    };
  });

  // 若所有冲突单独都可消解（没有 immutable/budget/pool 的硬阻塞），
  // 则统一标注为联合约束下的候选空位竞争，原因表述与 entailed 略有区别。
  const hardBlockedKinds = new Set(['immutable', 'budget', 'pool']);
  const hasHardBlock = unresolved.some((u) => hardBlockedKinds.has(u.kind));
  if (!hasHardBlock) {
    for (const u of unresolved) {
      u.kind = 'combined';
      u.reason =
        '每个冲突单独都能消解，但在当前锁定、候选池与改动上限的联合约束下，' +
        '不存在同时消解全部冲突的方案（无冲突空位相互竞争）。请扩充候选池、解除部分锁定或放宽改动上限后重试。';
    }
  }

  return {
    ...baseResult,
    solvable: false,
    stats: { ...baseResult.stats, changedCommandCount: 0, totalPresses: 0 },
    changes: [],
    unresolved,
    draft: { adds: [], updates: [], deletes: [] },
  };
}

module.exports = {
  MAX_PRESSES,
  canonicalPress,
  parseSequence,
  seqKey,
  isPrefix,
  buildIndex,
  ancestorChain,
  contextPath,
  computeEffective,
  evaluateKey,
  replayTimeline,
  DEFAULT_REPLAY_TIMEOUT_MS,
  descendantLeaves,
  conflictGoalId,
  minimumSetCover,
  analyzeLeaves,
  listUnreachableCommands,
  generateRegressionSuite,
  applyDraft,
  previewSandbox,
  resolveConflicts,
};
