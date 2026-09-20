import React, { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { eventToToken } from '../keymap';
import TimelineReplay from './TimelineReplay';

const STATUS_META = {
  idle: { text: '空闲：点击录制区后开始按键', cls: 'idle' },
  waiting: { text: '等待后续按键…', cls: 'waiting' },
  triggered: { text: '命令已触发', cls: 'triggered' },
  'no-match': { text: '无匹配序列', cls: 'nomatch' },
};

export default function KeySimulator({ selectedContext, review }) {
  const [buffer, setBuffer] = useState([]);
  const [result, setResult] = useState(null);
  const [armed, setArmed] = useState(false);
  const [error, setError] = useState('');
  const [mode, setMode] = useState('instant'); // instant | replay
  const recorderRef = useRef(null);

  const run = async (nextBuffer) => {
    if (!selectedContext) return;
    try {
      const r = await api.simulate(selectedContext.id, nextBuffer);
      setResult(r);
      setError('');
    } catch (err) {
      setError(err.message);
    }
  };

  useEffect(() => {
    setBuffer([]);
    setResult(null);
    setError('');
  }, [selectedContext?.id]);

  useEffect(() => {
    if (!armed) return;
    const onKeyDown = (e) => {
      // Esc 清空缓冲
      if (e.key === 'Escape') {
        e.preventDefault();
        setBuffer([]);
        run([]);
        return;
      }
      // Backspace 回退一个按键
      if (e.key === 'Backspace') {
        e.preventDefault();
        setBuffer((prev) => {
          const next = prev.slice(0, -1);
          run(next);
          return next;
        });
        return;
      }
      e.preventDefault();
      const token = eventToToken(e);
      if (!token) return;
      setBuffer((prev) => {
        if (prev.length >= 3) return prev;
        const next = [...prev, token];
        run(next);
        return next;
      });
    };
    const node = recorderRef.current;
    node?.addEventListener('keydown', onKeyDown);
    return () => node?.removeEventListener('keydown', onKeyDown);
  });

  if (!selectedContext) return null;

  const status = result?.status || 'idle';
  const meta = STATUS_META[status];

  return (
    <div className="panel simulator">
      <div className="panel-header">
        <h2>
          按键模拟 <span className="sub">@{selectedContext.name}</span>
        </h2>
        <div className="sim-tabs">
          <button className={mode === 'instant' ? 'sim-tab active' : 'sim-tab'} onClick={() => setMode('instant')}>
            即时模拟
          </button>
          <button className={mode === 'replay' ? 'sim-tab active' : 'sim-tab'} onClick={() => setMode('replay')}>
            时序回放
          </button>
        </div>
      </div>

      {mode === 'replay' ? (
        <TimelineReplay selectedContext={selectedContext} review={review} />
      ) : (
        <>
          <div
            ref={recorderRef}
            tabIndex={0}
            className={`recorder ${armed ? 'armed' : ''} status-${status}`}
            onFocus={() => setArmed(true)}
            onBlur={() => setArmed(false)}
          >
            <div className="buffer">
              {buffer.length === 0 && (
                <span className="buffer-empty">{armed ? '开始按键…' : '点击此处获取键盘焦点'}</span>
              )}
              {buffer.map((t, i) => (
                <React.Fragment key={i}>
                  <kbd className="press">{t}</kbd>
                  {i < buffer.length - 1 && <span className="press-sep">→</span>}
                </React.Fragment>
              ))}
            </div>
            <div className={`sim-status ${meta.cls}`}>
              <span className="status-dot" />
              {meta.text}
            </div>
            <p className="hint small">
              单按 Esc 清空 · Backspace 回退 · 支持组合键（Ctrl+K）· 序列最多 3 次按键
            </p>
          </div>

          {error && <p className="error">⚠ {error}</p>}

          {result && status === 'triggered' && (
            <div className="sim-section">
              <h4>✅ 已触发命令</h4>
              <ul className="trigger-list">
                {result.triggered.map((t) => (
                  <li key={t.commandId}>
                    <strong>{t.name}</strong>
                    <span className="party-source">来源：{t.contextPath}</span>
                    <span className="party-trigger">
                      序列：<kbd>{t.sequenceLabel}</kbd>
                    </span>
                    {t.duplicate && <span className="badge duplicate">同层重复，多个命令同时触发</span>}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {result && (status === 'waiting' || (status === 'triggered' && result.candidates.length > 0)) && (
            <div className="sim-section">
              <h4>
                {status === 'waiting' ? '⏳ 候选命令（继续按键以消歧）' : 'ℹ 同时存在以当前序列为前缀的更长绑定'}
              </h4>
              <ul className="candidate-list">
                {result.candidates.map((c) => (
                  <li key={c.sequenceTokens.join('')}>
                    <kbd className="seq">{c.sequenceLabel}</kbd>
                    <span className="candidate-cmds">
                      {c.commands.map((cmd) => (
                        <span key={cmd.commandId} className="candidate-cmd">
                          {cmd.name}
                          <span className="party-source">（{cmd.contextPath}）</span>
                        </span>
                      ))}
                    </span>
                    <span className="remaining">还差 {c.remaining} 键</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {result && status === 'no-match' && (
            <div className="sim-section">
              <h4>❌ 无匹配</h4>
              <p className="hint">
                当前缓冲 <kbd>{result.bufferLabel}</kbd> 既未精确命中，也不是任何生效序列的前缀。
              </p>
            </div>
          )}
        </>
      )}
    </div>
  );
}
