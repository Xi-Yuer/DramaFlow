# Runtime 架构与技术分工

平台负责领域协议、编译适配和业务记录；LangGraph 负责调度、State 通道、checkpoint、interrupt / resume。输入输出见 [Workflow](workflow-model.md)，值与内容见[数据模型](data-model.md)，生产装配与队列见[架构](architecture.md#生产-runtime-装配)。

## 编译与执行分离

Compiler 冻结定义、校验精确 Registry 版本并连接依赖与 START / END；不创建 Run / thread 或执行业务。普通 Action 只实现 execute，经编译 wrapper 调用统一 NodeExecutor；其他 executionKind 必须使用独立策略。

NodeExecutor 顺序为 createRunning → 解析绑定 → 记录 RuntimeValue 输入 → decode → 校验 input / config → execute → 校验 output → encode → markCompleted。完成记录成功后才写 State。服务对象不进入 State；Codec / Writer 只取得当前项目 / 运行 / 节点 / 输出定位。

### Action 执行错误阶段

业务失败记录 resolve_input、decode_input、validate_input、validate_config、execute、validate_output 或 encode_output；持久错误只保留安全摘要，不保存 cause / stack / Provider 内容。节点失败不产生占位输出，不自动重试。

Repository 故障独立于业务错误；完成记录失败不得反向 markFailed 或写 State，双重记录失败保留两个原因。GraphBubbleUp 原样交回 LangGraph，已有 NodeRun 保持 running；普通 Action 不主动 interrupt。

### 普通确定性依赖的 ALL Join

`collectNodeDependencies` 合并 Data / Control Edge 与 template node_output，按 target 聚合、source 去重；不读取端口或构造输入，workflow_input 不产生节点依赖。START / END 使用同一语义。

单上游 `addEdge(source, target)`；多上游一次 `addEdge([sources], target)`，全部完成后执行一次，不拆成独立触发边，不自建 ready 计数。Conditional / Send / Batch 不套用静态 ALL。

### Action DAG 技术执行预算

联合依赖图中根节点 level = 1，下游 level = 1 + max(上游 level)，最长 Action 路径深度 D = max(level)，空图 D = 0。纯分析复用 `collectNodeDependencies`，与依赖编译使用同一规则。

Compiler 在创建 Executor / 图节点前确认全图均为受支持的 Action DAG，再以官方 `withConfig` 绑定 `recursionLimit = D + 1`。空图为 1，100 个独立节点为 2，100 层串行为 101。Publish 与 Runtime 校验同一联合 DAG，不新增任意节点数或深度上限。

这只覆盖当前策略首次正常执行的技术预算，不是费用、节点数量或 thread 累计额度。Runner 不分析拓扑；interrupt / resume 语义不变，未来执行种类必须独立定义预算。

### 简单 If 的条件路由与预算

当前仅开放精确 `flow.if@1`，由独立 IfNodeCompilationStrategy 编译；普通 Action strategy / NodeExecutor 不变。If 复用 BindingResolver 与本次 Run 已授权的 Codec，校验 RuntimeValue 和解码后的 string，再调用 evaluateCondition 一次。它不创建 Action NodeRun，也不返回公开 Data Output。条件结果写入内部 `execution.controlResults[nodeId]`，boolean map reducer 合并并行 If、拒绝重复写入；旧空 execution 仍有效，checkpoint / resume 保存该结果。

Compiler 使用 LangGraph 原生 addConditionalEdges，callback 只读取该 If 已写入的 boolean，不再 Binding / decode / 求值。当前 true / false 各指向一个不同的终端 Action；支持多个分支互不重叠的独立 If，以及 If 前的普通 Action DAG / ALL join。分支的每个 Data / Control / Template 来源必须是所属 If 的严格祖先，保证路由发生时已经完成。

`compiler/if/analysis.ts` 复用 collectNodeDependencies，同时验证当前拓扑并产生编译投影。If 的命名 ControlEdge 不进入普通静态依赖；分支目标的其他依赖只用于就绪证明和 Binding，不编译成无条件触发边，避免 DataEdge / Template 绕过条件。其他普通依赖仍由 DependencyCompiler 编译为原生 ALL。START 排除所有条件目标；END 连接可执行叶子，不等待未选分支。

预算按实际编译后的静态依赖与两条潜在条件路径计算最长节点深度（包含 If），再加 1 次终止检测；If 路由 callback 不额外占 superstep。这是独立的简单 If 分析，不调用 Action 专用分析。真实边界为 A=1、If=2、leaf=3，recursionLimit=4；100 个上游并行节点仍为 4，100 层串行上游加 If 和 leaf 为 103。预算属于单次 invocation，不是 thread 累计额度。

Publish 与 Compiler 共用同一个能力分析：拒绝分支后继链、merge / nested、跨支依赖、共享分支目标、一出口多目标、来源未被 If 前置保证就绪的分支输入，以及条件分支来源的 Workflow output；不新增长期 Contract 限制或 optional output。不通过能力检查时，在创建执行服务 / 执行任何节点前失败。只允许声明必定执行的无条件节点输出，OutputResolver 不变。Web 的四种 string 条件与命名控制出口只编辑 Definition，不扩展这些运行能力。

## Submission 与 Runner

Submission 校验固定版本的调用契约，再原子创建 / 复用 Run 与 Outbox；不编译、claim 或解析引用内容。Repository 持续按项目 / 所有者授权，身份、版本、thread 和 inputs 不可改写。幂等规则见 [Workflow](workflow-model.md#start-invocation-身份)。

首次 executeStart 原子 claim pending → running，设置 startedAt，然后读取原版本、编译、初始化 State。executeResume 原子 claim waiting → running，保留 startedAt，读取原 thread checkpoint；缺失或身份不符失败，不初始化新 State / Run / thread。竞争失败不执行。

Graph 返回后核对 checkpoint 身份、next / tasks、任务错误和 interrupt：仍有任务记 waiting，否则解析最终输出。执行 / 解析失败由 claim 胜者记录 failed；记录服务自身故障不能再反向记录业务失败，留给既有恢复边界。

resume 只传不透明 value；单 interrupt 的 false / 0 / null 使用原生 interrupt ID map，避免依赖库 truthy 判断。恢复后可再次 waiting。Runner 不按 interaction NodeRun 自建暂停状态机，Human Review 尚未交付。

### 最终输出

`DefaultWorkflowOutputResolver` 只按 Definition.outputs 的声明名称收集 RuntimeValue；inline / reference 原样保留，不返回整份 State、不 materialize Artifact、不生成临时 URL。来源缺失或实际类型不兼容使 Run 在 resolve_output 阶段失败；空声明得到 `{}`。

生产 Runner 调用 `markCompleted`，同一次数据库更新写 completed、outputs 与 completedAt；Graph checkpoint、Run、Outbox 不承诺跨存储原子完成。Run 查询与 invocation lookup 返回同一安全输出投影；Web 展示边界见[当前架构](architecture.md#web-workflow-run-result)，尚无引用内容接口。

## State 与持久化

| 分区      | 内容与写入边界                                                     |
| --------- | ------------------------------------------------------------------ |
| run       | workflowId / workflowVersionId / workflowRunId / projectId，不可变 |
| inputs    | 本次 RuntimeValue 输入，不可变                                     |
| outputs   | nodeId → outputKey → RuntimeValue，当前有效结果                    |
| variables | 显式变量，不开放节点任意读写                                       |
| execution | 内部 controlResults boolean map，按 If nodeId 保存条件结果         |

State 与 Annotation 共处 runtime/state.ts。run / inputs / variables / execution 为单值通道，Action wrapper 只返回当前 nodeId 的 outputs 增量，不展开旧 State。非变异 reducer 合并不同节点；重复 nodeId 即报 DUPLICATE_NODE_OUTPUT_WRITE，不合并端口片段或静默覆盖。

这是普通 DAG 的单次有效输出约束，不能推断循环 / 批量 / 审核语义。NodeRun 保存 attempt 与业务历史，Artifact 保存内容，Checkpoint 保存恢复状态；attempt 不等于函数重入次数，不把日志、媒体、服务或对话历史塞入 State。输入绑定、decode / encode 和内容失败边界见[数据模型](data-model.md#codec-与-binding)。

## PostgreSQL Checkpointer

生产显式注入官方 PostgresSaver；Compiler 不执行 setup，不用 MemorySaver 兜底。恢复依赖同一数据库 / schema、原 thread、原版本与兼容实现；thread_id 不代表权限，运行配置拒绝覆盖它。初始化、连接和备份见[部署](deployment.md#langgraph-postgresql-checkpointer)。

## 人工介入、并行与副作用

人工审核采用 LangGraph interrupt / Command.resume，生成副作用与审核分离；重入不承诺外部 exactly-once。Send 需要 branch-local 输入；子流程必须显式输入输出映射，不能复制父 State。图级 maxConcurrency、Worker 跨运行并发和供应商配额是不同边界，测试夹具不是产品功能。
