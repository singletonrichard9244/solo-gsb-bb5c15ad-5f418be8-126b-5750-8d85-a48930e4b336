import React from 'react';

function Badges({ entry }) {
  const badges = [];
  if (entry.state === 'shadowed') badges.push(<span key="sh" className="badge shadowed">已覆盖</span>);
  if (entry.duplicate) badges.push(<span key="dup" className="badge duplicate">同层重复</span>);
  if (entry.prefix === 'prefix') badges.push(<span key="pre" className="badge prefix">他序列前缀</span>);
  if (entry.prefix === 'extension') badges.push(<span key="ext" className="badge prefix">前缀延伸</span>);
  if (entry.state === 'active' && badges.length === 0) badges.push(<span key="ok" className="badge active">生效</span>);
  return <span className="badges">{badges}</span>;
}

function ConflictCard({ conflict }) {
  return (
    <div className={`conflict-card ${conflict.type}`}>
      <div className="conflict-head">
        <strong>
          {conflict.kindLabel === '前缀冲突' ? '🔀' : '⛔'} {conflict.kindLabel}
        </strong>
        {conflict.type === 'prefix' ? (
          <span className="conflict-seqs">
            <kbd>{conflict.prefixSequenceLabel}</kbd>
            <em> ⊂ </em>
            <kbd>{conflict.extensionSequenceLabel}</kbd>
          </span>
        ) : (
          <span className="conflict-seqs">
            <kbd>{conflict.sequenceLabel}</kbd>
          </span>
        )}
      </div>
      <ul className="conflict-parties">
        {conflict.parties.map((p) => (
          <li key={p.commandId + p.role}>
            <span className={`role-tag ${p.role || ''}`}>
              {conflict.type === 'prefix' ? (p.role === 'prefix' ? '前缀方' : '延伸方') : '重复方'}
            </span>
            <span className="party-name">{p.name}</span>
            <span className="party-source" title="绑定来源（上下文路径）">
              来源：{p.contextPath}
            </span>
            <span className="party-trigger" title="最短触发输入">
              最短触发：<kbd>{p.shortestLabel}</kbd>
            </span>
          </li>
        ))}
      </ul>
      {conflict.type === 'prefix' && (
        <p className="hint small">
          按下 <kbd>{conflict.prefixSequenceLabel}</kbd> 即触发前缀命令，必须依赖消歧机制或继续按键才能到达
          <kbd> {conflict.extensionSequenceLabel}</kbd>。
        </p>
      )}
      {conflict.type === 'duplicate' && (
        <p className="hint small">同层重复绑定时按键将同时触发双方命令，通常属于配置错误。</p>
      )}
    </div>
  );
}

export default function BindingsPanel({ review }) {
  if (!review) {
    return (
      <div className="panel">
        <div className="panel-header">
          <h2>生效绑定与冲突</h2>
        </div>
        <p className="hint">选择左侧上下文后在此审校。</p>
      </div>
    );
  }

  const active = review.entries.filter((e) => e.state !== 'shadowed');
  const shadowed = review.entries.filter((e) => e.state === 'shadowed');

  return (
    <div className="panel">
      <div className="panel-header">
        <h2>
          生效绑定 <span className="sub">{review.contextPath}</span>
        </h2>
      </div>

      <div className="chain">
        <span className="chain-label">祖先链：</span>
        {review.chain.map((c, i) => (
          <React.Fragment key={c.id}>
            {i > 0 && <span className="chain-sep">→</span>}
            <span className={`chain-node ${c.id === review.contextId ? 'current' : ''}`}>{c.name}</span>
          </React.Fragment>
        ))}
      </div>

      {review.conflicts.length > 0 && (
        <div className="conflicts">
          <h3 className="conflict-title">
            冲突（{review.conflicts.length}）
          </h3>
          {review.conflicts.map((c, i) => (
            <ConflictCard key={c.type + i} conflict={c} />
          ))}
        </div>
      )}

      <table className="bind-table">
        <thead>
          <tr>
            <th>序列</th>
            <th>命令</th>
            <th>来源</th>
            <th>状态</th>
          </tr>
        </thead>
        <tbody>
          {active.map((e) => (
            <tr key={e.commandId} className={e.duplicate || e.prefix ? 'row-conflict' : ''}>
              <td>
                <kbd className="seq">{e.sequenceLabel}</kbd>
              </td>
              <td>
                {e.name}
                {e.description && <span className="desc-inline"> — {e.description}</span>}
              </td>
              <td className="source" title={e.contextPath}>
                {e.contextPath}
              </td>
              <td>
                <Badges entry={e} />
              </td>
            </tr>
          ))}
          {shadowed.map((e) => (
            <tr key={e.commandId} className="row-shadowed" title="被更深层（更近祖先）的同序列绑定覆盖">
              <td>
                <kbd className="seq dim">{e.sequenceLabel}</kbd>
              </td>
              <td className="dim">
                {e.name} <span className="dim-note">（祖先绑定，已被覆盖）</span>
              </td>
              <td className="source dim">{e.contextPath}</td>
              <td>
                <Badges entry={e} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
