const path = require('node:path');
const fs = require('node:fs');
const express = require('express');
const cors = require('cors');
const store = require('./store');
const {
  computeEffective,
  evaluateKey,
  canonicalPress,
  generateRegressionSuite,
  previewSandbox,
  replayTimeline,
  resolveConflicts,
} = require('./engine');

const app = express();
app.use(cors());
app.use(express.json());

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ---- 全量状态 ----
app.get('/api/state', (req, res) => {
  res.json(store.snapshot());
});

// ---- 上下文树 ----
app.post(
  '/api/contexts',
  wrap(async (req, res) => {
    const ctx = await store.createContext(req.body || {});
    res.status(201).json(ctx);
  }),
);
app.put(
  '/api/contexts/:id',
  wrap(async (req, res) => {
    res.json(await store.updateContext(req.params.id, req.body || {}));
  }),
);
app.delete(
  '/api/contexts/:id',
  wrap(async (req, res) => {
    res.json(await store.deleteContext(req.params.id));
  }),
);

// ---- 命令 ----
app.post(
  '/api/commands',
  wrap(async (req, res) => {
    const cmd = await store.createCommand(req.body || {});
    res.status(201).json(cmd);
  }),
);
app.put(
  '/api/commands/:id',
  wrap(async (req, res) => {
    res.json(await store.updateCommand(req.params.id, req.body || {}));
  }),
);
app.delete(
  '/api/commands/:id',
  wrap(async (req, res) => {
    res.json(await store.deleteCommand(req.params.id));
  }),
);

// ---- 审校：最近祖先生效绑定 + 冲突 ----
app.get('/api/review/:contextId', (req, res, next) => {
  try {
    res.json(computeEffective(store.snapshot(), req.params.contextId));
  } catch (err) {
    next(err);
  }
});

// ---- 逐键模拟 ----
// POST body: { buffer: ["ctrl+k", "x"] } 或 { presses: "g l" }
app.post(
  '/api/simulate/:contextId',
  wrap((req, res) => {
    const { buffer, presses } = req.body || {};
    let tokens = Array.isArray(buffer) ? buffer : null;
    if (tokens === null && typeof presses === 'string' && presses.trim()) {
      tokens = presses
        .split(/[\s,]+/)
        .filter(Boolean)
        .map((p) => {
          const r = canonicalPress(p);
          if (!r.ok) throw Object.assign(new Error(r.error), { status: 400 });
          return r.token;
        });
    }
    if (!Array.isArray(tokens)) {
      throw Object.assign(new Error('请提供 buffer（按键 token 数组）或 presses（按键串）'), { status: 400 });
    }
    res.json(evaluateKey(store.snapshot(), req.params.contextId, tokens));
  }),
);

// ---- 时序回放（带相对毫秒与超时阈值的按键时间线，只读复用生效绑定判定） ----
// POST body:
//   { timeoutMs?: 800,
//     presses: [{ token: "g", timeMs: 0, timeoutMs?: 800 }, ...] }
//   也接受 presses: ["g", ...]（无时间戳时按顺序以 0ms 处理，仅用于快速校验）
app.post(
  '/api/replay/:contextId',
  wrap((req, res) => {
    const result = replayTimeline(store.snapshot(), req.params.contextId, req.body || {}, {
      timeoutMs: (req.body || {}).timeoutMs,
    });
    if (req.query.download !== undefined) {
      res.setHeader('Content-Disposition', 'attachment; filename="key-replay-result.json"');
    }
    res.json(result);
  }),
);

// ---- 回归套件生成（叶子候选 + 精确集合覆盖，只读复用现有生效规则） ----
app.get('/api/regression-suite', (req, res, next) => {
  try {
    const suite = generateRegressionSuite(store.snapshot());
    if (req.query.download !== undefined) {
      res.setHeader('Content-Disposition', 'attachment; filename="regression-suite.json"');
    }
    res.json(suite);
  } catch (err) {
    next(err);
  }
});

// ---- 变更沙盒预演（只读：在内存副本上应用草案并对比基线，绝不写回数据文件） ----
// POST body 即草案：{ adds: [{draftId?, contextId, name, sequence, description?}],
//                     updates: [{commandId, sequence}], deletes: [commandId, ...] }
app.post(
  '/api/sandbox/preview',
  wrap((req, res) => {
    const result = previewSandbox(store.snapshot(), req.body || {});
    if (req.query.download !== undefined) {
      res.setHeader('Content-Disposition', 'attachment; filename="sandbox-preview.json"');
    }
    res.json(result);
  }),
);

// ---- 冲突消解（只读：搜索仅改动当前上下文命令的无冲突改键方案，绝不写回数据文件） ----
// POST body:
//   { candidates?: ["w", "ctrl+alt+l", ...],   // 候选序列池
//     lockedCommandIds?: ["cmd-1", ...],        // 锁定（不得修改）的命令
//     maxChanges?: 3 }                          // 最多改动命令数，缺省不限
app.post(
  '/api/conflicts/resolve/:contextId',
  wrap((req, res) => {
    const result = resolveConflicts(store.snapshot(), req.params.contextId, req.body || {});
    if (req.query.download !== undefined) {
      res.setHeader('Content-Disposition', 'attachment; filename="conflict-resolution.json"');
    }
    res.json(result);
  }),
);

// ---- 错误处理 ----
app.use('/api', (err, req, res, next) => {
  res.status(err.status || 500).json({ error: err.message || '服务器内部错误' });
});

// ---- 生产环境托管前端构建产物 ----
const clientDist = path.join(__dirname, '..', '..', 'client', 'dist');
if (fs.existsSync(clientDist)) {
  app.use(express.static(clientDist));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/')) return next();
    res.sendFile(path.join(clientDist, 'index.html'));
  });
}

const PORT = Number(process.env.PORT) || 3000;

store.init().then((mode) => {
  app.listen(PORT, () => {
    console.log(`[shortcut-console] 数据初始化：${mode}`);
    console.log(`[shortcut-console] 服务已启动: http://localhost:${PORT}`);
  });
});
