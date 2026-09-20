import React, { useCallback, useEffect, useState } from 'react';
import { api } from './api';
import ContextTree from './components/ContextTree';
import CommandsPanel from './components/CommandsPanel';
import BindingsPanel from './components/BindingsPanel';
import KeySimulator from './components/KeySimulator';
import RegressionSuite from './components/RegressionSuite';
import Sandbox from './components/Sandbox';
import ConflictResolver from './components/ConflictResolver';

export default function App() {
  const [state, setState] = useState({ contexts: [], commands: [] });
  const [selectedId, setSelectedId] = useState(null);
  const [review, setReview] = useState(null);
  const [globalError, setGlobalError] = useState('');
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState('review'); // review | regression | sandbox

  const refresh = useCallback(async () => {
    const s = await api.getState();
    setState(s);
    return s;
  }, []);

  const refreshReview = useCallback(async (id) => {
    if (!id) {
      setReview(null);
      return;
    }
    try {
      setReview(await api.review(id));
      setGlobalError('');
    } catch (err) {
      setGlobalError(err.message);
    }
  }, []);

  useEffect(() => {
    refresh()
      .then((s) => {
        const first = s.contexts.find((c) => !c.parentId) || s.contexts[0];
        if (first) setSelectedId(first.id);
      })
      .catch((err) => setGlobalError(err.message))
      .finally(() => setLoading(false));
  }, [refresh]);

  useEffect(() => {
    refreshReview(selectedId);
  }, [selectedId, state, refreshReview]);

  const selectedContext = state.contexts.find((c) => c.id === selectedId) || null;

  // ---- 上下文操作 ----
  const addContext = async (parentId) => {
    const name = window.prompt(parentId ? '新子上下文名称：' : '新顶层上下文名称：', parentId ? '新上下文' : '新根上下文');
    if (!name) return;
    try {
      const ctx = await api.createContext({ name: name.trim(), parentId });
      await refresh();
      setSelectedId(ctx.id);
    } catch (err) {
      window.alert(err.message);
    }
  };

  const renameContext = async (ctx) => {
    const name = window.prompt('重命名上下文：', ctx.name);
    if (name === null) return;
    try {
      await api.updateContext(ctx.id, { name: name.trim() });
      await refresh();
    } catch (err) {
      window.alert(err.message);
    }
  };

  const deleteContext = async (ctx) => {
    const ok = window.confirm(
      `确定删除上下文「${ctx.name}」？其全部后代上下文及属于它们的命令都会一并删除。`,
    );
    if (!ok) return;
    try {
      await api.deleteContext(ctx.id);
      const s = await refresh();
      if (ctx.id === selectedId) {
        const first = s.contexts.find((c) => !c.parentId) || s.contexts[0];
        setSelectedId(first ? first.id : null);
      }
    } catch (err) {
      window.alert(err.message);
    }
  };

  // ---- 命令操作 ----
  const createCommand = async (body) => {
    await api.createCommand(body);
    await refresh();
  };
  const updateCommand = async (id, body) => {
    await api.updateCommand(id, body);
    await refresh();
  };
  const deleteCommand = async (cmd) => {
    if (!window.confirm(`删除命令「${cmd.name}」（${cmd.sequenceLabel}）？`)) return;
    await api.deleteCommand(cmd.id);
    await refresh();
  };

  if (loading) return <div className="loading">加载中…</div>;

  return (
    <div className="app">
      <header className="app-header">
        <h1>⌨ 上下文快捷键审校台</h1>
        <p className="tagline">
          最近祖先生效 · 子级覆盖祖先 · 同层重复/前缀冲突检测 · 逐键模拟
        </p>
        <nav className="view-tabs">
          <button
            className={view === 'review' ? 'tab active' : 'tab'}
            onClick={() => setView('review')}
          >
            📝 审校与模拟
          </button>
          <button
            className={view === 'regression' ? 'tab active' : 'tab'}
            onClick={() => setView('regression')}
          >
            🧪 回归套件生成
          </button>
          <button
            className={view === 'sandbox' ? 'tab active' : 'tab'}
            onClick={() => setView('sandbox')}
          >
            🛠 变更沙盒
          </button>
        </nav>
      </header>

      {globalError && <div className="global-error">⚠ {globalError}</div>}

      {view === 'sandbox' ? (
        <div className="regression-layout">
          <Sandbox state={state} onRefresh={refresh} />
        </div>
      ) : view === 'regression' ? (
        <div className="regression-layout">
          <RegressionSuite />
        </div>
      ) : (
        <div className="layout">
          <aside className="col-left">
            <ContextTree
              contexts={state.contexts}
              selectedId={selectedId}
              onSelect={setSelectedId}
              onAdd={addContext}
              onRename={renameContext}
              onDelete={deleteContext}
            />
          </aside>

          <main className="col-mid">
            <CommandsPanel
              contexts={state.contexts}
              commands={state.commands}
              selectedContext={selectedContext}
              onCreate={createCommand}
              onUpdate={updateCommand}
              onDelete={deleteCommand}
            />
          </main>

          <section className="col-right">
            <BindingsPanel review={review} />
            <ConflictResolver
              selectedContext={selectedContext}
              review={review}
              state={state}
              onOpenSandbox={() => setView('sandbox')}
            />
            <KeySimulator
              key={'sim-' + (selectedContext?.id || 'none')}
              selectedContext={selectedContext}
              review={review}
            />
          </section>
        </div>
      )}
    </div>
  );
}
