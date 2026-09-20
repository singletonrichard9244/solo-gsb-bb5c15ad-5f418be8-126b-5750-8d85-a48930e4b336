import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import { DRAFT_KEY } from './Sandbox';

/**
 * 冲突消解面板（审校页右栏）：
 * - 针对当前上下文的生效 duplicate / prefix 冲突，由后端搜索仅改动
 *   “定义在当前上下文”命令的无冲突改键方案；
 * - 用户可锁定不得修改的命令、输入候选序列池、设置最多改动命令数；
 * - 优化目标依次为：改动命令数最少 → 新序列总按键数最少 → 方案字典序最小；
 * - 有解时展示改前/改后序列与该改动消除的冲突目标，可将全部修改写入
 *   现有变更沙盒草案（localStorage）并跳转继续预演；
 * - 无解时逐个列出无法消除的冲突与原因（不可修改 / 候选池 / 改动预算 / 联合竞争）。
 */

const LETTERS = 'abcdefghijklmnopqrstuvwxyz'.split('');

/** 候选池默认值：当前生效序列未占用的首字母（天然不会与任何生效序列构成前缀） */
function buildDefaultCandidates(review) {
  const usedFirst = new Set();
  for (const g of review.effectiveGroups || []) {
    const t = g.tokens[0];
    if (t && !t.includes('+') && t.length === 1) usedFirst.add(t);
  }
  return LETTERS.filter((l) => !usedFirst.has(l)).join('\n');
}

function parsePool(text) {
  return text
    .split(/[\n,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function loadDraft() {
  try {
    const raw = window.localStorage.getItem(DRAFT_KEY);
    if (!raw) return { adds: [], updates: [], deletes: [] };
    const d = JSON.parse(raw);
    return {
      adds: Array.isArray(d.adds) ? d.adds : [],
      updates: Array.isArray(d.updates) ? d.updates : [],
      deletes: Array.isArray(d.deletes) ? d.deletes : [],
    };
  } catch {
    return { adds: [], updates: [], deletes: [] };
  }
}

const KIND_LABEL = {
  immutable: { label: '参与命令不可修改', tone: 'danger' },
  pool: { label: '候选池无空位', tone: 'warn' },
  budget: { label: '超出改动上限', tone: 'warn' },
  entailed: { label: '冲突间联合竞争', tone: 'warn' },
  combined: { label: '无联合可行方案', tone: 'warn' },
};

function ConflictChip({ conflict }) {
  return (
    <span className={`conflict-chip ${conflict.type === 'duplicate' ? 'dup' : 'pre'}`}>
      {conflict.type === 'duplicate' ? (
        <>⛔ 同层重复 {conflict.sequenceLabel}</>
      ) : (
        <>
          🔀 前缀 {conflict.prefixSequenceLabel} ⊂ {conflict.extensionSequenceLabel}
        </>
      )}
    </span>
  );
}

export default function ConflictResolver({ selectedContext, review, state, onOpenSandbox }) {
  const [candidateText, setCandidateText] = useState('');
  const [maxText, setMaxText] = useState('');
  const [locked, setLocked] = useState(() => new Set());
  const [result, setResult] = useState(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState('');
  const [wroteNotice, setWroteNotice] = useState('');
  const initRef = useRef(null);

  const ctxId = selectedContext?.id || null;

  const hereCommands = useMemo(() => {
    if (!ctxId) return [];
    return state.commands
      .filter((c) => c.contextId === ctxId)
      .sort((a, b) => a.sequenceLabel.localeCompare(b.sequenceLabel) || (a.id < b.id ? -1 : 1));
  }, [state, ctxId]);

  // 切换上下文：重置锁定与候选池默认值（祖先命令不出现在锁定列表——它们本就不可修改）。
  // review 可能晚于面板首次渲染到达，因此默认候选池在 review 首次就绪时补一次。
  useEffect(() => {
    initRef.current = null;
    setResult(null);
    setError('');
    setWroteNotice('');
    if (!ctxId) return;
    setLocked(new Set());
    setMaxText('');
    setCandidateText('');
  }, [ctxId]);

  useEffect(() => {
    if (ctxId && review && initRef.current !== ctxId) {
      initRef.current = ctxId;
      setCandidateText(buildDefaultCandidates(review));
    }
  }, [ctxId, review]);

  const runResolve = useCallback(async () => {
    if (!ctxId || initRef.current !== ctxId) return;
    const body = {
      candidates: parsePool(candidateText),
      lockedCommandIds: [...locked].sort(),
    };
    if (maxText.trim() !== '') body.maxChanges = Number(maxText);
    setRunning(true);
    setError('');
    setWroteNotice('');
    try {
      setResult(await api.resolveConflicts(ctxId, body));
    } catch (err) {
      setResult(null);
      setError(err.message);
    } finally {
      setRunning(false);
    }
  }, [ctxId, candidateText, locked, maxText]);

  // 参数变化后防抖自动求解
  useEffect(() => {
    if (!ctxId || initRef.current !== ctxId) return undefined;
    const timer = setTimeout(runResolve, 300);
    return () => clearTimeout(timer);
  }, [ctxId, runResolve]);

  const toggleLock = (id) => {
    setLocked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const downloadJson = () => {
    if (!result) return;
    const blob = new Blob([JSON.stringify(result, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `conflict-resolution-${result.contextId}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  /** 把方案的全部改序列操作合并进现有沙盒草案（同命令覆盖旧的改序列、移除删除） */
  const writeToSandbox = () => {
    if (!result?.solvable) return;
    const draft = loadDraft();
    const updateMap = new Map(draft.updates.map((u) => [u.commandId, u]));
    for (const u of result.draft.updates) updateMap.set(u.commandId, u);
    const next = {
      adds: draft.adds,
      updates: [...updateMap.values()],
      deletes: draft.deletes.filter((id) => !updateMap.has(id)),
    };
    try {
      window.localStorage.setItem(DRAFT_KEY, JSON.stringify(next));
    } catch {
      /* 写入失败时提示 */
    }
    onOpenSandbox?.();
  };

  if (!selectedContext || !review) {
    return (
      <div className="panel resolver-panel">
        <div className="panel-header">
          <h2>🔀 冲突消解</h2>
        </div>
        <p className="hint">选择左侧上下文后在此生成改键方案。</p>
      </div>
    );
  }

  const conflictCount = review.conflicts.length;
  const goalLabels = new Map(
    (result?.conflicts || []).map((c) => [
      c.goalId,
      c.type === 'duplicate'
        ? `同层重复 ${c.sequenceLabel}`
        : `前缀 ${c.prefixSequenceLabel} ⊂ ${c.extensionSequenceLabel}`,
    ]),
  );

  return (
    <div className="panel resolver-panel">
      <div className="panel-header">
        <h2>
          🔀 冲突消解 <span className="sub">仅改动当前上下文「{selectedContext.name}」定义的命令</span>
        </h2>
      </div>

      <div className="resolver-summary">
        {conflictCount === 0 ? (
          <span className="resolver-clean">✅ 当前生效绑定中没有 duplicate / prefix 冲突，无需消解。</span>
        ) : (
          review.conflicts.map((c, i) => <ConflictChip key={c.type + i} conflict={c} />)
        )}
      </div>

      {conflictCount > 0 && (
        <>
          <div className="resolver-controls">
            <label className="resolver-field">
              <span className="dim small">
                候选序列池（每行或逗号分隔一个序列，1~3 键，如 <kbd>w</kbd> 或 <kbd>ctrl+alt+l</kbd>）
              </span>
              <textarea
                className="seq-input resolver-pool"
                rows={4}
                value={candidateText}
                onChange={(e) => setCandidateText(e.target.value)}
                placeholder={'w\nq\nctrl+alt+l'}
                spellCheck={false}
              />
            </label>

            <label className="resolver-field resolver-max">
              <span className="dim small">最多改动命令数（留空 = 不限）</span>
              <input
                type="number"
                min="0"
                value={maxText}
                onChange={(e) => setMaxText(e.target.value)}
                placeholder="不限"
              />
            </label>

            <div className="resolver-field">
              <span className="dim small">锁定不得修改的命令（祖先上下文命令本就不可改，不在此列）</span>
              <ul className="lock-list">
                {hereCommands.length === 0 && <li className="dim small">当前上下文未定义命令，无法通过改键消解。</li>}
                {hereCommands.map((cmd) => {
                  const inConflict = (review.entries || []).some(
                    (e) => e.commandId === cmd.id && (e.duplicate || e.prefix),
                  );
                  return (
                    <li key={cmd.id}>
                      <label>
                        <input
                          type="checkbox"
                          checked={locked.has(cmd.id)}
                          onChange={() => toggleLock(cmd.id)}
                        />
                        <span className="party-name">{cmd.name}</span>
                        <kbd className="seq">{cmd.sequenceLabel}</kbd>
                        {inConflict && <span className="badge prefix">冲突方</span>}
                      </label>
                    </li>
                  );
                })}
              </ul>
            </div>

            <div className="form-row resolver-actions">
              <button type="button" className="primary" onClick={runResolve} disabled={running}>
                {running ? '搜索中…' : '生成改键方案'}
              </button>
              <button type="button" onClick={downloadJson} disabled={!result}>
                下载方案 JSON
              </button>
            </div>
            {error && <p className="error">⚠ {error}</p>}
          </div>

          {result && result.solvable && (
            <div className="resolver-result">
              <div className="resolver-stats">
                <span className="resolver-stat ok">
                  <strong>{result.stats.changedCommandCount}</strong> 条命令改键
                </span>
                <span className="resolver-stat">
                  <strong>{result.stats.totalPresses}</strong> 新序列总按键数
                </span>
                <span className="resolver-stat ok">
                  <strong>0</strong> 剩余冲突（{result.stats.conflictCount} 个已消解）
                </span>
              </div>

              {result.changes.length === 0 ? (
                <p className="hint small">
                  ✅ 无需任何改动即无冲突（理论上不会出现：有冲突基线时方案必然包含改键）。
                </p>
              ) : (
                <table className="cmd-table resolver-table">
                  <thead>
                    <tr>
                      <th>命令（来源）</th>
                      <th>改前序列</th>
                      <th>改后序列</th>
                      <th>消除的冲突</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.changes.map((ch) => (
                      <tr key={ch.commandId}>
                        <td>
                          <span className="party-name">{ch.name}</span>
                          <span className="party-source"> @ {ch.contextPath}</span>
                        </td>
                        <td>
                          <kbd className="seq dim">{ch.fromLabel}</kbd>
                        </td>
                        <td>
                          <kbd className="seq">{ch.toLabel}</kbd>
                        </td>
                        <td>
                          <span className="conflict-chips">
                            {ch.resolvesGoalIds.map((gid) => (
                              <span
                                key={gid}
                                className={`conflict-chip ${gid.startsWith('dup:') ? 'dup' : 'pre'}`}
                              >
                                {goalLabels.get(gid) || gid}
                              </span>
                            ))}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}

              <div className="form-row resolver-actions">
                <button
                  type="button"
                  className="primary"
                  onClick={writeToSandbox}
                  disabled={result.changes.length === 0}
                  title="把全部改序列操作合并进变更沙盒草案，并跳转继续预演"
                >
                  🛠 全部写入变更沙盒并预演
                </button>
                <span className="dim small">仅写入浏览器草案，不触碰服务器数据</span>
              </div>
              {wroteNotice && <p className="hint small">{wroteNotice}</p>}
            </div>
          )}

          {result && !result.solvable && (
            <div className="resolver-result">
              <p className="resolver-no-solution">
                ⚠ 在当前锁定 / 候选池 / 改动上限条件下，{result.unresolved.length} 个冲突无法全部消解：
              </p>
              <ul className="unresolved-list">
                {result.unresolved.map((u) => (
                  <li key={u.goalId} className="unresolved-item">
                    <div className="unresolved-head">
                      <ConflictChip conflict={u.conflict} />
                      <span className={`badge ${KIND_LABEL[u.kind]?.tone === 'danger' ? 'duplicate' : 'prefix'}`}>
                        {KIND_LABEL[u.kind]?.label || u.kind}
                      </span>
                      {u.minChanges !== null && (
                        <span className="dim small">单冲突最少改动：{u.minChanges} 条</span>
                      )}
                    </div>
                    <p className="unresolved-reason">{u.reason}</p>
                    <ul className="blocked-list">
                      {u.blockedCommands.map((p) => (
                        <li key={p.commandId + (p.role || '')}>
                          <span className="party-name">{p.name}</span>
                          <kbd className="seq">{p.sequenceLabel}</kbd>
                          {u.type === 'prefix' && (
                            <span className={`role-tag ${p.role === 'prefix' ? '' : 'extension'}`}>
                              {p.role === 'prefix' ? '前缀方' : '延伸方'}
                            </span>
                          )}
                          <span className="party-source">来源：{p.contextPath}</span>
                          {!p.definedHere && <span className="badge shadowed">祖先命令·不可改</span>}
                          {p.definedHere && p.locked && <span className="badge duplicate">已锁定</span>}
                        </li>
                      ))}
                    </ul>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </div>
  );
}
