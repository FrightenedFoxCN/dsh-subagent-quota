# dsh-subagent-quota

**按 preset 给 subagent 加软配额**：实例级 `maxActiveSubagents`（如 12）是硬上限，这个插件让你在**单个 preset** 里再压一道——某类 agent 最多只能持有 N 个子代，超过就直接拒绝创建。

## 为什么需要它

原生 `@deepseek-ai/dsh-tool-subagent` 只有一个策略参数 `maxDepth`（深度），**没有数量配额**。它的 `execute` 直接 `ctx.subagents.startActivation(...)`，中间没有检查点。所以要么改源码，要么像本插件这样包一层。

## 它做的事

```
工具调用
  ├─ 同步占位（in-process reservation，关掉并行调用窗口）
  ├─ 普查：ctx.subagents.listDescendants(caller.id)
  │    ├─ countScope: children → 只数直接子代
  │    └─ countScope: tree     → 数整棵子树
  │    └─ countIdle: false     → 只数 running，忽略 inactive
  ├─ 已用 + 正在启动 >= maxChildren → 抛错（不创建）
  └─ 否则 startActivation → 子代 settle 时释放占位
```

**拒绝发生在创建之前**：不留 Session、不留 catalog 条目、不消耗 activation 槽位。

## 配置

```yaml
- id: tool-subagent
  name: '@local/dsh-subagent-quota'
  config:
    provider: spawn          # 服务提供者名（spawn / fork / 自定义）
    toolName: subagent       # 模型看到的工具名；建议沿用 subagent
    maxChildren: 3           # 软配额（默认只数运行中的子代）；0 = 禁止委派
    countScope: children     # children | tree
    countIdle: false         # true 时把"已完成但驻留"的子代也算作占用
    maxIdleChildren: 0       # >0 时自动 dispose 超额的空闲子代（保留最新的 N 个）
    modelSelection: false     # 暴露 provider/model/reasoning_effort 参数（经 llm.resolveModelInfo 校验）
    modelDiscovery: false     # 注册 list_subagent_models（每个 scope 只能开一个实例）
    agentOptions: {}          # 子代默认路由（provider/model/reasoningEffort/maxTokens）
    statusToolName: ''       # 非空则注册一个只读状态工具
    agentPreset: ''          # 可选：子代使用的 preset（仅 spawn 支持）
    # maxDepth: 2            # 可选：透传给服务（原生工具支持的那个深度上限）
```

## 挂载方式（按 preset，务必整行替换）

```yaml
- id: persona
  name: '@deepseek-ai/dsh-persona'
  config:
    prefix: You are a coding agent. You may hold at most 2 subagents at a time.
- id: tool-subagent
  name: '@local/dsh-subagent-quota'   # ← 替换原生 tool-subagent 行
  config:
    provider: spawn
    toolName: subagent
    maxChildren: 2
    countIdle: true
```

> ⚠️ **必须替换，不能并存**：preset 里如果还留着原生 `tool-subagent` 行，那条路径没有配额检查，模型照样能绕过。
> 另外工具名尽量保持一致（`subagent`）：改名会改变系统提示里的委派指引，导致 KV cache 重新预热。

## 返回与报错

成功时与原生工具一致：返回 `{ kind: 'activation', name }`，渲染为 `started subagent <name>`。

超配额时抛错，模型能看到可操作的提示：

```
subagent quota reached: this preset allows at most 2 direct children (including idle ones),
and you already hold 2. Reuse an existing child with send_message, wait for one to finish,
or carry out the work yourself.
```

`maxChildren: 0` 时文案改为"本 preset 禁止委派，请自己做"。

## 设计细节

| 细节 | 处理 |
|---|---|
| 并行竞态 | 检查前**同步**在一个 `Map` 里占位；子代 settle 前一直占着，避免"快速连续调用"超额 |
| 普查失败 | `listDescendants` 抛错时不静默放行也不崩：按 0 计数并在拒绝文案里附 `census degraded: <原因>` |
| 占位释放 | 成功路径挂在 `started.result.finally`；异常路径在 `catch` 里释放，保证只释放一次 |
| 空闲子代 | `countIdle: true` 时计入——它们仍占用 activation 槽位；`false` 只数 running |
| 状态工具 | `statusToolName` 注册只读工具，返回 `{limit, used, starting, scope, remaining}`，方便验收 |

## 验收（本仓库已验证）

| 用例 | 期望 | 结果 |
|---|---|---|
| 配额 2，三个并发调用 | 恰好 2 成功、1 拒绝 | ✅ PASS |
| 配额已满后继续调用 | 拒绝 | ✅ PASS |
| `countIdle: false`（1 running + 1 idle，配额 2） | 放行 | ✅ PASS |
| 普查抛错 + 配额 0 | 拒绝且带 `census degraded` | ✅ PASS |
| `statusToolName` | 返回 `{limit, used, running, idle, starting, remaining}` | ✅ PASS |
| 去重 | 子代已在 census 中 running 且占位仍持有 → `used` 不翻倍 | ✅ PASS |
| 空闲回收 | `maxIdleChildren:1` 连续派 4 次 → 依次回收最旧的 2 个 | ✅ PASS |
| 模型选择 | `provider/model/reasoning_effort` 经 `resolveModelInfo` 校验后透传为 `agentOptions` | ✅ PASS |
| 非法路由 | 只给 provider、未知路由、模型不支持的 effort 均被拒 | ✅ PASS |
| 模型发现 | 列出全部 provider/model；精确路由时返回 reasoning efforts | ✅ PASS |

测试脚本不依赖 DSH 运行时，用 mock 的 `ctx.tools` / `ctx.subagents` 直接驱动 `execute`。

## 实现注意（踩过的坑）

1. **工具 schema 必须用 `defineTool` 或手写编译后的 JSON Schema。**
   `ctx.tools.register()` 不做 DSL 编译；原生工具的 `parameters: { x: { type: 'string', required: true } }`
   是 `defineTool` 的 author DSL，绕过它直接注册会把 DSL 原样发给模型，
   得到 `Invalid schema for function ... is not of type "string"`。
   本插件因此直接写编译后的形状（`type: object` + `properties` + `required: [...]`），
   并自己补了参数校验（`defineTool` 原本会做）。

2. **preset 内的插件不能按裸包名引用 profile 里安装的包。**
   preset 子行的模块解析基准不是 profile 目录（实测 `install` 锚点解析 `@local/*` 为
   `MODULE_NOT_FOUND`），报错形式是 `tool-subagent (...): never started`，且整个 preset
   revision 被拒。解法：**把 preset 声明和插件本体放进同一个 bundle**，
   让解析基准与声明者同源，用自引用包名即可（绝对 `file://` URL 也能work，但不可移植）。

3. **不要用"占位 + census"做朴素相加。** 占位与 census 会重叠：同一子代既在 running
   又在占位里，`used` 会翻倍（实测出现过 `28/24 used (14 running, 14 starting)`）。
   占位必须携带 `childId`，与 census 的 running 集合按 id 去重。

4. **`countIdle` 的语义。** DSH 的子代完成后是驻留可续会话（`activity: 'inactive'`），
   不是工作。默认只数 `running`；要限制驻留量用 `maxIdleChildren` 做主动回收。

## 安装

bundle 里的行默认 `disabled: true`，所以**装上不生效**，等你在 preset 里引用即可：

```bash
dsh plugin --profile desktop add /absolute/path/to/dsh-subagent-quota
```

要全局启用（不推荐，会作用于所有会话）：把 `cordis.patch.yml` 里的 `disabled: true` 删掉。

## 与硬上限的关系

```
实例 maxActiveSubagents（硬，默认 8）  ← 满了报 ACTIVATION_LIMIT_REACHED、不排队
        ↑ 先撞到的通常是它
preset maxChildren（软，本插件）        ← 报"配额已满，请复用或自己做"
```

建议软配额明显低于硬上限（比如硬 12 / 软 3），让"配额"成为主要的节流手段，硬上限只做兜底。
