# ⌨ 上下文快捷键审校台（Node.js + React）

为命令式快捷键体系提供的可视化审校工具：建立**上下文树**，为命令指定所属上下文与由 **1～3 次按键**组成的序列；选择任一上下文后，系统按**最近祖先规则**构建生效绑定，自动标出**同层重复**与**前缀冲突**，并提供**逐键模拟器**实时查看候选、触发与等待状态。模拟器内含**时序回放**：录制带相对毫秒与可配置超时阈值的按键时间线，短序列既是精确命中又是长序列前缀时先进入待定，阈值内续键触发长序列、超时触发短序列，无匹配则从当前按键重新起算不吞键，并支持 JSON 导入/导出。此外可一键**生成回归测试套件**：以全部叶子上下文为候选，用精确集合覆盖选出叶子数量最少的测试上下文集合。新增的**变更沙盒**支持把命令的新增、改序列、删除先暂存为浏览器本地草案，后端在同一份草案上预演基线与模拟状态，按上下文汇总各项差异，改动确认前不触碰任何真实数据；预演响应携带**基线版本指纹**，确认无新增冲突后可**发布草案**：后端在单次写临界区内重新核对指纹、复用草案校验并原子写入，数据已变化则拒绝发布并返回当前版本与失效操作，绝不部分落盘。审校页的**冲突消解**面板可针对当前上下文的生效 duplicate/prefix 冲突自动搜索改键方案：锁定不可改命令、提供候选序列池与改动上限后，后端仅改动当前上下文定义的命令，复用生效规则精确求解，依次最小化改动命令数、总按键数与方案字典序；无解时逐个列出无法消除的冲突与原因，有解时一键把全部改键写入沙盒草案继续预演。

## 一条命令启动（Docker Compose）

```bash
docker compose up --build -d
```

然后浏览器访问：

> **http://localhost:3000**

端口：主机 `3000` → 容器 `3000`（可在 `docker-compose.yml` 的 `ports` 中修改左侧端口）。
停止：`docker compose down`；数据保存在命名卷 `shortcut-data` 中，重建容器不丢失。

> 镜像启动时自动完成数据初始化：首次运行若数据文件不存在，会写入一套包含覆盖、同层重复、前缀冲突等场景的演示数据（`server/src/seed.js`）。

---

## 本地开发（无 Docker）

要求 Node.js ≥ 18。

```bash
npm install          # 安装全部依赖（npm workspaces：server / client）
npm run dev          # 并行启动后端(3000) 与 Vite 前端(5173)
```

访问 **http://localhost:5173**（Vite 已把 `/api` 代理到后端 3000）。

其他命令：

```bash
npm run build        # 构建前端到 client/dist
npm start            # 仅启动后端；若已 build，则由后端在 3000 端口托管前端
npm run test:engine  # 运行引擎单测（最近祖先 / 覆盖 / 重复 / 前缀 / 逐键模拟 / 回归套件 / 沙盒预演 / 沙盒发布核算 / 冲突消解）
npm run test:api     # 运行发布接口测试（指纹核对 / 冲突门禁 / 原子落盘 / 并发发布）
npm test             # 以上全部
```

## 数据模型

| 实体 | 字段 |
|---|---|
| 上下文 Context | `id`, `parentId`（可空，支持森林）, `name`, `description` |
| 命令 Command | `id`, `contextId`（定义位置）, `name`, `sequenceTokens`（1~3 次按键）, `description` |

序列输入用**空格或逗号**分隔，每次按键支持组合键（修饰键 `Ctrl/Alt/Shift/Meta` + 一个主键），例如：

- `g l`（2 次按键）
- `Ctrl+Shift+P`（1 次按键）
- `Ctrl+K, x`（2 次按键，第 1 次为组合键）

## 审校规则

选定上下文后，沿其祖先链（自身 → 父 → … → 根）收集绑定：

1. **最近祖先生效，子级覆盖祖先**：同一序列若在链上多层定义，最靠近所选上下文的一层生效；祖先层的同序列绑定显示为「已覆盖（shadowed）」，不参与触发与冲突判定。
2. **同层序列重复 = 冲突（duplicate）**：同一上下文中多条命令使用完全相同的序列，双方（全部）都保留并会在按键时**同时触发**，列表标记「同层重复」，冲突卡片列出每一方的**来源上下文路径**与**最短触发输入**。
3. **前缀冲突（prefix）**：生效序列中若 `A` 是 `B` 的严格前缀（如 `G` 与 `G D`，允许跨层），双方分别标记「他序列前缀 / 前缀延伸」，冲突卡片同时展示双方来源与各自最短触发输入。
4. 兄弟上下文的绑定互不可见。

## 逐键模拟器

在右下录制区点击获取键盘焦点后直接按键（支持单键与组合键，单按修饰键不计入）：

- **Esc** 清空缓冲，**Backspace** 回退一个按键；
- `triggered`（绿）：缓冲精确命中，展示已触发命令（重复时列出全部）；若它同时是更长序列前缀，附候选提示；
- `waiting`（黄）：缓冲是一个或多个生效序列的前缀，列出候选命令、来源与「还差 N 键」；
- `no-match`（红）：既未精确命中也不是任何序列前缀；
- `idle`：尚未输入。

### 时序回放（带超时的时间线）

模拟器顶部切换到「时序回放」页签。每次按键都会记录**相对首键的毫秒时间戳**与该键生效的**超时阈值**（页面顶部配置默认阈值，表格中可逐键覆盖）：

1. **录制 / 编辑**：点「开始录制」后按键即自动计时（Esc 结束、Backspace 删末键）；也可直接在按键表中改每个键的相对时间与阈值。
2. **待定判定**：某一键精确命中短序列、且短序列同时是更长生效序列的严格前缀时进入 **pending（待定，紫）**，不立即触发：
   - **阈值内续键**且续键匹配长序列：沿前缀链继续（仍为更长链前缀时保持待定，截止时刻以最新按键重置），补全长序列即 **triggered**；
   - **超过该键阈值仍未有效续键**：在截止时刻自动补发一个 `timeout` 事件，**触发待定的短序列**（同层重复时全部触发）；
   - 续键偏离长序列：放弃待定短序列，**从当前按键重新起算**——当前键自身命中/为前缀则立即按新序列判定，不吞掉该键。
3. **无匹配重新起算**：缓冲既不命中也不是前缀时标记 `no-match` 并丢弃；下一次按键作为全新序列起点（行内标「↻ 重新起算」），保证任何按键都不会被静默吞掉。
4. **回放与展示**：「回放」直接给出全部逐事件状态；「按时间线播放」按事件时刻逐条揭示。事件表给出每次按键/超时的**时刻、距上事件间隔、输入、缓冲、状态与说明**，底部汇总**最终触发命令与各自触发时间点**。
5. **JSON 导入 / 导出**：导出录制定义（`shortcut-replay-v1`，含 `contextId / timeoutMs / presses[{token,timeMs,timeoutMs}]`）；导入时校验时间单调不减，若文件录制于其他上下文则按当前上下文回放并提示。也可用「示例：阈值内续键 / 示例：超时」一键填充当前上下文的前缀冲突序列。

> 时序回放是**只读**能力：判定完全复用与即时模拟相同的 `computeEffective` 生效绑定规则（最近祖先 / shadowed / duplicate / prefix），不改变任何数据。即时模拟页签、`POST /api/simulate` 与 Docker Compose 启动方式均保持不变。

## 冲突消解（改键方案）

审校页右栏「🔀 冲突消解」面板针对**当前上下文生效的 duplicate / prefix 冲突**自动生成改键方案（只读搜索，不写数据）：

1. **可改动范围**：后端**只允许修改定义在当前上下文的命令**；祖先上下文的命令本就不可修改（面板中不会出现）。当前上下文命令可逐条**锁定**（保持原序列），冲突参与方带「冲突方」标记。
2. **候选序列池**：每行或逗号分隔输入一个 1~3 键序列（如 `w`、`ctrl+alt+l`）；面板默认填入当前生效序列未占用的首字母（它们不可能与任何生效序列重复或互为前缀）。每条可改命令的新序列只能取自候选池，保持原序列不算改动。
3. **最多改动数**：限制方案包含的改键命令条数，留空表示不限。
4. **求解与优化**：复用 `computeEffective` 的生效规则（最近祖先 / shadowed / duplicate / prefix），分支限界 + MRV 精确搜索无冲突方案（冲突数为 0、且不引入任何新冲突；当前命令可通过**精确同序列覆盖 shadow 祖先组**消解跨层冲突），依次最小化 **① 改动命令数 → ② 新序列总按键数 → ③ 方案字典序**（改动按命令 id 排序后逐条比较新序列），结果与数据顺序无关。参数变化后防抖自动重算，也可手动「生成改键方案」。
5. **有解**：展示改动命令数 / 总按键数 / 剩余冲突，以及每条改动的**命令（来源上下文）、改前序列、改后序列、该改动消除的冲突目标**；可下载方案 JSON。点击「🛠 全部写入变更沙盒并预演」会把所有改序列合并进现有沙盒草案（同一命令覆盖旧的改序列、并移除其删除操作，原有新增与其它操作保留）并跳转到沙盒页继续预演——仍不触碰服务器数据。
6. **无解**：逐个列出无法消除的冲突、参与命令（标注「祖先命令·不可改 / 已锁定」）与原因，共四类：
   - `immutable`：参与命令均不可修改（已锁定或在祖先上下文），或即使提供充足安全序列仍存在结构上不可消除的前缀关系（例如把当前命令移走会暴露祖先命令之间相同的前缀冲突；同时 shadow 前缀双方又必然形成新的前缀对）；
   - `pool`：候选池中没有任何能避开全部生效序列（含严格前缀）的空位，给出最少改动数并提示扩池；
   - `budget`：仅消解该冲突所需的最少改动数已超过「最多改动数」；
   - `entailed` / `combined`：各冲突单独都能消解，但在当前锁定 / 候选池 / 改动上限的联合约束下无冲突空位相互竞争，不存在同时消解全部冲突的方案。

> 该能力完全只读：所有判定都在内存副本上复用与审校页相同的生效规则；`POST /api/conflicts/resolve/:contextId` 不修改数据文件，Docker Compose 启动方式不变。

## 回归套件生成

顶部切换到「🧪 回归套件生成」页（只读，不改动任何审校/模拟逻辑）：

1. **候选**：上下文树中的全部**叶子上下文**；对每个叶子直接复用 `computeEffective` 的生效规则（最近祖先 / 覆盖 / 同层重复 / 前缀冲突）。
2. **测试目标**：
   - 每条可在**至少一个叶子**触发的命令（shadowed 的绑定不计）；
   - 每个可在某个叶子观察到的**同层重复（duplicate）**或**前缀冲突（prefix）**；冲突以**参与命令集合**判定身份——不同叶子下命令集合相同的冲突视为同一个目标。
3. **选套件**：用**精确集合覆盖**（分支限界，MRV 选目标）选出覆盖全部目标所需**叶子数量最少**的组合；存在多个同解时，按入选上下文路径排序后的**字典序**稳定选择（与数据 id/加载顺序无关）。
4. 每个入选上下文给出一张测试用例：
   - **需输入的序列**：该叶子下全部生效序列；
   - **预期触发命令集合**：精确输入该序列时应同时触发的命令（含来源路径，同层重复时为多条）；
   - **预期冲突类型**：该叶子下的 duplicate / prefix 冲突清单（双方来源与最短触发输入）。
5. **不可触发命令**：任何叶子都无法触发的命令（典型原因：其序列在子树的**每个叶子**都被更近祖先的同序列绑定覆盖 shadowed）单列在警告区并给出原因与覆盖位置，**不计入覆盖目标**；页面覆盖率只统计「可触发命令 + 冲突目标」。

页面顶部展示覆盖统计（叶子数、入选数、已覆盖/可触发命令、不可触发命令、两类冲突数、目标覆盖率、输入序列总数），可一键**下载 JSON**（与 `GET /api/regression-suite` 返回内容一致）。

## 变更沙盒（草案预演）

顶部切换到「🛠 变更沙盒」页，可以在**不改动真实数据**的前提下评估一批命令变更的影响：

1. **暂存草案**：基于当前状态批量暂存命令的**新增**、**改序列**、**删除**。草案只保存在浏览器
   `localStorage`（键 `shortcut-sandbox-draft-v1`）——**既不写入数据文件，也不影响审校页**；
   刷新或重开页面草案仍在，可逐条撤销或一键**清空草案**。若数据在别处被改动导致草案操作失效
   （目标命令/上下文已不存在），页面会提示并自动剔除。
2. **预演**：草案非空时自动调用 `POST /api/sandbox/preview`（也可手动重新预演）。后端在同一份草案上
   分别计算**基线**（当前状态）与**模拟状态**（应用草案后的内存副本，绝不写回），复用与审校页完全
   相同的生效规则，按上下文汇总以下各项的**新增 / 消失**：
   - **生效绑定**（以「命令 + 序列」配对：改序列表现为旧绑定消失、新绑定出现）；
   - **shadowed**（被更近祖先同序列绑定覆盖的条目）；
   - **duplicate / prefix 冲突**（以**参与命令集合**的稳定身份配对：参与集合与角色不变的冲突
     不计差异；集合变化则旧身份消失、新身份出现）；
   - **不可触发命令**（全局汇总：任何叶子都无法触发的命令，附原因）。
3. **差异展示**：每项差异都给出**来源路径**（定义所在上下文路径）与**最短触发输入**，草案引入的
   条目带有「草案新增 / 改序列 / 删除」标记；绿色 ＋ 表示新增、红色 − 表示消失。
4. **导出**：可一键**下载预演 JSON**（与 `POST /api/sandbox/preview` 返回内容一致）。
5. **发布**：预演响应携带**基线版本指纹**（`baselineFingerprint`，对规范化状态取 SHA-256）。
   仅当「当前草案已成功预演（预演结果与草案一一对应）且**不引入任何新增 duplicate/prefix 冲突**」时
   「🚀 发布草案」可用。发布调用 `POST /api/sandbox/publish`，后端在**单次写临界区**内：
   重新核对指纹 → 复用与预演完全一致的草案校验 → 再次确认无新增冲突 → 一次性原子写入
   （tmp + rename），**绝不部分落盘**。
   - **成功**：返回新增 / 改序列 / 删除数量与新版本指纹；页面自动**清空本地草案**、刷新审校状态并展示数量；
   - **数据已变化**（指纹不一致，`409 sandbox-stale`）：返回**当前版本指纹**与**失效操作清单**
     （目标命令/上下文已不存在的草案操作），不落盘；页面保留草案，可一键刷新数据、剔除失效操作后重新预演；
   - **草案非法**（`400`）或**引入新增冲突**（`409 sandbox-conflicts`，附冲突清单）：同样不落盘，草案保留。

预演结果完全确定：全部输出按稳定键排序，与数据文件中的顺序、草案操作的先后顺序无关。

## HTTP API

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/state` | 全量上下文树与命令 |
| POST/PUT/DELETE | `/api/contexts[/:id]` | 上下文增改删（删除级联后代与其命令，移动时防环） |
| POST/PUT/DELETE | `/api/commands[/:id]` | 命令增改删，服务端校验序列合法性（1~3 键、组合键合法） |
| GET | `/api/review/:contextId` | 生效绑定、祖先链、冲突清单、shadowed 绑定 |
| POST | `/api/simulate/:contextId` | 逐键模拟，body：`{"buffer":["g","d"]}` 或 `{"presses":"g d"}` |
| POST | `/api/replay/:contextId` | 时序回放（只读）：body 为带时间戳的按键时间线，返回逐事件状态、超时事件与最终触发命令及时间点；加 `?download=1` 返回附件响应头 |
| GET | `/api/regression-suite` | 回归套件（统计 + 入选用例 + 候选覆盖数 + 不可触发命令原因）；加 `?download=1` 返回 `Content-Disposition: attachment` 响应头 |
| POST | `/api/sandbox/preview` | 变更沙盒预演（只读，不写数据文件）：body 为草案，返回基线 vs 模拟状态的按上下文差异（含 `baselineFingerprint` 基线版本指纹）；加 `?download=1` 返回附件响应头 |
| POST | `/api/sandbox/publish` | 变更沙盒发布：body 为 `{ draft, fingerprint }`，在单次写临界区内核对指纹、复用草案校验并原子写入；数据已变化返回 `409 sandbox-stale`（当前指纹 + 失效操作），引入新增冲突返回 `409 sandbox-conflicts` |
| POST | `/api/conflicts/resolve/:contextId` | 冲突消解（只读）：仅改动当前上下文命令，按候选池/锁定/改动上限搜索无冲突改键方案；加 `?download=1` 返回附件响应头 |

`POST /api/sandbox/preview` 请求体（三类操作均可选，默认为空）：

```jsonc
{
  "adds":    [ { "draftId": "draft-x1", "contextId": "ctx-terminal", "name": "新命令", "sequence": "g w", "description": "" } ],
  "updates": [ { "commandId": "cmd-16", "sequence": "g l l" } ],   // 仅改序列
  "deletes": [ "cmd-10" ]                                          // 命令 id 数组
}
```

返回结构：

```jsonc
{
  "generatedAt": "…",
  "baselineFingerprint": "5f2c…（64 位十六进制）",   // 基线版本指纹：发布时需原样回传
  "draft": { "adds": 1, "updates": 1, "deletes": 1,
             "addedCommandIds": ["draft-x1"], "updatedCommandIds": ["cmd-16"], "deletedCommandIds": ["cmd-10"] },
  "stats": {
    "contextCount": 4, "changedContextCount": 2,
    "effectiveAppeared": 3, "effectiveDisappeared": 2,
    "shadowedAppeared": 0, "shadowedDisappeared": 1,
    "duplicateAppeared": 1, "duplicateDisappeared": 0,
    "prefixAppeared": 4, "prefixDisappeared": 4,
    "unreachableAppeared": 0, "unreachableDisappeared": 1,
    "totalChanges": 16
  },
  "contexts": [                      // 仅列出有变化的上下文，按路径排序
    {
      "contextId": "ctx-terminal",
      "contextPath": "App / Editor / Terminal",
      "changeCount": 8,
      "effective": { "appeared": [ /* 绑定条目 */ ], "disappeared": [] },
      "shadowed":  { "appeared": [], "disappeared": [] },
      "duplicate": { "appeared": [ /* 冲突条目 */ ], "disappeared": [] },
      "prefix":    { "appeared": [], "disappeared": [] }
    }
  ],
  "unreachable": { "appeared": [ /* 不可触发命令（含原因） */ ], "disappeared": [] }
}
```

- **绑定条目**：`commandId, name, contextPath（来源路径）, sequenceLabel, shortestLabel（最短触发输入）, state, draftOp（草案来源标记）`；
- **冲突条目**：与 `/api/review` 的 conflicts 结构一致，另附 `goalId`（参与命令集合的稳定身份），
  参与方按命令 id 排序并各带来源路径与最短触发输入。

草案非法（序列不合法、命令/上下文不存在、重复操作、改已删除命令等）时返回 `400` 与错误说明，不产生任何副作用。

`POST /api/sandbox/publish` 请求体（`fingerprint` 必须取自最近一次预演响应的 `baselineFingerprint`）：

```jsonc
{
  "draft": {
    "adds":    [ { "draftId": "draft-x1", "contextId": "ctx-terminal", "name": "新命令", "sequence": "g w" } ],
    "updates": [ { "commandId": "cmd-16", "sequence": "g l l" } ],
    "deletes": [ "cmd-10" ]
  },
  "fingerprint": "5f2c…（预演返回的 baselineFingerprint）"
}
```

发布成功（`200`）：

```jsonc
{
  "publishedAt": "…",
  "fingerprint": "a91e…",                 // 写入后的新版本指纹
  "counts": { "adds": 1, "updates": 1, "deletes": 1 },
  "addedCommands": [                      // 新增命令的草案临时 id → 正式 id 映射
    { "draftId": "draft-x1", "commandId": "cmd-7f3c…", "name": "新命令",
      "contextId": "ctx-terminal", "sequenceLabel": "G W" }
  ],
  "updatedCommandIds": ["cmd-16"],
  "deletedCommandIds": ["cmd-10"]
}
```

发布被拒（不落盘、不产生任何副作用）：

- `409` + `code: "sandbox-stale"`：指纹与当前数据不一致（预演后数据已被其它操作修改）。
  `details` 携带 `currentFingerprint`（当前版本指纹）与 `invalid`（失效的草案操作：
  `adds / updates / deletes` 各自的失效条目与原因）及 `invalidCount`；
- `409` + `code: "sandbox-conflicts"`：草案会引入新增 duplicate/prefix 冲突，
  `details.introducedConflicts` 列出冲突清单（结构与预演差异条目一致）；
- `400`：缺少指纹或草案非法（与预演同一套校验口径）。

`POST /api/conflicts/resolve/:contextId` 请求体（全部字段可选）：

```jsonc
{
  "candidates": ["w", "q", "ctrl+alt+l"],  // 候选序列池（1~3 键），缺省为空池
  "lockedCommandIds": ["cmd-15"],           // 锁定（不得修改）的命令；祖先命令无需锁定
  "maxChanges": 3                           // 最多改动命令数；缺省/ null 表示不限
}
```

返回结构（有解）：

```jsonc
{
  "format": "shortcut-conflict-resolution-v1",
  "generatedAt": "…",
  "contextId": "ctx-terminal",
  "contextPath": "App / Editor / Terminal",
  "solvable": true,
  "constraints": {
    "maxChanges": 3,
    "candidates": [{ "tokens": ["w"], "label": "W" }],
    "lockedCommandIds": ["cmd-15"],
    "movableCommandIds": ["cmd-16", "cmd-17"]
  },
  "stats": {
    "conflictCount": 3, "duplicateCount": 1, "prefixCount": 2,
    "definedHereCommandCount": 5, "lockedHereCommandCount": 1,
    "candidateCount": 3, "maxChanges": 3, "searchedNodes": 3386,
    "changedCommandCount": 3, "totalPresses": 3
  },
  "conflicts": [ /* 基线冲突，结构同 /api/review 的 conflicts，另附 goalId */ ],
  "changes": [
    {
      "commandId": "cmd-16", "name": "清屏",
      "contextId": "ctx-terminal", "contextPath": "App / Editor / Terminal",
      "fromTokens": ["g", "l"], "fromLabel": "G L",
      "toTokens": ["q"], "toLabel": "Q",
      "resolvesGoalIds": ["pre:cmd-15::cmd-16"]   // 该改动参与消除的冲突身份
    }
  ],
  "unresolved": [],
  // 可直接作为 POST /api/sandbox/preview 的草案（updates 部分）
  "draft": { "adds": [], "updates": [{ "commandId": "cmd-16", "sequence": "Q" }], "deletes": [] }
}
```

无解时 `solvable: false`、`changes: []`，`unresolved` 逐项给出无法消除的冲突：

```jsonc
{
  "goalId": "pre:cmd-1::cmd-2",
  "type": "prefix",                 // duplicate | prefix
  "kind": "immutable",              // immutable | pool | budget | entailed | combined
  "reason": "候选序列池中不存在能避开当前全部生效序列（含严格前缀关系）的空位……",
  "minChanges": 2,                  // 单独消解该冲突的最少改动数（budget/pool 时给出）
  "conflict": { /* 与 /api/review 的冲突结构一致，另附 goalId */ },
  "blockedCommands": [
    { "commandId": "cmd-1", "name": "…", "contextPath": "…", "sequenceLabel": "G",
      "role": "prefix", "definedHere": true, "locked": true }
  ]
}
```

候选序列非法、锁定命令不存在、`maxChanges` 为负等均返回 `400`；上下文不存在返回 `404`。该接口为纯只读计算。

`/api/regression-suite` 返回结构：

```jsonc
{
  "generatedAt": "…",
  "stats": {
    "leafCount": 2,                 // 叶子上下文总数
    "candidateCount": 2,            // 覆盖了至少一个目标的候选叶子数
    "selectedContextCount": 2,      // 套件入选叶子数（精确最小）
    "commandCount": 19,
    "triggerableCommandCount": 18,  // 至少在一个叶子可触发的命令
    "coveredCommandCount": 18,
    "unreachableCommandCount": 1,   // 任何叶子都无法触发（不计入覆盖）
    "duplicateConflictCount": 1,
    "prefixConflictCount": 5,
    "inputSequenceCount": 25,       // 套件用例输入序列总数
    "coverableGoalCount": 24,       // 可触发命令 + 冲突目标
    "coveredGoalCount": 24
  },
  "suite": [
    {
      "contextId": "ctx-code",
      "contextPath": "App / Editor / Code Editor",
      "inputs": [
        { "sequenceLabel": "G", "sequenceTokens": ["g"], "duplicate": false,
          "expectedCommands": [ { "commandId": "…", "name": "…", "contextPath": "…" } ] }
      ],
      "expectedConflicts": [ /* 与 /api/review 的 conflicts 结构一致 */ ],
      "coveredGoals": [ "cmd:…", "dup:…", "pre:…" ]
    }
  ],
  "candidates": [ { "contextId": "…", "contextPath": "…", "goalCount": 16, "selected": true } ],
  "unreachableCommands": [
    { "commandId": "…", "name": "…", "contextPath": "…", "sequenceLabel": "G",
      "reason": "序列「G」在所属上下文子树下的全部 2 个叶子上下文中均被更近祖先的同序列绑定覆盖…",
      "shadowedBy": [ { "contextId": "…", "contextPath": "…" } ] }
  ]
}
```

`POST /api/replay/:contextId` 请求体（前端「导出 JSON」的格式与此一致）：

```jsonc
{
  "timeoutMs": 800,                         // 默认超时阈值（毫秒）
  "presses": [
    { "token": "g", "timeMs": 0 },          // timeMs：相对时间线起点的毫秒
    { "token": "d", "timeMs": 500, "timeoutMs": 600 }  // 可逐键覆盖默认阈值
  ]
}
```

返回结构：

```jsonc
{
  "format": "shortcut-replay-v1",
  "contextId": "ctx-code",
  "contextPath": "App / Editor / Code Editor",
  "timeoutMs": 800,
  "pressCount": 2,
  "durationMs": 500,
  "firedCount": 1,
  "status": "idle",                         // 时间线结束态：idle / waiting / pending / no-match
  "events": [
    {
      "seq": 1, "type": "press", "timeMs": 0, "deltaMs": 0,
      "token": "g", "pretty": "G", "buffer": ["g"], "bufferLabel": "G", "timeoutMs": 800,
      "status": "pending",                  // idle | pending | waiting | triggered | timeout | no-match
      "note": "精确命中且为更长序列前缀，800ms 内续键触发长序列，超时触发短序列",
      "triggered": [],
      "held": [ { "commandId": "…", "name": "跳转定义…", "sequenceLabel": "G" } ], // 待定短序列
      "candidates": [ /* 更长前缀候选，结构同 /api/simulate */ ],
      "restartFrom": false
    },
    {
      "seq": 2, "type": "press", "timeMs": 500, "deltaMs": 500,
      "status": "triggered",
      "triggered": [ { "commandId": "…", "name": "跳到类型定义", "contextPath": "…", "sequenceLabel": "G D", "duplicate": false } ]
    }
  ],
  "fired": [ { "atMs": 500, "eventType": "press", "commands": [ /* 同 events[].triggered */ ] } ]
}
```

- 超时自动补发的事件 `type` 为 `"timeout"`，`timeMs` 为截止时刻（短序列末键时刻 + 该键阈值），`triggered` 为待定短序列（同层重复时多条）；
- 无匹配后重新起算的事件 `restartFrom: true`，并带 `discardedTokens / discardedLabel / droppedHeld`（被放弃的缓冲与待定命令）。
- 阈值为负、时间戳倒退、按键非法、presses 为空等均返回 `400`。

## 目录结构

```
.
├── Dockerfile                # 多阶段构建（构建前端 → 仅生产依赖运行）
├── docker-compose.yml        # 一条命令启动，端口 3000，命名卷持久化
├── server/
│   ├── src/
│   │   ├── index.js          # Express 入口、API（含沙盒预演/发布、冲突消解）、静态托管
│   │   ├── engine.js         # 核心规则：最近祖先/冲突/逐键模拟/回归套件（精确集合覆盖）/沙盒预演/发布核算（指纹+冲突门禁）/冲突消解（分支限界改键搜索）
│   │   ├── store.js          # JSON 文件持久化 + 校验 + 写临界区（串行化全部写操作，发布原子落盘）
│   │   └── seed.js           # 初始演示数据
│   └── test/
│       ├── engine.test.js        # 引擎单测
│       └── publish.api.test.js   # 发布接口测试（HTTP 级）
└── client/
    ├── src/
    │   ├── App.jsx
    │   ├── api.js
    │   ├── keymap.js          # 浏览器按键事件 -> 引擎 token
    │   ├── styles.css
    │   └── components/       # 上下文树 / 命令面板 / 绑定与冲突 / 冲突消解 / 逐键模拟（即时+时序回放） / 回归套件 / 变更沙盒（预演+发布）
    └── vite.config.js
```
