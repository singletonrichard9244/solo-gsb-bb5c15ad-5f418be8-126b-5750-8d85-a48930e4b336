import React, { useEffect, useState } from 'react';

function emptyForm() {
  return { name: '', sequence: '', description: '' };
}

export default function CommandsPanel({ contexts, commands, selectedContext, onCreate, onUpdate, onDelete }) {
  const [form, setForm] = useState(emptyForm());
  const [editingId, setEditingId] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    setForm(emptyForm());
    setEditingId(null);
    setError('');
  }, [selectedContext?.id]);

  if (!selectedContext) {
    return (
      <div className="panel">
        <div className="panel-header">
          <h2>命令绑定</h2>
        </div>
        <p className="hint">请先在左侧选择一个上下文。</p>
      </div>
    );
  }

  const list = commands
    .filter((c) => c.contextId === selectedContext.id)
    .sort((a, b) => a.sequenceLabel.localeCompare(b.sequenceLabel));

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    try {
      if (editingId) {
        await onUpdate(editingId, {
          name: form.name,
          sequence: form.sequence,
          description: form.description,
        });
      } else {
        await onCreate({
          contextId: selectedContext.id,
          name: form.name,
          sequence: form.sequence,
          description: form.description,
        });
      }
      setForm(emptyForm());
      setEditingId(null);
    } catch (err) {
      setError(err.message);
    }
  };

  const startEdit = (cmd) => {
    setEditingId(cmd.id);
    setForm({ name: cmd.name, sequence: cmd.sequenceRaw, description: cmd.description || '' });
    setError('');
  };

  return (
    <div className="panel">
      <div className="panel-header">
        <h2>
          命令绑定 <span className="sub">@{selectedContext.name}</span>
        </h2>
      </div>

      <form className="command-form" onSubmit={submit}>
        <input
          placeholder="命令名称（如：保存）"
          value={form.name}
          onChange={(e) => setForm({ ...form, name: e.target.value })}
          required
        />
        <input
          className="seq-input"
          placeholder="按键序列，1~3 次，空格或逗号分隔（如 g l  或 Ctrl+Shift+P）"
          value={form.sequence}
          onChange={(e) => setForm({ ...form, sequence: e.target.value })}
          required
        />
        <input
          placeholder="说明（可选）"
          value={form.description}
          onChange={(e) => setForm({ ...form, description: e.target.value })}
        />
        <div className="form-row">
          <button type="submit" className="primary">
            {editingId ? '保存修改' : '添加命令'}
          </button>
          {editingId && (
            <button
              type="button"
              onClick={() => {
                setEditingId(null);
                setForm(emptyForm());
                setError('');
              }}
            >
              取消编辑
            </button>
          )}
        </div>
        {error && <p className="error">⚠ {error}</p>}
      </form>

      <table className="cmd-table">
        <thead>
          <tr>
            <th>命令</th>
            <th>序列</th>
            <th>说明</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {list.length === 0 && (
            <tr>
              <td colSpan={4} className="hint">
                该上下文还没有定义命令（可继承祖先绑定）。
              </td>
            </tr>
          )}
          {list.map((cmd) => (
            <tr key={cmd.id} className={editingId === cmd.id ? 'editing' : ''}>
              <td>{cmd.name}</td>
              <td>
                <kbd className="seq">{cmd.sequenceLabel}</kbd>
              </td>
              <td className="desc">{cmd.description}</td>
              <td className="row-actions">
                <button onClick={() => startEdit(cmd)}>编辑</button>
                <button className="danger" onClick={() => onDelete(cmd)}>
                  删除
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
