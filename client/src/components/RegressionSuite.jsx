import React, { useEffect, useState } from 'react';
import { api } from '../api';

const CONFLICT_META = {
  duplicate: { label: '同层重复', cls: 'dup' },
  prefix: { label: '前缀冲突', cls: 'pre' },
};

function StatCard({ value, label, tone = '' }) {
  return (
    <div className={`stat-card ${tone}`}>
      <div className="stat-value">{value}</div>
      <div className="stat-label">{label}</div>
    </div>
  );
}

function ConflictChips({ conflicts }) {
  if (!conflicts || conflicts.length === 0) return <span className="dim">无冲突</span>;
  const counts = conflicts.reduce((m, c) => m.set(c.type, (m.get(c.type) || 0) + 1), new Map());
  return (
    <span className="conflict-chips">
      {[...counts.entries()].map(([type, n]) => (
        <span key={type} className={`conflict-chip ${CONFLICT_META[type]?.cls || ''}`}>
          {CONFLICT_META[type]?.label || type} × {n}
        </span>
      ))}
    </span>
  );
}

function SuiteCase({ testCase, index }) {
  return (
    <div className="suite-case">
      <div className="suite-case-head">
        <span className="suite-index">#{index + 1}</span>
        <strong className="suite-path" title={testCase.contextPath}>
          {testCase.contextPath}
        </strong>
        <span className="dim small">
          {testCase.inputs.length} 个输入序列 · 覆盖 {testCase.coveredGoals.length} 个目标
        </span>
      </div>

      <table className="suite-input-table">
        <thead>
          <tr>
            <th style={{ width: 210 }}>需输入序列</th>
            <th>预期触发命令集合</th>
          </tr>
        </thead>
        <tbody>
          {testCase.inputs.map((inp) => (
            <tr key={inp.sequenceTokens.join('')} className={inp.duplicate ? 'row-conflict' : ''}>
              <td>
                <kbd className="seq">{inp.sequenceLabel}</kbd>
                {inp.duplicate && <span className="badge duplicate">同层重复，多命令同时触发</span>}
              </td>
              <td>
                {inp.expectedCommands.map((c) => (
                  <span key={c.commandId} className="expected-cmd">
                    {c.name}
                    <span className="party-source">（{c.contextPath}）</span>
                  </span>
                ))}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="suite-conflicts">
        <span className="suite-conflicts-label">预期冲突类型：</span>
        <ConflictChips conflicts={testCase.expectedConflicts} />
        {testCase.expectedConflicts.length > 0 && (
          <ul className="suite-conflict-list">
            {testCase.expectedConflicts.map((c, i) => (
              <li key={c.type + i}>
                <span className={`role-tag ${c.type === 'prefix' ? 'extension' : ''}`}>
                  {CONFLICT_META[c.type]?.label || c.type}
                </span>
                {c.type === 'prefix' ? (
                  <span>
                    <kbd>{c.prefixSequenceLabel}</kbd>
                    <em className="dim"> ⊂ </em>
                    <kbd>{c.extensionSequenceLabel}</kbd>
                    <span className="party-source">
                      {' '}
                      前缀方：{c.parties
                        .filter((p) => p.role === 'prefix')
                        .map((p) => `${p.name}（${p.contextPath}）`)
                        .join('、')}
                      ；延伸方：{c.parties
                        .filter((p) => p.role === 'extension')
                        .map((p) => `${p.name}（${p.contextPath}）`)
                        .join('、')}
                    </span>
                  </span>
                ) : (
                  <span>
                    <kbd>{c.sequenceLabel}</kbd>
                    <span className="party-source">
                      {' '}
                      {c.parties.map((p) => `${p.name}（${p.contextPath}）`).join('、')}
                    </span>
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

export default function RegressionSuite() {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [showJson, setShowJson] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      setData(await api.regressionSuite());
      setError('');
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const downloadJson = () => {
    if (!data) return;
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'regression-suite.json';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  if (loading) return <div className="loading">回归套件生成中…</div>;

  return (
    <div className="regression-page">
      <div className="regression-toolbar">
        <div className="regression-title">
          <h2>🧪 回归套件生成</h2>
          <span className="dim small">
            候选：全部叶子上下文 · 精确集合覆盖（叶子数最少，同解按路径字典序） · 数据时间：
            {data ? new Date(data.generatedAt).toLocaleString() : '-'}
          </span>
        </div>
        <div className="regression-actions">
          <button onClick={load} title="按当前数据重新生成">重新生成</button>
          <button className="primary" onClick={downloadJson} disabled={!data}>
            下载 JSON
          </button>
        </div>
      </div>

      {error && <p className="error">⚠ {error}</p>}

      {data && (
        <>
          <div className="stat-grid">
            <StatCard value={data.stats.leafCount} label="叶子上下文" />
            <StatCard value={data.stats.selectedContextCount} label="入选叶子（最少套件）" tone="ok" />
            <StatCard
              value={`${data.stats.coveredCommandCount}/${data.stats.triggerableCommandCount}`}
              label="已覆盖可触发命令"
              tone="ok"
            />
            <StatCard
              value={data.stats.unreachableCommandCount}
              label="不可触发命令（不计入覆盖）"
              tone={data.stats.unreachableCommandCount > 0 ? 'danger' : ''}
            />
            <StatCard value={data.stats.duplicateConflictCount} label="同层重复目标" tone="warn" />
            <StatCard value={data.stats.prefixConflictCount} label="前缀冲突目标" tone="warn" />
            <StatCard
              value={`${data.stats.coveredGoalCount}/${data.stats.coverableGoalCount}`}
              label="覆盖目标（命令+冲突）"
            />
            <StatCard value={data.stats.inputSequenceCount} label="输入序列总数" />
          </div>

          <div className="coverage-bar-wrap">
            <div className="coverage-bar">
              <div
                className="coverage-bar-fill"
                style={{
                  width: `${
                    data.stats.coverableGoalCount > 0
                      ? (data.stats.coveredGoalCount / data.stats.coverableGoalCount) * 100
                      : 100
                  }%`,
                }}
              />
            </div>
            <span className="dim small">
              覆盖率 {data.stats.coverableGoalCount > 0
                ? Math.round((data.stats.coveredGoalCount / data.stats.coverableGoalCount) * 100)
                : 100}%
              （{data.stats.coveredGoalCount}/{data.stats.coverableGoalCount}；不含不可触发命令）
            </span>
          </div>

          {data.stats.unreachableCommandCount > 0 && (
            <div className="unreachable-panel">
              <h3>⚠ 任何叶子都无法触发的命令（{data.unreachableCommands.length}）</h3>
              <table className="bind-table">
                <thead>
                  <tr>
                    <th>命令</th>
                    <th>序列</th>
                    <th>定义位置</th>
                    <th>无法触发原因</th>
                  </tr>
                </thead>
                <tbody>
                  {data.unreachableCommands.map((u) => (
                    <tr key={u.commandId}>
                      <td>{u.name}</td>
                      <td>
                        <kbd className="seq dim">{u.sequenceLabel}</kbd>
                      </td>
                      <td className="source">{u.contextPath}</td>
                      <td className="reason-cell">{u.reason}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div className="suite-cases">
            <h3>
              入选上下文测试用例（{data.suite.length}）
              <span className="dim small"> 每个用例列出需输入序列、预期触发命令集合与预期冲突类型</span>
            </h3>
            {data.suite.length === 0 && (
              <p className="hint">没有可覆盖的目标（上下文中尚无命令或冲突）。</p>
            )}
            {data.suite.map((tc, i) => (
              <SuiteCase key={tc.contextId} testCase={tc} index={i} />
            ))}
          </div>

          <details className="json-details" onToggle={(e) => setShowJson(e.target.open)}>
            <summary>查看完整 JSON（{data.candidates.length} 个候选叶子的覆盖数见内）</summary>
            {showJson && <pre className="json-pre">{JSON.stringify(data, null, 2)}</pre>}
          </details>
        </>
      )}
    </div>
  );
}
