import React from 'react';

export default function ContextTree({ contexts, selectedId, onSelect, onAdd, onRename, onDelete }) {
  const byParent = new Map();
  for (const c of contexts) {
    const key = c.parentId || '__root__';
    if (!byParent.has(key)) byParent.set(key, []);
    byParent.get(key).push(c);
  }

  const renderNode = (ctx, depth) => {
    const children = byParent.get(ctx.id) || [];
    const selected = ctx.id === selectedId;
    return (
      <div key={ctx.id}>
        <div
          className={`tree-node ${selected ? 'selected' : ''}`}
          style={{ paddingLeft: 8 + depth * 18 }}
          onClick={() => onSelect(ctx.id)}
          title={ctx.description || ctx.name}
        >
          <span className="tree-label">
            {children.length > 0 ? '▸' : '·'} {ctx.name}
          </span>
          <span className="tree-actions" onClick={(e) => e.stopPropagation()}>
            <button title="新增子上下文" onClick={() => onAdd(ctx.id)}>
              ＋子级
            </button>
            <button title="重命名" onClick={() => onRename(ctx)}>
              ✎
            </button>
            <button
              className="danger"
              title="删除（连同后代与其命令）"
              onClick={() => onDelete(ctx)}
            >
              ✕
            </button>
          </span>
        </div>
        {children.map((ch) => renderNode(ch, depth + 1))}
      </div>
    );
  };

  const roots = byParent.get('__root__') || [];

  return (
    <div className="panel context-tree">
      <div className="panel-header">
        <h2>上下文树</h2>
        <button onClick={() => onAdd(null)} title="新增一个顶层上下文">
          ＋根
        </button>
      </div>
      <div className="tree-body">
        {roots.length === 0 && <p className="hint">还没有上下文，点击「＋根」创建。</p>}
        {roots.map((r) => renderNode(r, 0))}
      </div>
      <p className="hint small">选择任一上下文，右侧按最近祖先规则构建生效绑定。</p>
    </div>
  );
}
