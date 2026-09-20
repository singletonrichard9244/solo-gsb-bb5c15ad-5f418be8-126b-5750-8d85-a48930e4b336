import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';

/**
 * 变更沙盒：
 * - 基于当前状态批量暂存命令的新增 / 改序列 / 删除，草案只保存在浏览器
 *   localStorage，既不写入数据文件，也不影响审校页；
 * - 预演由后端在同一份草案上分别计算基线与模拟状态后给出差异（含基线版本指纹），
 *   本页展示每项差异的来源路径与最短触发输入，支持清空草案与下载预演 JSON；
 * - 草案已成功预演且不引入任何新增 duplicate / prefix 冲突时可一键发布：
 *   后端在单次临界区内重新核对指纹、复用草案校验并原子落盘；
 *   发布成功后清空本地草案并刷新审校状态，失败（基线变化/仍有冲突）保留草案
 *   供调整后重新预演，绝不部分落盘。
 */

export const DRAFT_KEY = 'shortcut-sandbox-draft-v1';

function emptyDraft() {
  return { adds: [], updates: [], deletes: [] };
}

function loadDraft() {
  try {
    const raw = window.localStorage.getItem(DRAFT_KEY);
    if (!raw) return emptyDraft();
    const d = JSON.parse(raw);
    return {
      adds: Array.isArray(d.adds) ? d.adds : [],
      updates: Array.isArray(d.updates) ? d.updates : [],
      deletes: Array.isArray(d.deletes) ? d.deletes : [],
    };
  } catch {
    return emptyDraft();
  }
}

const draftSize = (d) => d.adds.length + d.updates.length + d.deletes.length;

/** 草案新增命令的稳定 id：仅存在于浏览器草案与预演结果中，不会写入数据文件 */
function newDraftId() {
  return `draft-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

const DRAFT_OP_LABEL = { add: '草案新增', update: '草案改序列', delete: '草案删除' };

function StatCard({ value, label, tone = '' }) {
  return (
    <div className={`stat-card ${tone}`}>
      <div className="stat-value">{value}</div>
      <div className="stat-label">{label}</div>
    </div>
  );
}

/** 生效绑定 / shadowed 条目的一行差异（来源路径 + 最短触发输入） */
function BindingDiffList({ diff }) {
  const renderItem = (item, kind) => (
    <li key={`${kind}-${item.commandId}`} className={`diff-item ${kind}`}>
      <span className="diff-sign">{kind === 'appeared' ? '＋' : '−'}</span>
      <kbd className="seq">{item.sequenceLabel}</kbd>
      <span className="party-name">{item.name}</span>
      {item.state === 'duplicate' && <span className="badge duplicate">同层重复</span>}
      {item.draftOp && <span className="badge draft">{DRAFT_OP_LABEL[item.draftOp]}</span>}
      <span className="party-source" title="绑定来源（上下文路径）">
        来源：{item.contextPath}
      </span>
      <span className="party-trigger" title="最短触发输入">
        最短触发：<kbd>{item.shortestLabel}</kbd>
      </span>
    </li>
  );
  return (
    <ul className="diff-list">
      {diff.appeared.map((i) => renderItem(i, 'appeared'))}
      {diff.disappeared.map((i) => renderItem(i, 'disappeared'))}
    </ul>
  );
}

/** duplicate / prefix 冲突的一行差异（双方来源路径 + 各自最短触发输入） */
function ConflictDiffList({ diff }) {
  const renderConflict = (c, kind) => (
    <li key={`${kind}-${c.goalId}`} className={`diff-item ${kind}`}>
      <span className="diff-sign">{kind === 'appeared' ? '＋' : '−'}</span>
      {c.type === 'prefix' ? (
        <span className="conflict-seqs">
          <kbd>{c.prefixSequenceLabel}</kbd>
          <em className="dim"> ⊂ </em>
          <kbd>{c.extensionSequenceLabel}</kbd>
        </span>
      ) : (
        <kbd className="seq">{c.sequenceLabel}</kbd>
      )}
      <span className="conflict-parties-inline">
        {c.parties.map((p) => (
          <span key={p.commandId} className="expected-cmd">
            {c.type === 'prefix' && (
              <span className={`role-tag ${p.role}`}>{p.role === 'prefix' ? '前缀方' : '延伸方'}</span>
            )}
            {p.name}
            {p.draftOp && <span className="badge draft">{DRAFT_OP_LABEL[p.draftOp]}</span>}
            <span className="party-source">
              （来源：{p.contextPath}，最短触发：<kbd>{p.shortestLabel}</kbd>）
            </span>
          </span>
        ))}
      </span>
    </li>
  );
  return (
    <ul className="diff-list">
      {diff.appeared.map((c) => renderConflict(c, 'appeared'))}
      {diff.disappeared.map((c) => renderConflict(c, 'disappeared'))}
    </ul>
  );
}

function DiffSection({ title, diff, kind }) {
  if (diff.appeared.length + diff.disappeared.length === 0) return null;
  return (
    <div className="diff-section">
      <h4>
        {title}{' '}
        <span className="dim small">
          （＋{diff.appeared.length} / −{diff.disappeared.length}）
        </span>
      </h4>
      {kind === 'bindings' ? <BindingDiffList diff={diff} /> : <ConflictDiffList diff={diff} />}
    </div>
  );
}

export default function Sandbox({ state, onRefresh }) {
  const [draft, setDraft] = useState(loadDraft);
  const [preview, setPreview] = useState(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [running, setRunning] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [publishError, setPublishError] = useState(null);
  const [published, setPublished] = useState(null);
  const [ctxId, setCtxId] = useState('');
  const [addForm, setAddForm] = useState({ name: '', sequence: '', description: '' });

  // 进入沙盒时同步一次最新数据（草案不受影响）
  useEffect(() => {
    onRefresh?.();
  }, [onRefresh]);

  // 上下文路径 / 索引
  const { pathOf, cmdById } = useMemo(() => {
    const ctxById = new Map(state.contexts.map((c) => [c.id, c]));
    const cmdById = new Map(state.commands.map((c) => [c.id, c]));
    const pathOf = (id) => {
      const names = [];
      const guard = new Set();
      let cur = ctxById.get(id);
      while (cur && !guard.has(cur.id)) {
        guard.add(cur.id);
        names.unshift(cur.name);
        cur = cur.parentId ? ctxById.get(cur.parentId) : null;
      }
      return names.join(' / ') || id;
    };
    return { pathOf, cmdById };
  }, [state]);

  // 目标上下文默认选中第一个根
  useEffect(() => {
    if (!ctxId || !state.contexts.some((c) => c.id === ctxId)) {
      const first = state.contexts.find((c) => !c.parentId) || state.contexts[0];
      setCtxId(first ? first.id : '');
    }
  }, [state, ctxId]);

  // 草案仅保存在浏览器 localStorage
  useEffect(() => {
    try {
      window.localStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
    } catch {
      /* 隐私模式等场景写入失败时仅保留在内存 */
    }
  }, [draft]);

  // 数据变化后剔除失效的草案操作（目标命令 / 上下文已不存在）
  const draftRef = useRef(draft);
  draftRef.current = draft;
  useEffect(() => {
    const d = draftRef.current;
    const cmdIds = new Set(state.commands.map((c) => c.id));
    const ctxIds = new Set(state.contexts.map((c) => c.id));
    const adds = d.adds.filter((a) => ctxIds.has(a.contextId));
    const updates = d.updates.filter((u) => cmdIds.has(u.commandId));
    const deletes = d.deletes.filter((id) => cmdIds.has(id));
    const removed =
      d.adds.length - adds.length + (d.updates.length - updates.length) + (d.deletes.length - deletes.length);
    if (removed > 0) {
      setDraft({ adds, updates, deletes });
      setNotice(`已移除 ${removed} 条失效的草案操作（目标命令或上下文已不存在）。`);
    }
  }, [state]);

  const isEmpty = draftSize(draft) === 0;

  // 当前展示的预演是否与当前草案一致（草案一改即过期，发布按钮禁用）
  const previewSignature = preview?._draftSignature || '';
  const currentSignature = JSON.stringify(draft);
  const previewFresh = !isEmpty && !!preview && previewSignature === currentSignature;
  const newConflictCount = preview
    ? preview.stats.duplicateAppeared + preview.stats.prefixAppeared
    : 0;
  const canPublish = previewFresh && newConflictCount === 0 && !publishing;

  const runPreview = useCallback(async (d) => {
    setRunning(true);
    setPublishError(null);
    try {
      const result = await api.sandboxPreview(d);
      result._draftSignature = JSON.stringify(d);
      setPreview(result);
      setError('');
      return result;
    } catch (err) {
      setPreview(null);
      setError(err.message);
      return null;
    } finally {
      setRunning(false);
    }
  }, []);

  // 草案变化后自动生成预演（防抖）
  useEffect(() => {
    if (isEmpty) {
      setPreview(null);
      setError('');
      return;
    }
    setPublishError(null);
    const timer = setTimeout(() => runPreview(draft), 250);
    return () => clearTimeout(timer);
  }, [draft, isEmpty, runPreview]);

  // ---- 暂存操作 ----
  const stageAdd = (e) => {
    e.preventDefault();
    if (!ctxId) return;
    if (!addForm.name.trim() || !addForm.sequence.trim()) {
      setError('暂存新增需要填写命令名称与按键序列');
      return;
    }
    setDraft((prev) => ({
      ...prev,
      adds: [
        ...prev.adds,
        {
          draftId: newDraftId(),
          contextId: ctxId,
          name: addForm.name.trim(),
          sequence: addForm.sequence.trim(),
          description: addForm.description.trim(),
        },
      ],
    }));
    setAddForm({ name: '', sequence: '', description: '' });
    setError('');
  };

  const stagedUpdate = (id) => draft.updates.find((u) => u.commandId === id);
  const stagedDelete = (id) => draft.deletes.includes(id);

  const stageUpdate = (cmd) => {
    const seq = window.prompt(
      `修改「${cmd.name}」的序列（当前：${cmd.sequenceLabel}）：`,
      cmd.sequenceRaw || cmd.sequenceLabel,
    );
    if (seq === null || !seq.trim()) return;
    setDraft((prev) => ({
      ...prev,
      updates: [...prev.updates.filter((u) => u.commandId !== cmd.id), { commandId: cmd.id, sequence: seq.trim() }],
    }));
  };

  const stageDelete = (cmd) => {
    setDraft((prev) => ({
      ...prev,
      updates: prev.updates.filter((u) => u.commandId !== cmd.id), // 删除取代已暂存的改序列
      deletes: prev.deletes.includes(cmd.id) ? prev.deletes : [...prev.deletes, cmd.id],
    }));
  };

  const unstage = (kind, key) => {
    setDraft((prev) => {
      if (kind === 'add') return { ...prev, adds: prev.adds.filter((a) => a.draftId !== key) };
      if (kind === 'update') return { ...prev, updates: prev.updates.filter((u) => u.commandId !== key) };
      return { ...prev, deletes: prev.deletes.filter((id) => id !== key) };
    });
  };

  const clearDraft = () => {
    if (isEmpty) return;
    if (!window.confirm('确定清空全部草案操作？仅清除浏览器中的草案，不会影响服务器数据。')) return;
    setDraft(emptyDraft());
    setPreview(null);
    setPublishError(null);
    setPublished(null);
    setNotice('草案已清空。');
  };

  /**
   * 发布当前草案：必须先有与草案一致的成功预演且无新增冲突。
   * 成功 => 清空本地草案、刷新审校状态、展示新增/改序列/删除数量；
   * 失败 => 保留草案供重新预演：
   *   BASELINE_CHANGED：拉取最新状态并以最新数据重新预演（失效操作由现有逻辑剔除）；
   *   DRAFT_CONFLICTS：展示新增冲突，要求调整草案后重新预演。
   */
  const publish = async () => {
    if (!previewFresh) return;
    setPublishing(true);
    setPublishError(null);
    try {
      const result = await api.sandboxPublish(draft, preview.baseline.fingerprint);
      setPublished(result);
      setDraft(emptyDraft());
      setPreview(null);
      setError('');
      try {
        window.localStorage.removeItem(DRAFT_KEY);
      } catch {
        /* 忽略本地存储异常 */
      }
      await onRefresh?.();
    } catch (err) {
      let info;
      try {
        info = err.info || null;
      } catch {
        info = null;
      }
      setPublishError({ message: err.message, ...(info || {}) });
      // 基线已变化：刷新最新数据后重新预演当前草案（仍保留在本地）
      if (err.code === 'BASELINE_CHANGED') {
        try {
          await onRefresh?.();
          const d = loadDraft();
          if (draftSize(d) > 0) await runPreview(d);
        } catch {
          /* 刷新失败时仅展示错误，草案保留 */
        }
      }
    } finally {
      setPublishing(false);
    }
  };

  const downloadJson = () => {
    if (!preview) return;
    const { _draftSignature, ...cleanPreview } = preview;
    const blob = new Blob([JSON.stringify(cleanPreview, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'sandbox-preview.json';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  const ctxCommands = state.commands
    .filter((c) => c.contextId === ctxId)
    .sort((a, b) => a.sequenceLabel.localeCompare(b.sequenceLabel));

  return (
    <div className="regression-page sandbox-page">
      <div className="regression-toolbar">
        <div className="regression-title">
          <h2>🛠 变更沙盒</h2>
          <span className="dim small">
            草案仅保存在浏览器，不会写入数据文件，也不影响审校页；预演在服务端内存副本上对比基线与模拟状态
            {preview ? ` · 预演时间：${new Date(preview.generatedAt).toLocaleString()}` : ''}
          </span>
        </div>
        <div className="regression-actions">
          <button onClick={() => runPreview(draft)} disabled={isEmpty || running}>
            {running ? '预演中…' : '重新预演'}
          </button>
          <button
            className="primary"
            onClick={publish}
            disabled={!canPublish}
            title={
              isEmpty
                ? '草案为空'
                : !previewFresh
                  ? '草案已修改，请先重新预演'
                  : newConflictCount > 0
                    ? '预演显示仍有新增的同层重复 / 前缀冲突'
                    : '把当前草案原子写入真实数据'
            }
          >
            {publishing ? '发布中…' : '✅ 发布草案'}
          </button>
          <button className="primary" onClick={downloadJson} disabled={!preview}>
            下载预演 JSON
          </button>
          <button className="danger" onClick={clearDraft} disabled={isEmpty}>
            清空草案
          </button>
        </div>
      </div>

      {notice && (
        <p className="sandbox-notice">
          <span>ℹ {notice}</span>
          <button onClick={() => setNotice('')}>知道了</button>
        </p>
      )}
      {error && <p className="error">⚠ {error}</p>}

      {published && (
        <div className="publish-success panel">
          <div className="publish-success-head">
            <strong>✅ 草案已发布并原子写入数据</strong>
            <button onClick={() => setPublished(null)}>知道了</button>
          </div>
          <div className="stat-grid">
            <StatCard value={published.counts.adds} label="新增命令" tone="ok" />
            <StatCard value={published.counts.updates} label="改序列命令" tone="ok" />
            <StatCard value={published.counts.deletes} label="删除命令" tone="danger" />
          </div>
          <p className="dim small">
            发布时间：{new Date(published.publishedAt).toLocaleString()} · 本地草案已清空，审校状态已按
            新版本刷新。
          </p>
        </div>
      )}

      {publishError && (
        <div className="publish-error panel">
          <div className="publish-error-head">
            <strong>⚠ 发布被拒绝（草案已保留，未写入任何数据）</strong>
            <button onClick={() => setPublishError(null)}>知道了</button>
          </div>
          <p>{publishError.message}</p>
          {publishError.code === 'BASELINE_CHANGED' && (
            <div>
              <p className="dim small">
                服务器当前版本：<code>{publishError.current?.fingerprint?.slice(0, 18)}…</code> ·
                上下文 {publishError.current?.contextCount} · 命令 {publishError.current?.commandCount}
                ；已按最新数据重新预演，请确认后再次发布。
              </p>
              {publishError.invalidated?.stale && (
                <div className="invalidated-ops">
                  <h4>已失效的草案操作（数据已变化）</h4>
                  <ul className="diff-list">
                    {(publishError.invalidated.adds || []).map((a, i) => (
                      <li key={`ia-${i}`} className="diff-item disappeared">
                        <span className="diff-sign">−</span>
                        <span className="role-tag draft-add">新增</span>
                        <span className="dim small">目标上下文已不存在：{a.contextId || '（空）'}</span>
                      </li>
                    ))}
                    {(publishError.invalidated.updates || []).map((u) => (
                      <li key={`iu-${u.commandId}`} className="diff-item disappeared">
                        <span className="diff-sign">−</span>
                        <span className="role-tag draft-update">改序列</span>
                        <span className="dim small">命令已不存在：{u.commandId}</span>
                      </li>
                    ))}
                    {(publishError.invalidated.deletes || []).map((d2) => (
                      <li key={`id-${d2.commandId}`} className="diff-item disappeared">
                        <span className="diff-sign">−</span>
                        <span className="role-tag draft-delete">删除</span>
                        <span className="dim small">命令已不存在：{d2.commandId}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
          {publishError.code === 'DRAFT_CONFLICTS' && (
            <div className="invalidated-ops">
              <h4>预演新增的冲突（{publishError.newConflicts?.length || 0} 项）</h4>
              <ul className="diff-list">
                {(publishError.newConflicts || []).map((c, i) => (
                  <li key={`nc-${i}`} className="diff-item appeared">
                    <span className="diff-sign">＋</span>
                    <span className={`badge ${c.type === 'duplicate' ? 'duplicate' : 'prefix'}`}>
                      {c.type === 'duplicate' ? '同层重复' : '前缀冲突'}
                    </span>
                    <span className="party-source">
                      {c.contextPath}：{c.sequenceLabel || `${c.prefixSequenceLabel} ⊂ ${c.extensionSequenceLabel}`}
                    </span>
                    <span className="dim small">{(c.commandIds || []).join(', ')}</span>
                  </li>
                ))}
              </ul>
              <p className="dim small">请在草案中调整相关操作后重新预演，无新增冲突时才能发布。</p>
            </div>
          )}
        </div>
      )}

      <div className="panel">
        <div className="panel-header">
          <h2>
            ① 暂存命令变更 <span className="sub">基于当前状态，批量暂存新增 / 改序列 / 删除</span>
          </h2>
        </div>
        <div className="sandbox-stage">
          <label className="sandbox-field">
            <span className="dim small">目标上下文</span>
            <select value={ctxId} onChange={(e) => setCtxId(e.target.value)}>
              {state.contexts.map((c) => (
                <option key={c.id} value={c.id}>
                  {pathOf(c.id)}
                </option>
              ))}
            </select>
          </label>

          <form className="command-form sandbox-add-form" onSubmit={stageAdd}>
            <input
              placeholder="命令名称（如：保存）"
              value={addForm.name}
              onChange={(e) => setAddForm({ ...addForm, name: e.target.value })}
            />
            <input
              className="seq-input"
              placeholder="按键序列，1~3 次，空格或逗号分隔（如 g l  或 Ctrl+Shift+P）"
              value={addForm.sequence}
              onChange={(e) => setAddForm({ ...addForm, sequence: e.target.value })}
            />
            <input
              placeholder="说明（可选）"
              value={addForm.description}
              onChange={(e) => setAddForm({ ...addForm, description: e.target.value })}
            />
            <div className="form-row">
              <button type="submit" className="primary">
                暂存新增
              </button>
            </div>
          </form>

          <table className="cmd-table">
            <thead>
              <tr>
                <th>命令</th>
                <th>当前序列</th>
                <th>草案状态</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {ctxCommands.length === 0 && (
                <tr>
                  <td colSpan={4} className="hint">
                    该上下文还没有命令，可在上方暂存新增。
                  </td>
                </tr>
              )}
              {ctxCommands.map((cmd) => {
                const upd = stagedUpdate(cmd.id);
                const del = stagedDelete(cmd.id);
                return (
                  <tr key={cmd.id} className={del ? 'row-shadowed' : upd ? 'editing' : ''}>
                    <td>{cmd.name}</td>
                    <td>
                      <kbd className="seq">{cmd.sequenceLabel}</kbd>
                    </td>
                    <td>
                      {del && <span className="badge duplicate">已暂存删除</span>}
                      {upd && !del && (
                        <span className="badge prefix">
                          改序列为 <kbd>{upd.sequence}</kbd>
                        </span>
                      )}
                      {!del && !upd && <span className="dim small">—</span>}
                    </td>
                    <td className="row-actions">
                      {del || upd ? (
                        <button onClick={() => unstage(del ? 'delete' : 'update', cmd.id)}>撤销暂存</button>
                      ) : (
                        <>
                          <button onClick={() => stageUpdate(cmd)}>改序列</button>
                          <button className="danger" onClick={() => stageDelete(cmd)}>
                            删除
                          </button>
                        </>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      <div className="panel">
        <div className="panel-header">
          <h2>
            ② 草案清单 <span className="sub">{draftSize(draft)} 条操作 · 仅保存在浏览器</span>
          </h2>
          <button className="danger" onClick={clearDraft} disabled={isEmpty}>
            清空草案
          </button>
        </div>
        {isEmpty ? (
          <p className="hint">草案为空。在上方暂存新增、改序列或删除操作后，这里会列出清单并自动生成预演。</p>
        ) : (
          <ul className="draft-list">
            {draft.adds.map((a) => (
              <li key={a.draftId} className="draft-op">
                <span className="diff-sign plus">＋</span>
                <span className="role-tag draft-add">新增</span>
                <span className="party-name">{a.name}</span>
                <kbd className="seq">{a.sequence}</kbd>
                <span className="party-source">@ {pathOf(a.contextId)}</span>
                {a.description && <span className="dim small">— {a.description}</span>}
                <button onClick={() => unstage('add', a.draftId)}>撤销</button>
              </li>
            ))}
            {draft.updates.map((u) => {
              const cmd = cmdById.get(u.commandId);
              if (!cmd) return null;
              return (
                <li key={u.commandId} className="draft-op">
                  <span className="diff-sign tilde">✎</span>
                  <span className="role-tag draft-update">改序列</span>
                  <span className="party-name">{cmd.name}</span>
                  <kbd className="seq dim">{cmd.sequenceLabel}</kbd>
                  <span className="dim">→</span>
                  <kbd className="seq">{u.sequence}</kbd>
                  <span className="party-source">@ {pathOf(cmd.contextId)}</span>
                  <button onClick={() => unstage('update', u.commandId)}>撤销</button>
                </li>
              );
            })}
            {draft.deletes.map((id) => {
              const cmd = cmdById.get(id);
              if (!cmd) return null;
              return (
                <li key={id} className="draft-op">
                  <span className="diff-sign minus">−</span>
                  <span className="role-tag draft-delete">删除</span>
                  <span className="party-name">{cmd.name}</span>
                  <kbd className="seq dim">{cmd.sequenceLabel}</kbd>
                  <span className="party-source">@ {pathOf(cmd.contextId)}</span>
                  <button onClick={() => unstage('delete', id)}>撤销</button>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <div className="panel">
        <div className="panel-header">
          <h2>
            ③ 发布草案 <span className="sub">仅可发布已成功预演、且无新增 duplicate / prefix 冲突的草案</span>
          </h2>
        </div>
        {isEmpty ? (
          <p className="hint">草案为空：暂存操作并完成预演后，可在此原子发布到真实数据。</p>
        ) : (
          <div className="publish-box">
            <ul className="publish-checks">
              <li className={preview ? 'ok' : running ? 'pending' : 'bad'}>
                {preview ? '✅' : running ? '⏳' : '⚠'} 已成功预演
                {preview && (
                  <span className="dim small">
                    （{new Date(preview.generatedAt).toLocaleTimeString()}）
                  </span>
                )}
                {!preview && !running && <span className="dim small">请等待或手动重新预演</span>}
              </li>
              <li className={previewFresh ? 'ok' : 'bad'}>
                {previewFresh ? '✅' : '⚠'} 预演与当前草案一致
                {!previewFresh && <span className="dim small">（草案已修改，正在/需要重新预演）</span>}
              </li>
              <li className={newConflictCount === 0 ? 'ok' : 'bad'}>
                {newConflictCount === 0 ? '✅' : '⚠'} 无新增同层重复 / 前缀冲突
                {newConflictCount > 0 && (
                  <span className="dim small">
                    （新增 duplicate {preview.stats.duplicateAppeared} · prefix{' '}
                    {preview.stats.prefixAppeared}）
                  </span>
                )}
              </li>
            </ul>
            <p className="dim small">
              发布在服务端单次临界区内完成：重新核对基线指纹（
              <code>{preview ? `${preview.baseline.fingerprint.slice(0, 18)}…` : '—'}</code>
              ）→ 复用草案校验 → 原子落盘。数据在别处已变化时会拒绝发布并返回当前版本与失效操作，
              不会部分落盘；失败时草案保留，可调整后重新预演。
            </p>
            <div className="publish-actions">
              <button className="primary" onClick={publish} disabled={!canPublish}>
                {publishing ? '发布中…' : '✅ 发布草案'}
              </button>
              {!isEmpty && newConflictCount > 0 && (
                <span className="error-inline">存在新增冲突，无法发布，请调整草案</span>
              )}
            </div>
          </div>
        )}
      </div>

      <div className="panel">
        <div className="panel-header">
          <h2>
            ④ 预演结果 <span className="sub">基线 vs 应用草案后的模拟状态</span>
          </h2>
          <button className="primary" onClick={downloadJson} disabled={!preview}>
            下载预演 JSON
          </button>
        </div>
        {isEmpty && <p className="hint">草案为空：暂存操作后自动生成预演，对比基线与模拟状态的差异。</p>}
        {!isEmpty && !preview && !error && <p className="hint">预演计算中…</p>}
        {preview && (
          <div className="sandbox-preview">
            <div className="stat-grid">
              <StatCard value={preview.stats.changedContextCount} label="有变化的上下文" />
              <StatCard
                value={`＋${preview.stats.effectiveAppeared} / −${preview.stats.effectiveDisappeared}`}
                label="生效绑定 新增/消失"
                tone="ok"
              />
              <StatCard
                value={`＋${preview.stats.shadowedAppeared} / −${preview.stats.shadowedDisappeared}`}
                label="shadowed 新增/消失"
              />
              <StatCard
                value={`＋${preview.stats.duplicateAppeared} / −${preview.stats.duplicateDisappeared}`}
                label="同层重复 新增/消失"
                tone={preview.stats.duplicateAppeared > 0 ? 'warn' : ''}
              />
              <StatCard
                value={`＋${preview.stats.prefixAppeared} / −${preview.stats.prefixDisappeared}`}
                label="前缀冲突 新增/消失"
                tone={preview.stats.prefixAppeared > 0 ? 'warn' : ''}
              />
              <StatCard
                value={`＋${preview.stats.unreachableAppeared} / −${preview.stats.unreachableDisappeared}`}
                label="不可触发命令 新增/消失"
                tone={preview.stats.unreachableAppeared > 0 ? 'danger' : ''}
              />
            </div>

            {preview.stats.totalChanges === 0 && (
              <p className="hint">✅ 草案与基线完全一致：没有产生任何差异。</p>
            )}

            {newConflictCount > 0 && (
              <p className="error">
                ⛔ 本草案新增 {preview.stats.duplicateAppeared} 项同层重复、
                {preview.stats.prefixAppeared} 项前缀冲突——存在新增冲突时不可发布，请调整草案。
              </p>
            )}
            {previewFresh && newConflictCount === 0 && (
              <p className="hint ok-hint">
                ✅ 预演成功且无新增 duplicate / prefix 冲突，可以发布。
              </p>
            )}

            {preview.unreachable.appeared.length + preview.unreachable.disappeared.length > 0 && (
              <div className="unreachable-panel">
                <h3>不可触发命令变化（任何叶子都无法触发）</h3>
                <ul className="diff-list">
                  {preview.unreachable.appeared.map((u) => (
                    <li key={`ua-${u.commandId}`} className={`diff-item appeared`}>
                      <span className="diff-sign">＋</span>
                      <span className="party-name">{u.name}</span>
                      <kbd className="seq">{u.sequenceLabel}</kbd>
                      {u.draftOp && <span className="badge draft">{DRAFT_OP_LABEL[u.draftOp]}</span>}
                      <span className="party-source">来源：{u.contextPath}</span>
                      <span className="reason-cell">{u.reason}</span>
                    </li>
                  ))}
                  {preview.unreachable.disappeared.map((u) => (
                    <li key={`ud-${u.commandId}`} className={`diff-item disappeared`}>
                      <span className="diff-sign">−</span>
                      <span className="party-name">{u.name}</span>
                      <kbd className="seq">{u.sequenceLabel}</kbd>
                      {u.draftOp && <span className="badge draft">{DRAFT_OP_LABEL[u.draftOp]}</span>}
                      <span className="party-source">来源：{u.contextPath}</span>
                      <span className="party-trigger">
                        最短触发：<kbd>{u.sequenceLabel}</kbd>
                      </span>
                      <span className="reason-cell">恢复可触发（原原因：{u.reason}）</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {preview.contexts.map((ctx) => (
              <div className="suite-case" key={ctx.contextId}>
                <div className="suite-case-head">
                  <strong className="suite-path" title={ctx.contextPath}>
                    {ctx.contextPath}
                  </strong>
                  <span className="dim small">{ctx.changeCount} 项变化</span>
                </div>
                <div className="diff-sections">
                  <DiffSection title="生效绑定" diff={ctx.effective} kind="bindings" />
                  <DiffSection title="已覆盖（shadowed）" diff={ctx.shadowed} kind="bindings" />
                  <DiffSection title="同层重复（duplicate）" diff={ctx.duplicate} kind="conflicts" />
                  <DiffSection title="前缀冲突（prefix）" diff={ctx.prefix} kind="conflicts" />
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
