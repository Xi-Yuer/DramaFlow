# Runtime 架构与技术分工

平台负责领域协议、编译适配和业务记录；LangGraph 负责调度、State 通道、checkpoint、interrupt / resume。输入输出见 [Workflow](workflow-model.md)，值与内容见[数据模型](data-model.md)，生产装配与队列见[架构](architecture.md#生产-runtime-装配)。

## 编译与执行分离

核心基础设施遵循[通用性与业务解耦原则](platform-model.md#workflow-通用性与业务解耦)。Binding 解析本图的显式数据来源，Executor 执行当前节点，Composite Strategy 解释控制语义；都不解释剧集、章节、商品或广告。共享子图执行归属与查询已使用通用 ChildExecution，当前 `childExecutionId` 的依赖及边界见[执行归属审计](architecture.md#execution-归属审计)；推荐设计见[实施方案](implementation-plan.md#execution-tree-演进设计)，通用只读 Run Tree DTO / 查询已实现，见[查询边界](architecture.md#execution-tree-只读查询)；通用 ExecutionScope 持久化尚未实现。

Compiler 冻结定义、校验精确 Registry 版本并连接依赖与 START / END；不创建 Run / thread 或执行业务。静态端口与 Schema 语义留在 definition；Publish 与 Compile 共用的执行种类和拓扑门禁在 `compiler/execution-capabilities.ts`。普通 Action 只实现 execute，经编译 wrapper 调用统一 NodeExecutor；其他 executionKind 必须使用独立策略。

NodeExecutor 从显式 scopeKey 获取或创建 occurrence，再在该 occurrence 内 createRunning → 解析绑定 → 记录 RuntimeValue 输入 → decode → 校验 input / config → execute → 校验 output → encode → markCompleted。完成记录成功后才写 State。服务对象不进入 State；Codec / Writer 只取得当前项目 / 运行 / 节点 / 输出定位。

Iteration 由独立 composite strategy 编译为 prepare → 原生 Send / compiled Body subgraph → collect。prepare 创建父 NodeRun；每个 Body 审计入口创建 ChildExecution 并向 Body NodeRun 显式传入关联 ID，declared outputs 成功后完成 item，collect 完成父记录。业务失败记录当前 item 与父 NodeRun；GraphBubbleUp 保持 running，仓储故障独立传播。scope 包含本次父 NodeRun 身份并保存在 checkpoint，详情与嵌套父链见[当前架构](architecture.md#child-execution-持久化)。动态端口与 body 门禁见[Node 模型](node-model.md#iteration-composite-contract)。

### Action 执行错误阶段

业务失败记录 resolve_input、decode_input、validate_input、validate_config、execute、validate_output 或 encode_output；持久错误只保留安全摘要，不保存 cause / stack / Provider 内容。节点失败不产生占位输出，不自动重试。

Repository 故障独立于业务错误；完成记录失败不得反向 markFailed 或写 State，双重记录失败保留两个原因。GraphBubbleUp 原样交回 LangGraph，已有 NodeRun 保持 running；普通 Action 不主动 interrupt。

### 普通确定性依赖的 ALL Join

`collectNodeDependencies` 合并 Data / Control Edge 与 template node_output，按 target 聚合、source 去重；不读取端口或构造输入，workflow_input 不产生节点依赖。START / END 使用同一语义。

单上游 `addEdge(source, target)`；多上游一次 `addEdge([sources], target)`，全部完成后执行一次，不拆成独立触发边，不自建 ready 计数。Conditional / Send / Batch 不套用静态 ALL。

### Scoped / Recursive Graph 编译

root、Iteration.body 与 SubWorkflow.graph 统一进入内部 compileGraph，由同一策略分发和依赖管线建立图。调用方仍持有各自的原生 StateGraph schema / reducers；显式 entry / declared-output completion 回调承接专属审计，局部调用的 inputs 仍由 Local Graph Invocation 独立映射。compileGraph 不 invoke 子图、不持久化身份、不安装 Saver。Iteration 的 Send、固定集合顺序、失败传播与 checkpoint 状态不变。SubWorkflow 固定调用一次，子图不包含 If。

编译计划分别携带静态 Definition Location 和运行 execution provider，路径使用既有 graph slot abstraction。静态位置不含 item index、scope 或 namespace；相同局部 nodeId 通过隔离 State 和显式运行 scope 区分。技术结构分析可以递归计算图预算，正式 prepare 仍执行当前能力门禁。SubWorkflow v1 已接入；nested Human Review 没有实现。子图 Publish 拒绝 If、Candidate、Human Review、Iteration 与嵌套 SubWorkflow。入口和限制见[架构](architecture.md#scoped-graph-compilation)。

### Action DAG 技术执行预算

联合依赖图中根节点 level = 1，下游 level = 1 + max(上游 level)，最长静态路径深度 D = max(level)，空图 D = 0。纯分析复用 `collectNodeDependencies`，与依赖编译使用同一规则。

Compiler 在创建 Executor / 图节点前确认节点种类与拓扑受支持（Action 与分支区域外的串行 Human Review），普通无额外边界的图以官方 `withConfig` 绑定 `recursionLimit = D + 1`。空图为 1，100 个独立节点为 2，100 层串行为 101。Publish 与 Runtime 校验同一联合 DAG，不新增任意节点数或深度上限。

预算按每次 LangGraph 调用计算，不是费用、节点数量或 thread 累计额度。Human Review 的暂停不额外插入完成节点；resume 从原 checkpoint 重入审核，后续路径不超过已证明的最长路径。测试覆盖审核 root 后 0 / 1 / 2 / 30 层后继和实际 resume 的不足 / 足够预算边界。通用图预算还计入实际 entry / completion 节点，并取自身、各递归子图与策略 wrapper 上限的最大值；Iteration Body 与 SubWorkflow 子图均为 D+3，wrapper 为 4，item 数和调用次数不参与计算。Runner 不分析拓扑，执行种类必须声明自身结构并证明预算。

### 简单 If 的条件路由与预算

当前仅开放精确 `flow.if@1`，由独立 IfNodeCompilationStrategy 编译；普通 Action strategy / NodeExecutor 不变。If 复用 BindingResolver 与本次 Run 已授权的 Codec，校验 RuntimeValue 和解码后的 string，再调用 evaluateCondition 一次。它不创建 Action NodeRun，也不返回公开 Data Output。条件结果写入内部 `execution.controlResults[nodeId]`，boolean map reducer 合并并行 If、拒绝重复写入；旧空 execution 仍有效，checkpoint / resume 保存该结果。

Compiler 使用 LangGraph 原生 addConditionalEdges，callback 只读取该 If 已写入的 boolean，不再 Binding / decode / 求值。true / false 各路由到一个不同的 Action entry，后继允许串行、并行和同一分支内部的 ALL join。多个独立 If 的 region 不得交叉。Branch Region 是 compiler/if/branch-regions.ts 的内部分析结果，不进入 Definition、State 或数据库。以两个 entry 为 seed，沿 collectNodeDependencies 的统一普通依赖传播，记录所有 membership、terminal、ordinary 节点及汇合 / 交叉证据；合法汇聚边界在编译期推导，分支传播在边界前停止。分支输入仅能来自本 region 或所属 If 之前确定完成的祖先；祖先由依赖推导，不看位置。

`compiler/if/analysis.ts` 复用 collectNodeDependencies，同时验证当前拓扑并产生编译投影。If 的命名 ControlEdge 不进入普通静态依赖；entry 的静态触发依赖移除，合法汇聚入边按 completion groups 投影；其余 successor 保留全部普通依赖，且至少有一个本 region 的上游作为 gate，避免共同祖先先完成就绕过 If。多个上游仍由 DependencyCompiler 编译为一次原生 ALL，包含已经完成的 pre-If 祖先；原始 edges / template 完整保留给 Binding。START 排除所有条件目标；每个 region 可有多个 terminal（无 region 内后继）；END 分别连接执行叶子，不对两支 terminal 建 ALL barrier，不等待未选分支。

预算算法保持不变：按实际编译后的静态依赖与两条潜在条件路径计算最长节点深度（包含 If 和全部 successor），再加 1 次终止检测；If 路由 callback 不额外占 superstep。这是独立的简单 If 分析，不调用 Action 专用分析。真实边界为 A=1、If=2、leaf=3，recursionLimit=4；100 个上游并行节点仍为 4，100 层串行上游加 If 和 leaf 为 103。预算属于单次 invocation，不是 thread 累计额度。

Publish 与 Compiler 共用同一个能力分析：拒绝不完整或有歧义的汇聚、nested If、不同 If region 交叉、一出口多 entry，以及来源既非本 region 又非 guaranteed-before 祖先的输入；不新增长期 Contract 限制或 optional output。不通过能力检查时，在创建执行服务 / 执行任何节点前失败。单 source 只允许必定执行的节点；sources 允许同一 If 的两个 region 各一个保证执行的候选，可取不同深度且不要求 terminal；无环 Action region 的可达性、本地 gate 与全部父依赖就绪证明共同保证选中后必执行。不安全汇合 / nested / region 交叉 / 外部依赖分别返回 IF_CONVERGENCE_UNSUPPORTED、IF_NESTED_UNSUPPORTED、IF_REGION_INTERSECTION_UNSUPPORTED、IF_BRANCH_DEPENDENCY_UNSUPPORTED，保留安全 nodeId 定位；这些是当前 Compiler 能力限制，不是永久 Contract 规则。

### If 的直接汇聚

Compiler 内部以 `IfConvergence { ifNodeId, targetNodeId, completionGroups: { true, false } }` 表示汇聚，不增加领域节点、Definition 字段或 Runtime State。`compiler/if/convergence.ts` 从原始双分支可达证据推导首个共同前沿，当前要求同一 If 恰好一个汇聚边界、覆盖两侧分支全部末端，且目标不能是 branch entry / 嵌套 If。重新计算 membership 时在边界前停止，因此目标及后继恢复 ordinary；未覆盖末端、绕行、多个独立共同前沿及不同 If 区域交叉仍拒绝。这些是当前 Compiler 能力限制，不是永久领域协议。

静态分析将汇聚目标的原始父依赖拆成两组：本支完成依赖 + 全部 ordinary 必需上游。每组成为一条 NodeDependency 记录，同一 target 可以重复；DependencyCompiler 原样逐组调用 LangGraph addEdge，单来源用字符串、多来源用数组 ALL barrier。两支是互斥 alternatives，组内是 ALL。共同依赖 X 必须进入两组，不能另外生成独立 X → target 激活边。普通 collector 仍每目标一组 ALL，不因 convergence 改变原始 DataEdge / ControlEdge / template 来源或普通 join 语义。

汇聚输入支持 candidate binding，且其来源本身参与统一依赖收集，无需额外添加 B / C → 汇聚目标的 ControlEdge。当前每个候选输入须恰有两个来源，分别来自同一 If 的 true / false region，并通过直接汇聚证明；不满足时 Publish / Compiler 以 IF_CONVERGENCE_INPUT_UNSUPPORTED 拒绝。普通 DataEdge 或 template 仍不能直接读取互斥分支值；ordinary 来源按原有 Binding 处理，不依靠运行时 missing 兜底。BindingResolver 从实际已有输出中读取唯一候选值，多个值报 CANDIDATE_INPUT_AMBIGUOUS，缺值报原有输入缺失错误。汇聚后确定执行的节点可声明单来源 Workflow Output；汇聚前分支候选仍遵守现有互斥覆盖规则。

START / END 与预算使用完成组全部潜在父关系的并集，仅供静态 root / leaf 和最长路径计算，不将并集编译成跨支 ALL。没有额外汇聚节点 / superstep；recursionLimit 仍为潜在最长节点路径 + 1。真实边界 A=1、If=2、B/C=3、汇聚目标=4，limit=4 失败而 5 完成；100 层分支再接 30 层普通后继的深度为 132、limit=133。Publish 和 Compiler 继续共用能力分析，在创建服务或执行节点前拒绝非法图。

## Submission 与 Runner

Submission 校验固定版本的调用契约，再原子创建 / 复用 Run 与 Outbox；不编译、claim 或解析引用内容。Repository 持续按项目 / 所有者授权，身份、版本、thread 和 inputs 不可改写。幂等规则见 [Workflow](workflow-model.md#start-invocation-身份)。

首次 executeStart 原子 claim pending → running，设置 startedAt，然后读取原版本、编译、初始化 State。executeResume 原子 claim waiting → running，保留 startedAt，读取原 thread checkpoint；缺失或身份不符失败，不初始化新 State / Run / thread。竞争失败不执行。

Graph 返回后核对 checkpoint 身份、next / tasks、任务错误和 interrupt：仍有任务记 waiting，否则解析最终输出。执行 / 解析失败由 claim 胜者记录 failed；记录服务自身故障不能再反向记录业务失败，留给既有恢复边界。

正式 Human Review 恢复传入持久化目标 token 与不透明 value；Runner 核对 checkpoint 后使用显式 interrupt ID map，不猜目标或解释业务决策。底层通用兼容路径的单 interrupt false / 0 / null 仍使用原生 ID map，避免依赖库 truthy 判断。恢复后可再次 waiting。Runner 不按 interaction NodeRun 自建暂停状态机；Human Review 专用策略在 interrupt 前获取或创建 attempt 1 running 审计、首次记录输入，恢复时比较并复用原输入；合法决策完成同一 NodeRun 后才写 State。原生控制流不记 failed，审核等待仍用 WorkflowRun / checkpoint 表达；inline string 限制与拓扑门禁见[当前架构](architecture.md#human-review-声明与纯业务边界)。

在途 cooperative cancellation 使用 RunnableConfig.signal，持久化意图仍是 correctness source；控制分类、owner 审计终结和迟到写回约束见[取消基础](architecture.md#workflow-run-cancellation-foundation)。取消不使用 Human Review resume，也不删除 checkpoint。

### 最终输出

[OutputResolver](../packages/workflow/src/runtime/state/workflow-output-resolver.ts)仅按最终 State 解析声明：单 source 维持原行为；sources 恰好一个自身来源存在才返回原 RuntimeValue，零个报 WORKFLOW_OUTPUT_MISSING，多个报 WORKFLOW_OUTPUT_AMBIGUOUS，类型不符报 WORKFLOW_OUTPUT_TYPE_MISMATCH。不读取条件、ControlEdge 或 controlResults，不做优先选择、内容合并或 Artifact materialization。这些异常沿现有 resolve_output 失败路径记录 WORKFLOW_OUTPUT_RESOLUTION_FAILED，不返回部分结果。

Resolver 不返回整份 State，不生成临时 URL；空声明得到 `{}`。

生产 Runner 调用 `markCompleted`，同一次数据库更新写 completed、outputs 与 completedAt；Graph checkpoint、Run、Outbox 不承诺跨存储原子完成。Run 查询与 invocation lookup 返回同一安全输出投影；Web 展示边界见[当前架构](architecture.md#web-workflow-run-result)，尚无引用内容接口。

## State 与持久化

| 分区      | 内容与写入边界                                                     |
| --------- | ------------------------------------------------------------------ |
| run       | workflowId / workflowVersionId / workflowRunId / projectId，不可变 |
| inputs    | 本次 RuntimeValue 输入，不可变                                     |
| outputs   | nodeId → outputKey → RuntimeValue，当前有效结果                    |
| variables | 显式变量，不开放节点任意读写                                       |
| execution | 内部 controlResults boolean map，按 If nodeId 保存条件结果         |

State 与 Annotation 共处 runtime/state/state.ts。run / inputs / variables / execution 为单值通道，Action wrapper 只返回当前 nodeId 的 outputs 增量，不展开旧 State。非变异 reducer 合并不同节点；重复 nodeId 即报 DUPLICATE_NODE_OUTPUT_WRITE，不合并端口片段或静默覆盖。

这是普通 DAG 的单次有效输出约束，不能推断循环 / 批量 / 审核语义。NodeOccurrence 保存逻辑执行身份，NodeRun 保存其 attempt 与业务历史，ChildExecution 保存父 attempt 发起的子图调用身份和生命周期，并关联子图 NodeRun；Iteration 的 item index 仅是 typed metadata，Artifact 保存内容，Checkpoint 保存恢复状态；attempt 不等于函数重入次数。领域 occurrence 不取自 taskId、checkpoint namespace 或 nodeAttempt，也不要求修改已有 checkpoint State。身份与持久约束见[当前架构](architecture.md#node-execution-occurrence)。不把日志、媒体、服务或对话历史塞入 State。输入绑定、decode / encode 和内容失败边界见[数据模型](data-model.md#codec-与-binding)。

## PostgreSQL Checkpointer

生产显式注入官方 PostgresSaver；Compiler 不执行 setup，不用 MemorySaver 兜底。恢复依赖同一数据库 / schema、原 thread、原版本与兼容实现；thread_id 不代表权限，运行配置拒绝覆盖它。初始化、连接和备份见[部署](deployment.md#langgraph-postgresql-checkpointer)。

## 人工介入、并行与副作用

人工审核采用 LangGraph interrupt / Command.resume，生成副作用与审核分离；重入不承诺外部 exactly-once。Send 需要 branch-local 输入；子流程必须显式输入输出映射，不能复制父 State。图级 maxConcurrency、Worker 跨运行并发和供应商配额是不同边界，测试夹具不是产品功能。
