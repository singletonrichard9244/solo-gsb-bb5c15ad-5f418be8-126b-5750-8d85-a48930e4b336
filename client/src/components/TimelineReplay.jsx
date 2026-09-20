import React, { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import { eventToToken, prettyToken } from '../keymap';

const DEFAULT_TIMEOUT = 800;

const STATUS_META = {
  idle: { text: '空闲', cls: 'idle' },
  pending: { text: '待定（等续键/超时）', cls: 'pending' },
  waiting: { text: '等待后续按键', cls: 'waiting' },
  triggered: { text: '命令已触发', cls: 'triggered' },
  timeout: { text: '超时触发短序列', cls: 'timeout' },
  'no-match': { text: '无匹配，重新起算', cls: 'nomatch' },
};

/** 从审校生效绑定中找一对“短序列 + 其延伸序列”，用于生成示例 */
function findPrefixPair(review) {
  const groups = review?.effectiveGroups || [];
  for (const short of groups) {
    const longer = groups.find((g) => g.tokens.length > short.tokens.length &&
      short.tokens.every((t, i) => g.tokens[i] === t));
    if (longer) return { short, longer };
  }
  return null;
}

export default function TimelineReplay({ selectedContext, review }) {
  const [timeoutMs, setTimeoutMs] = useState(DEFAULT_TIMEOUT);
  const [presses, setPresses] = useState([]); // [{ token, timeMs, timeoutMs }]
  const [recording, setRecording] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const [playing, setPlaying] = useState(false);
  const [visibleCount, setVisibleCount] = useState(0);
  const recorderRef = useRef(null);
  const recordStartRef = useRef(0);
  const timersRef = useRef([]);
  const fileRef = useRef(null);

  const clearTimers = () => {
    timersRef.current.forEach((t) => clearTimeout(t));
    timersRef.current = [];
  };

  // 切换上下文：重置全部
  useEffect(() => {
    setPresses([]);
    setResult(null);
    setError('');
    setRecording(false);
    setPlaying(false);
    setVisibleCount(0);
    clearTimers();
  }, [selectedContext?.id]);

  useEffect(() => clearTimers, []);

  const runReplay = async (nextPresses = presses, nextTimeout = timeoutMs) => {
    if (nextPresses.length === 0) {
      setResult(null);
      return;
    }
    try {
      const r = await api.replay(selectedContext.id, {
        timeoutMs: Number(nextTimeout),
        presses: nextPresses.map((p) => ({ token: p.token, timeMs: p.timeMs, timeoutMs: p.timeoutMs })),
      });
      setResult(r);
      setVisibleCount(r.events.length); // 默认直接展示全部
      setError('');
      return r;
    } catch (err) {
      setError(err.message);
      return null;
    }
  };

  // ---------- 录制 ----------
  useEffect(() => {
    if (!recording) return undefined;
    const onKeyDown = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        setRecording(false);
        return;
      }
      if (e.key === 'Backspace') {
        e.preventDefault();
        setPresses((prev) => prev.slice(0, -1));
        return;
      }
      e.preventDefault();
      const token = eventToToken(e);
      if (!token) return;
      const at = Math.max(0, Math.round(performance.now() - recordStartRef.current));
      setPresses((prev) => {
        // 防止 timeMs 倒退（浏览器事件时间戳抖动）
        const lastT = prev.length ? prev[prev.length - 1].timeMs : 0;
        const timeMs = Math.max(at, lastT);
        return [...prev, { token, timeMs, timeoutMs: Number(timeoutMs) }];
      });
    };
    const node = recorderRef.current;
    node?.addEventListener('keydown', onKeyDown);
    return () => node?.removeEventListener('keydown', onKeyDown);
  });

  const startRecording = () => {
    setPresses([]);
    setResult(null);
    setPlaying(false);
    clearTimers();
    recordStartRef.current = performance.now();
    setRecording(true);
    setTimeout(() => recorderRef.current?.focus(), 0);
  };

  const updatePress = (idx, patch) => {
    setPresses((prev) => prev.map((p, i) => (i === idx ? { ...p, ...patch } : p)));
  };

  // ---------- 按时间线动画播放 ----------
  const playTimeline = async () => {
    const r = await runReplay();
    if (!r) return;
    setPlaying(true);
    setVisibleCount(0);
    clearTimers();
    r.events.forEach((ev, i) => {
      const t = setTimeout(() => setVisibleCount(i + 1), ev.timeMs);
      timersRef.current.push(t);
    });
    const end = setTimeout(() => setPlaying(false), r.durationMs + 120);
    timersRef.current.push(end);
  };

  const stopPlay = () => {
    clearTimers();
    setPlaying(false);
    if (result) setVisibleCount(result.events.length);
  };

  // ---------- 导入 / 导出 ----------
  const buildExport = () => ({
    format: 'shortcut-replay-v1',
    exportedAt: new Date().toISOString(),
    contextId: selectedContext.id,
    contextPath: selectedContext.name,
    timeoutMs: Number(timeoutMs),
    presses: presses.map((p) => ({ token: p.token, timeMs: p.timeMs, timeoutMs: p.timeoutMs })),
  });

  const exportJson = () => {
    if (presses.length === 0) return;
    const blob = new Blob([JSON.stringify(buildExport(), null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `key-replay-${selectedContext.id}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const importJson = (file) => {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(String(reader.result));
        const list = Array.isArray(data?.presses) ? data.presses : null;
        if (!list || list.length === 0) throw new Error('文件中没有 presses 按键数组');
        const next = list.map((p, i) => {
          const token = typeof p === 'string' ? p : p.token || p.press;
          const timeMs = Number(typeof p === 'object' ? p.timeMs : i * DEFAULT_TIMEOUT);
          const perTimeout = typeof p === 'object' && Number.isFinite(Number(p.timeoutMs))
            ? Number(p.timeoutMs)
            : Number.isFinite(Number(data.timeoutMs))
              ? Number(data.timeoutMs)
              : DEFAULT_TIMEOUT;
          if (!token || typeof token !== 'string') throw new Error(`第 ${i + 1} 次按键缺少 token`);
          if (!Number.isFinite(timeMs) || timeMs < 0) throw new Error(`第 ${i + 1} 次按键 timeMs 非法`);
          return { token: token.toLowerCase(), timeMs, timeoutMs: perTimeout };
        });
        for (let i = 1; i < next.length; i++) {
          if (next[i].timeMs < next[i - 1].timeMs) throw new Error(`第 ${i + 1} 次按键时间早于上一次`);
        }
        if (data.contextId && data.contextId !== selectedContext.id) {
          setError(`提示：文件录制于上下文「${data.contextPath || data.contextId}」，已按当前上下文「${selectedContext.name}」回放`);
        } else {
          setError('');
        }
        if (Number.isFinite(Number(data.timeoutMs))) setTimeoutMs(Number(data.timeoutMs));
        setPresses(next);
        setResult(null);
        setVisibleCount(0);
      } catch (err) {
        setError(`导入失败：${err.message}`);
      }
    };
    reader.readAsText(file);
  };

  // ---------- 示例 ----------
  const pair = useMemo(() => findPrefixPair(review), [review]);

  const loadSample = (within) => {
    if (!pair) {
      setError('当前上下文没有“短序列是长序列前缀”的生效绑定，无法生成示例');
      return;
    }
    const { short, longer } = pair;
    const gap = within ? Math.round(Number(timeoutMs) / 2) : Number(timeoutMs) + 200;
    const next = [
      { token: short.tokens[0], timeMs: 0, timeoutMs: Number(timeoutMs) },
      { token: longer.tokens[1], timeMs: gap, timeoutMs: Number(timeoutMs) },
    ];
    if (longer.tokens.length > 2) {
      next.push({ token: longer.tokens[2], timeMs: gap * 2, timeoutMs: Number(timeoutMs) });
    }
    setError('');
    setPresses(within ? next : next.slice(0, 2));
    setResult(null);
  };

  const visibleEvents = result ? result.events.slice(0, visibleCount) : [];

  return (
    <div className="replay">
      {/* 阈值配置 */}
      <div className="replay-config">
        <label className="replay-timeout">
          默认超时阈值
          <input
            type="number"
            min="0"
            step="50"
            value={timeoutMs}
            onChange={(e) => setTimeoutMs(Math.max(0, Number(e.target.value) || 0))}
          />
          ms
        </label>
        <span className="hint small">短序列命中且为长序列前缀时：阈值内续键走长序列，超时触发短序列</span>
      </div>

      {/* 录制区 */}
      <div ref={recorderRef} tabIndex={0} className={`recorder replay-recorder ${recording ? 'armed' : ''}`}>
        {recording ? (
          <>
            <div className="buffer">
              <span className="buffer-empty">
                ● 录制中… 已录 {presses.length} 键 · Esc 结束 · Backspace 删除末键
              </span>
            </div>
            <p className="hint small">每次按键自动记录相对毫秒与当前阈值</p>
          </>
        ) : (
          <div className="buffer">
            <span className="buffer-empty">点击「开始录制」后在此按键，或在下方表格直接编辑时间</span>
          </div>
        )}
      </div>

      {/* 操作按钮 */}
      <div className="replay-actions">
        {!recording ? (
          <button className="primary" onClick={startRecording}>
            ● 开始录制
          </button>
        ) : (
          <button className="danger" onClick={() => setRecording(false)}>
            ■ 结束录制
          </button>
        )}
        <button onClick={() => runReplay()} disabled={presses.length === 0 || playing}>
          ▶ 回放（直接出结果）
        </button>
        <button onClick={playTimeline} disabled={presses.length === 0 || playing}>
          ⏱ 按时间线播放
        </button>
        {playing && <button onClick={stopPlay}>⏹ 停止</button>}
        <button onClick={exportJson} disabled={presses.length === 0}>
          ⇩ 导出 JSON
        </button>
        <button onClick={() => fileRef.current?.click()}>⇧ 导入 JSON</button>
        <input
          ref={fileRef}
          type="file"
          accept="application/json,.json"
          style={{ display: 'none' }}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) importJson(f);
            e.target.value = '';
          }}
        />
        <button onClick={() => loadSample(true)} disabled={!pair} title="短序列+阈值内续键 => 长序列">
          示例：阈值内续键
        </button>
        <button onClick={() => loadSample(false)} disabled={!pair} title="短序列+超时后续键 => 超时触发短序列">
          示例：超时
        </button>
        <button
          className="danger"
          onClick={() => {
            setPresses([]);
            setResult(null);
            setError('');
            setVisibleCount(0);
          }}
          disabled={presses.length === 0}
        >
          清空
        </button>
      </div>

      {error && <p className="error">⚠ {error}</p>}

      {/* 录制的按键表 */}
      {presses.length > 0 && (
        <div className="sim-section">
          <h4>按键时间线（{presses.length} 键）</h4>
          <table className="replay-table">
            <thead>
              <tr>
                <th>#</th>
                <th>按键</th>
                <th>相对时间 (ms)</th>
                <th>该键阈值 (ms)</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {presses.map((p, i) => (
                <tr key={i}>
                  <td>{i + 1}</td>
                  <td>
                    <kbd className="press">{prettyToken(p.token)}</kbd>
                  </td>
                  <td>
                    <input
                      type="number"
                      min="0"
                      value={p.timeMs}
                      onChange={(e) => updatePress(i, { timeMs: Math.max(0, Number(e.target.value) || 0) })}
                    />
                  </td>
                  <td>
                    <input
                      type="number"
                      min="0"
                      value={p.timeoutMs}
                      onChange={(e) => updatePress(i, { timeoutMs: Math.max(0, Number(e.target.value) || 0) })}
                    />
                  </td>
                  <td>
                    <button
                      className="link-danger"
                      onClick={() => setPresses((prev) => prev.filter((_, j) => j !== i))}
                    >
                      删除
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* 逐事件结果 */}
      {result && (
        <div className="sim-section">
          <h4>
            逐事件状态（{visibleEvents.length}/{result.events.length}）· 时间线长 {result.durationMs}ms · 触发{' '}
            {result.firedCount} 次
          </h4>
          <table className="replay-table timeline-table">
            <thead>
              <tr>
                <th>事件</th>
                <th>时刻</th>
                <th>间隔</th>
                <th>输入/缓冲</th>
                <th>状态</th>
                <th>说明</th>
              </tr>
            </thead>
            <tbody>
              {visibleEvents.map((ev) => {
                const meta = STATUS_META[ev.status] || STATUS_META.idle;
                return (
                  <tr key={ev.seq} className={`timeline-row row-${ev.status}`}>
                    <td>#{ev.seq}</td>
                    <td className="num">{ev.timeMs}ms</td>
                    <td className="num">{ev.deltaMs}ms</td>
                    <td>
                      {ev.type === 'timeout' ? (
                        <span className="timeout-tag">⏰ 超时</span>
                      ) : (
                        <kbd className="press">{ev.pretty || prettyToken(ev.token)}</kbd>
                      )}
                      {ev.bufferLabel && (
                        <span className="buffer-label">
                          缓冲 <kbd>{ev.bufferLabel}</kbd>
                        </span>
                      )}
                      {ev.restartFrom && <span className="restart-tag">↻ 重新起算</span>}
                    </td>
                    <td>
                      <span className={`evt-badge ${meta.cls}`}>{meta.text}</span>
                    </td>
                    <td className="note-cell">
                      {ev.note}
                      {ev.triggered.length > 0 && (
                        <span className="fired-cmds">
                          {ev.triggered.map((c) => (
                            <span key={c.commandId} className="fired-cmd" title={c.contextPath}>
                              ⚡{c.name}
                              {c.duplicate && <em>（同层重复）</em>}
                            </span>
                          ))}
                        </span>
                      )}
                      {ev.held.length > 0 && ev.status === 'pending' && (
                        <span className="held-cmds">
                          待定：
                          {ev.held.map((c) => c.name).join('、')}
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          {/* 最终触发命令汇总 */}
          <div className="replay-summary">
            <h4>最终触发命令与时间点</h4>
            {result.fired.length === 0 ? (
              <p className="hint">整条时间线没有触发任何命令。</p>
            ) : (
              <ul className="trigger-list">
                {result.fired.map((f, i) =>
                  f.commands.map((c) => (
                    <li key={`${i}-${c.commandId}`}>
                      <span className="fired-at">@{f.atMs}ms</span>
                      <strong>{c.name}</strong>
                      <span className="party-source">
                        {f.eventType === 'timeout' ? '超时触发' : '按键触发'} · 来源：{c.contextPath}
                      </span>
                      <span className="party-trigger">
                        序列：<kbd>{c.sequenceLabel}</kbd>
                      </span>
                      {c.duplicate && <span className="badge duplicate">同层重复</span>}
                    </li>
                  )),
                )}
              </ul>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
