# 当前架构与目录职责

只记录已实现能力及其入口。协议见 [Workflow](workflow-model.md)、[Node](node-model.md)、[数据模型](data-model.md)、[Runtime](runtime-architecture.md)；当前工作与待决策项见[实施方案](implementation-plan.md)。精确字段以 contracts、Schema 和 Controller 为准。跨模块设计遵循[Workflow 通用性与业务解耦原则](platform-model.md#workflow-通用性与业务解耦)。

## 已实现的基础工程

| 领域       | 当前能力与边界                                                                                                         |
| ---------- | ---------------------------------------------------------------------------------------------------------------------- |
| 身份与项目 | 登录、账户中心、项目所有者隔离；每项目一张画布、一个逻辑 Workflow                                                      |
| Editor     | 草稿加载 / 保存、节点创建 / 移动 / 删除、Data / Control Edge、候选输入、文本变量与模型选择、End 输出配置；无节点重命名 |
| Publish    | 静态语义、同 Owner 模型绑定校验、不可变版本；保存和发布独立                                                            |
| Run        | 已发布版本提交、幂等身份、状态查询、离开保护和 invocation identity recovery                                            |
| Result     | completed Run 展示 declared outputs；支持 inline 与 reference 身份，尚无 Artifact 内容 HTTP API                        |
| 执行       | Action DAG、简单 If 与分支区域外的串行 Human Review；独立 Worker 执行                                                  |
| 基础设施   | PostgreSQL / Prisma、Redis / BullMQ、RustFS、官方 PostgreSQL Checkpointer                                              |

End 是 `definition.outputs` 的画布投影，不是 NodeType，不进入 nodes、Registry 或执行链。首条业务输出拖到 End 创建独立输出；已有输出时明确选择新建或加入某项候选。候选共用一个输出名称，分别投影连线，删除连线或节点仅清理对应候选；不足时保留可修复 Draft，不转换成单 source。单 source 仍保留原编辑与删除行为，类型按精确版本 Manifest 校验。End 位置仅在当前页面保留，声明从 Definition 恢复；保存与发布分开。协议与准入见 [Workflow](workflow-model.md#输入与输出)。

Root 的「工作流输入」边界投影 `definition.inputs`，可打开[输入编辑器](../apps/web/src/features/workflow/inputs/workflow-input-dialog.tsx)创建、改名、删除、设置必填与类型。复用 `GraphInputDefinition`、DataType 和 Body 的 Graph Input 控件，支持文本、数字、布尔、文本列表、数字列表；已有其他类型显示并保留原声明。Root 与 Body 共用[输入边界投影](../apps/web/src/features/workflow/iteration/body-input-boundary.ts)和类型兼容检查，包含 Iteration 实例派生的数组端口。连接只写入 `{ type: 'workflow_input', key }`，以 `workflow-input` 虚线显示；删除投影线清除对应 binding，边界不进入 nodes，投影不进入 edges 或运行时 DataEdge。改名同步本图 binding，删除声明或改为不兼容类型时清理相关直接 binding，已有来源替换须确认。Save / reload 从声明与 binding 恢复；Boundary 位置仅留在视图。运行输入控件见 [Run Form](#web-workflow-run-inputs)。

## Workflow 基础库

`packages/contracts` 定义中立 JSON 协议；`packages/workflow` 负责 Registry、发布 / 调用校验、编译和执行适配。运行绑定指定 WorkflowVersion，不读 draft / latest。Action DAG 的联合依赖与技术执行预算见 [Runtime](runtime-architecture.md#action-dag-技术执行预算)。

## Scoped Graph Compilation

[图编译计划](../packages/workflow/src/compiler/graph/compilation-plan.ts)与[通用 compileGraph](../packages/workflow/src/compiler/graph/graph-compiler.ts)是 Compiler 内部能力，root、Iteration.body 与 SubWorkflow.graph 共用同一节点策略分发、DependencyCompiler、条件边、START / terminal 连线与声明输出收口。Context 明确提供当前 GraphDefinition 的计划、既有 Definition Location、固定或按调用 State 解析的 scope / childExecutionId、可用策略、运行依赖、原生 builder 与入口 / 完成回调；不读取父 ambient State，不做 input mapping，不创建审计或 Saver。

DefaultWorkflowCompiler 只负责不可变快照、生产预检、限定 Run 的服务创建、root StateGraph 与 Checkpointer 装配。Iteration 保留 snapshot / Send / 映射 / scope / ChildExecution / 聚合政策，Body 的 Action-only 私有编译循环与重复依赖连线已删除。Body State、reducers、input/output schema 和 checkpoint 节点名保持原样；由 Iteration 提供入口回调创建 child，声明输出 barrier 完成后由其回调结束 child。Parent NodeRun 仍在 prepare 创建，ChildExecution 仍在 Body 图审计入口建立，而不是预先为所有 Send 创建记录。

Definition Location 沿既有 nestedGraphSlots 与 GraphDefinitionPath 追加 nodeId / graphKey，不使用 scopeKey 或全局唯一 nodeId。局部 Action 使用显式动态 execution provider，同一静态图位置可对应不同 scope；当前 Human Review / Iteration 策略仍要求固定父 scope，生产门禁也继续禁止在 Iteration 中嵌套这些节点。

[SubWorkflow Strategy](../packages/workflow/src/compiler/subworkflow/strategy.ts)在当前版本内固定调用一次内嵌图，不新增 Run / Job，也不做跨版本或跨项目授权。prepare 创建父 NodeRun 并按同名输入建立局部边界；子图入口创建或复用 kind=`subworkflow`、invocationKey=`subworkflow:graph` 的 ChildExecution；声明输出成功后结束 child，再完成父 NodeRun。子图允许普通 Action、Action 链、parallel + ALL join、DataEdge、workflow_input、constant、Template（包括依赖多个上游 Action 输出）和普通 Graph 输出。Publish 拒绝 Candidate、If、Human Review、Iteration、嵌套 SubWorkflow，以及其他 control / composite / interaction。Candidate 返回 `SUBWORKFLOW_GRAPH_CANDIDATE_UNSUPPORTED`，不留到运行期再报歧义；其余不允许的节点返回 `SUBWORKFLOW_GRAPH_CAPABILITY_UNSUPPORTED`。父图输入仍使用既有绑定，包括父图自己的 Candidate。Web 已有 Definition nested graph 编辑入口，Catalog 隐藏不移除已有节点的入口。业务失败同事务结束 child 与父 NodeRun；原生中断保持 running，仓储故障不伪装成业务失败。

计划递归分析已注册策略的图结构。普通局部预算为既有 DAG / If 路径上限加实际入口 / 声明输出节点；策略只声明 wrapper 节点数和 child boundary，公共预算合并各原生图的最大值。Iteration 与 SubWorkflow 的 wrapper 都是 prepare / 子图 / collect 三节点。Body 与 SubWorkflow 子图都有审计入口和声明输出收口，因此深度 D 对应 D+3；wrapper 上限为 4，总上限取较大值，不按调用次数相加。技术结构分析与生产 prepare 分离：可分析嵌套 Iteration 的预算不表示准入；prepare 在任何执行服务创建前保留现有 capability / topology gate。条件局部图若需声明输出收口，目前要求已证明的唯一终点，不能对互斥出口误用 ALL barrier；这不限制 root 既有条件出口。SubWorkflow v1 子图不编译 If。

## Node Execution Occurrence

[NodeOccurrence / NodeRun 协议](../packages/contracts/src/workflow/run/node-run.ts)区分一次逻辑执行与尝试。`node_occurrence` 保存逻辑执行，不创建通用 ExecutionScope 表；occurrence 由固定 WorkflowRun、scopeKey 和 nodeId 唯一定位，并拥有独立 UUID。根图显式使用 root scope，Iteration Body 使用 ChildExecution 对应的子 scope，nodeId 归属 Run 的固定 WorkflowVersion；If 仍不创建 NodeRun。scopeKey 是受信任执行上下文提供的产品身份，不解析为 iterationIndex、LangGraph namespace 或权限凭据。

[NodeRun Repository](../packages/server/src/workflow/runtime/execution/node-run-repository.ts)按授权 Run 获取 / 创建 occurrence；唯一键竞争在事务 advisory lock 内串行化。创建 attempt 时锁定对应 occurrence 行，只在该 occurrence 内分配序号；NodeRun 的唯一键为 occurrenceId / attempt，复合外键保证 occurrence、NodeRun 的项目 / Run / nodeId 一致。数据库禁止修改 occurrence 身份及既有 attempt 的归属、序号和开始时间。Action Executor 通过显式 scopeKey 取得 occurrence，分配 attempt 的操作不新增 retry 策略或重放兜底。

NodeRun 查询新增安全的 occurrenceId / scopeKey，不返回 thread、checkpoint 或原生 task metadata。Canvas 与 Runtime Inspector 在明确的 graph execution boundary 内选择唯一 occurrence，再按其 attempt 排序；Root 与 Nested 共用投影，见 [Graph Execution Projection](#graph-execution-projection)。不以跨 occurrence 的最大 attempt 猜最新执行；Iteration Item Selector 只提供真实 ChildExecution 的显式选择。Artifact 继续只关联 nodeRunId，经 NodeRun 反查 occurrence，不复制 scope / occurrence 字段。

[增量迁移](../packages/database/prisma/migrations/20261024000000_node_occurrences/migration.sql)将旧数据的每组 Run / node 全部 attempt 回填到同一个 root occurrence，保留 NodeRun ID、序号、状态、输入输出、时间和 Artifact 关联，不清空审计记录。旧 checkpoint 的 State 不增加必填字段，现有 root 审核恢复重新查得同一 occurrence。

Iteration 的执行作用域通过下述 ChildExecution 与 NodeRun 父链关联。其他受信任的 scoped execution 仍需显式提供稳定 scopeKey、对应定义与权限上下文；没有 SubWorkflow 版本 / 权限解析，scopeKey 不能替代这些检查。

## Local Graph Invocation

[GraphDefinition](../packages/contracts/src/graph/definition.ts)统一 inputs / nodes / edges / outputs 及既有静态引用与 DAG 校验；WorkflowDefinition 保留原导出名并直接复用同一 Schema，根 Workflow 产品协议不变。局部图不创建 WorkflowRun，不增加 Body Node / Edge / Binding 协议。

[Invocation 工具](../packages/workflow/src/runtime/execution/graph-invocation.ts)只接收调用方明确提供的 RuntimeValue sources 和 source → target 映射，校验目标存在、重复目标、必填、来源存在、envelope 与类型兼容；可选输入可不映射，显式映射到不存在的来源仍报错。新 input map 保留选中 RuntimeValue 原对象，不 decode、不读取 Artifact、不生成 URL；调用方应将共享 envelope 视为不可变。workflow_input 继续指当前图调用的 input。

每次创建局部调用均独立初始化 inputs map、outputs、variables、execution 与 Run 元数据副本，不接收父 State；只共享明确传入的 RuntimeValue。统一 WorkflowOutputResolver 接收声明 outputs 与局部 outputs，支持多命名结果，继续检查缺失、歧义与类型并保留引用。

[内部 scope 工具](../packages/workflow/src/runtime/execution/execution-scope.ts)将 parent scope 与严格 typed segment 按固定顺序规范编码，再以 SHA-256 生成版本化 opaque scope。segment 包含 owner occurrence、slot，以及 iteration_item 的固定快照 index 或 subworkflow_call 的 callKey；Iteration Runtime 额外传入本次 ownerNodeRunId，使父 attempt 之间的子 scope 隔离。不含 concurrency 或 LangGraph 身份。相同输入跨重入稳定，不同父 scope 可组合嵌套；root 仍为 root。调用方负责确认 owner、parent、Run 归属并恢复同一快照，这个纯工具不提供授权或持久化。

Definition Location 单独记录不可变 workflowVersionId 与 nodeId / graphKey 路径；根图路径为空，不把 scopeKey 当定义地址。这里只校验定位结构，不解析嵌套版本或授权。局部节点仍复用 NodeOccurrence 的 Run / scopeKey / nodeId 身份，Iteration 的持久化父子归属见下述 ChildExecution。

Iteration Compiler 与 SubWorkflow Strategy 已使用这些工具构造子调用，分别经 LangGraph 原生 Send 与 compiled subgraph 执行；Human Review 的嵌套支持尚未接入。集合承载见下节。

## RuntimeValue Collection

统一 RuntimeValue 增加可递归、可序列化的 collection 表示，与 inline 业务 JSON 数组及整体 reference 分离。Snapshot 提供固定 length / get(index) 与可持久化的 toRuntimeValue；Builder 按 index 验证完整性与类型并有序构造，保留元素引用和嵌套层级。Codec 仅在 decode 时解析元素引用；普通 JSON 数组可继续显式 inline 或整体 Artifact，auto 不新增阈值。语义、媒体约束与接口见[数据模型](data-model.md#固定集合快照与有序构造)。

Graph Invocation input mapping 与 WorkflowOutputResolver 直接接受统一 RuntimeValue，不新增 Binding / Resolver。调用输入校验递归检查 collection 的内联元素，引用仍不读取。Web 只对 collection 显示“集合值暂不支持展示”，不展开元素或新增集合 UI。Iteration 已用 Snapshot 固定输入并按 index 聚合。SubWorkflow 在父子边界按原 RuntimeValue 传递集合与引用，不解码、不展开，也不因此多次执行。Provider media nodes 尚未接入集合执行。Array 本身仅表示数据，不触发多次执行。

## Iteration Contract 与 Publish

`flow.iteration@1` 已注册为 composite 声明，新增受校验的实例 body / 输入映射和 body-derived 数组端口；正式协议、Draft / Publish 差异与 v1 capability 见[Node 模型](node-model.md#iteration-composite-contract)。统一 resolveNodePorts 参与 Publish 的 DataEdge、Candidate、Template、类型与 WorkflowOutput 检查，不伪造静态输出。

Composite Definition 现以 kind 区分 Iteration.body 与 SubWorkflow.graph。后者按 v1 能力门禁发布，并固定调用一次，协议见[内嵌 SubWorkflow](node-model.md#内嵌-subworkflow-definition)。统一静态 graph slot / path 遍历用于 schema、Definition 语义和 Draft 配置字段检查，不关联运行 scope。

validateGraphDefinitionSemantics 递归检查局部边界并返回带 definitionPath 的全部后代，发布事务先用 assertGraphPublishTopology 保留既有 If / Human Review 拓扑限制，再据此统一检查 capability / 模型权限，最后调用 assertGraphExecutionCapabilities 检查实际执行能力。validateGraphForPublish 包含静态检查与执行门禁；Compiler 使用的旧 validateWorkflowDefinitionSemantics 保留执行种类门禁，根 If / Human Review 拓扑仍由既有 Compiler 分析。Draft 仍允许映射 / 必填配置未完成，不能把完整静态校验当成 Runtime-ready。

body 的嵌套 composite、If / control、Human Review / interaction 均拒绝；根既有 If / Human Review 行为不变。Web Iteration Inspector 支持 itemType、不变输入、Body 输入及映射；Body 内的输入边界与 Root 共用 Graph Input 连接机制，Body 输出通过现有端口推导提升为父 Iteration 的数组输出。Root 数组参数通过通用 Run Form 提交，不为 Iteration 增加专用输入协议。

## Child Execution 持久化

[ChildExecution 协议](../packages/contracts/src/workflow/run/node-run.ts)与 [schema](../packages/database/prisma/schema.prisma)正式保存某个 Parent NodeRun attempt 发起的一次子图调用。字段为 id、projectId、workflowRunId、parentNodeRunId、parentNodeId、scopeKey、kind、invocationKey、metadata、status、error 和 createdAt / startedAt / completedAt；可空 typed index 只服务 Iteration extension。parentNodeId 从旧模型保留，用于复合父外键，避免弱化 Run / 项目 / 节点归属。NodeRun.childExecutionId 为可空外键：root 为 null，子图 NodeRun 明确关联对应 ChildExecution；不再增加各 Composite 的专用归属字段。

唯一键 parentNodeRunId / invocationKey 是调用身份权威。Iteration 使用 kind=iteration_item、invocationKey=iteration-item:<index> 和 metadata.index；数据库保留可空 index 列，检查其与 metadata、invocationKey 一致，并保持 parent / index 与 Run / scope 唯一。其他 kind 不要求 index。UUID 主键独立于 index，scopeKey 也不等于 invocationKey。

[通用 Repository](../packages/workflow/src/runtime/execution/child-execution-repository.ts)提供授权 Run 内的稳定 get/create、按 ID 查询及生命周期。实现通过父 attempt / invocationKey 的 advisory lock 原子复用 running 记录，核对 kind、metadata、parent 与 scope；终态不重新创建。Body NodeRun 按显式 childExecutionId 读取子执行，再比较 occurrence scope；数据库触发器同样按 ID 校验，不按 scopeKey 反查或推断父链。[Iteration helper](../packages/workflow/src/compiler/iteration/execution-repository.ts)负责 index key 与专属失败传播，不让通用接口要求 index。

[Iteration strategy](../packages/workflow/src/compiler/iteration/strategy.ts)沿用 prepare → 原生 Send / compiled Body → collect：prepare 创建父 NodeRun 并审计输入；Body 入口创建或复用 ChildExecution，向 NodeExecutor 显式传递 childExecutionId；declared outputs 成功后结束 child，collect 完成父 NodeRun。空集合与普通数组 Action 不创建 child。业务失败仍通过 Iteration helper 在同事务记录 child 与父失败，同 item 并行失败保留首次摘要；通用 markChildExecutionFailed 仅结束 child。SubWorkflow 的业务失败使用 markChildExecutionAndParentFailed，在同一事务结束该 child 与父 NodeRun；Iteration helper 继续拒绝其他 kind。GraphInterrupt / ParentCommand 原样交还 LangGraph，记录保持 running；仓储故障不伪装业务失败。

[增量迁移](../packages/database/prisma/migrations/20261027000000_child_executions/migration.sql)原地 rename iteration_item_run / NodeRun 旧归属列，保留 ID、索引位置、归属、时间与错误，补齐 kind / invocationKey / metadata。父链可以表达 NodeRun → ChildExecution → NodeRun → ChildExecution；这不开放嵌套 Composite 执行。Iteration scope 派生和已持久化 checkpoint channel / frame / result 字段名保持不变，私有旧字段承载的 ID 现在指向 ChildExecution；不改写现有版本或 checkpoint。

审计与 checkpoint 不构成跨系统原子提交。原生重入复用同一父 attempt 与 child；崩溃后审计先落库但 checkpoint 未落库的窗口，仍需既有 recovery_required / 对账，不能自动重放受理不明的副作用。没有新增 Retry / Resume / interrupt 状态。

## Execution 归属审计

当前链为 WorkflowRun → Parent NodeOccurrence → Parent NodeRun attempt → ChildExecution → child NodeOccurrences / NodeRuns。NodeOccurrence 继续以 Run / scopeKey / nodeId 标识逻辑节点，attempt 只在 occurrence 内编号；ChildExecution 的具体父 NodeRun 隔离不同父 attempt。scope 是稳定 opaque 身份材料，不能还原静态定义路径；root 仍为约定字符串，没有独立 ExecutionScope 表。Outbox 的 executionId 是 start / resume 投递身份，与 child 调用不同。

通用 Contract、Executor context、NodeRun ownership、Repository 与 Tree Adapter 已使用 ChildExecution；Iteration 保留集合快照、current_item / current_index 映射、Send、有序聚合及 index extension。SubWorkflow v1 复用同一 ChildExecution，kind 为 `subworkflow`，invocationKey 固定为 `subworkflow:graph`，不使用 index。Compiler 的独立控制策略与 capability gate 继续保留。Definition Location 仍与 scope 分离，目前不提供通用关系型 definitionRef 或 Execution → Canvas projection。进一步的 occurrence / scope 归属统一、跨版本子图授权与 scoped resume 必须独立设计，不能因为持久化已通用就宣称这些能力已完成。Web 支持 Definition nested graph 编辑，但尚无单次调用 Retry / Resume。

## Execution Tree 只读查询

[通用 Contract](../packages/contracts/src/workflow/run/execution-tree.ts)定义 `ExecutionTreeResponse`，包含 Run 摘要 `run`、本次父引用 `parent`、该层子项 `items` 和 `nextCursor`。`parent` 由 `workflow_run / node_run / child_execution` 与稳定 id 构成；NodeRun 条目包含 nodeId、occurrenceId、attempt、状态、时间和安全错误，Child Execution 包含 id、kind、父 NodeRun、状态、时间和可选结构 metadata。所有子项显式携带 parent，不按 nodeId 合并 attempt；调用方用同一协议逐层读取，不需要知道底层归属字段。DTO 不含 scopeKey、ChildExecution 外键、LangGraph 类型或内部 token，也不复制输入输出 payload；运行值继续使用既有 NodeRun 查询。

`GET /api/v1/workflow-runs/:runId/execution-tree` 默认返回 root NodeRun；指定 `parentType=node_run&parentId=...` 读取子 Execution，指定 `parentType=child_execution&parentId=...` 读取其中的 NodeRun。`parentType=workflow_run` 的 parentId 可省略，若提供则必须是当前 Run。`limit` 默认 50、范围 1—100，`after` 接收上页 nextCursor；游标绑定 Run、父引用和最后一个稳定条目 ID。源适配器对 NodeRun 按 startedAt / attempt / id、对当前 item 执行按 index / id 排序，分页不生成新的执行身份。返回只是一层，不一次展开整树。

[独立 Controller](../apps/api/src/workflow/execution-tree/workflow-execution-tree.controller.ts)使用既有默认认证与 no-store。[WorkflowExecutionTreeService](../packages/server/src/workflow/execution-tree/workflow-execution-tree.service.ts)统一按 User → Project Owner → WorkflowRun 授权，再在同一 RepeatableRead 只读事务快照中访问该 Run / Project 的 source；每种 Composite 不各自实现授权。跨 Run / 不存在的父引用返回 404，非法查询或失效 / 跨父游标返回 400，归属数据不一致返回安全的 WORKFLOW_EXECUTION_TREE_INCONSISTENT（500），不伪造或补挂 root。查询不编译、不 invoke、不读取 checkpoint、不回写运行状态。

[PrismaExecutionTreeAdapter](../packages/server/src/workflow/execution-tree/prisma-execution-tree-adapter.ts)直接读取通用 ChildExecution：root occurrence 的 NodeRun 归到 WorkflowRun；ChildExecution.id 原样成为 child_execution.id，parentNodeRunId 映射为父 NodeRun，kind / metadata 来自正式结构记录；Iteration 继续返回 kind=iteration_item 与 metadata.index，Body NodeRun 按 childExecutionId 归属。Adapter 校验 occurrence、项目 / Run、scope 等值及父节点外键，不解析 scopeKey 编码，不复制完整 item。普通数组输出、空集合不会制造 child；已开始但尚无 Body NodeRun 的 item 仍可独立返回 running 状态。

[通用查询器](../packages/server/src/workflow/execution-tree/execution-tree-query.ts)只认识结构角色与显式 parent：沿选中条目的父链迭代核对到根，检测循环 / 孤儿，再有界读取当前层。不同 kind 使用同一遍历与分页协议；未来 ExecutionScope 数据源只需替换 source adapter。现有 A#2 → B#5 → NodeRun 的持久化父链已经过只读 PostgreSQL 查询验证；这不开放嵌套 Iteration Runtime，也不改变原有 Publish 门禁。

当前限制是尚无通用 scope 表与跨版本子图的关系型 definitionRef；旧数据若缺少真实父实例或非 root 节点的关联，查询明确拒绝，不能靠日志或 index 恢复。多次翻页之间可能新增记录或更新状态，每一页只有自身事务的一致快照，不承诺整棵活动运行树被冻结。独立状态按记录返回，不通过后代统一推导父状态。Web 只读浏览已接入运行面板，见 [Web Execution Tree 浏览](#web-execution-tree-浏览)。Item Retry / Resume 与新 Composite 均未加入。

## Human Review 声明与纯业务边界

`flow.human_review@1` 已进入生产 Registry / 节点目录，执行种类为 interaction，不提供 Action execute 或审批控制出口；Draft、Publish / Compile / Run 已接入独立 HumanReviewNodeCompilationStrategy；其他未知 interaction 仍以 NODE_EXECUTION_KIND_UNSUPPORTED 拒绝。节点标题使用 NodeDefinition.name，不另加 title config。

[Human Review V1 协议](../packages/contracts/src/workflow/run/human-review.ts)定义严格文本 input、可选静态 instruction、approve / reject decision 与稳定业务 output。合法 reject 是正常业务结果；content 原样透传，缺省 feedback 归一化为空字符串。payload 固定 human_review / schemaVersion 1，保留 RuntimeValue 结构及未来 reference 表达；[纯转换函数](../packages/workflow/src/node/builtin/human-review.ts)只接受 string 业务输入，构造 inline string payload，不解释 instruction 模板、不读取 Artifact，也不调用 interrupt。payload 不含 Run / thread / NodeRun / interrupt 身份；Decision 的版本由 V1 Schema/type 名称明确。

[专用策略](../packages/workflow/src/compiler/human-review/strategy.ts)复用 BindingResolver、Codec 和节点 Schema，解码前拒绝 reference content，再调用官方 interrupt(payload)。恢复值经 V1 decision Schema 校验后输出三个 RuntimeValue；缺省 feedback 为空，reject 正常完成，可把 action DataEdge 接入 If.value 控制后续分支。Runner 继续负责 checkpoint 检测、WorkflowRun waiting 与 Command.resume，正式 HTTP 恢复必须携带当前审核 token / waitingRevision，协议见下方 [Human Review 查询与恢复](#human-review-查询与恢复)。

Publish / Compile 共用 Human Review 能力门禁：支持分支区域外有明确依赖先后的串行审核，包括审核后进入 If、已证明 Direct Convergence 的 Candidate 输入进入审核；拒绝 If branch region 内审核和彼此无先后依赖的并行待审批（HUMAN_REVIEW_TOPOLOGY_UNSUPPORTED）。静态 DAG 与 If execution projection 的最长路径仍提供每次调用的技术预算，原生 MemorySaver 测试覆盖初次暂停、resume 和两次串行审核。恢复只重入当前审核函数，上游已完成 Action 不重跑；interrupt 前只做输入解析与可复用的审计持久化，不调用 Provider。

Human Review 已有正式 NodeRun 审计：首次进入创建 attempt 1 running、首次记录 RuntimeValue inputs；WorkflowRun waiting 时 NodeRun 保持 running，interrupt 身份以 checkpoint 为权威，不写入 NodeRun outputs。resume 重入获取同一记录，比较重新解析的 inputs 与首次快照（对象键顺序无关），不再次 updateInputs。decision / 输出校验及编码成功后 markCompleted，再提交 State；approve 和 reject 均正常 completed。业务错误将原记录记 failed，原生 GraphInterrupt / ParentCommand 不记失败；仓储失败不反向标记业务 failed。

[审核专用 Repository](../packages/server/src/workflow/runtime/execution/node-run-repository.ts)锁定明确 occurrence 获取 / 创建记录，核对 Owner / Project / Run、已 claim 的 running Run、固定 WorkflowVersion 中的精确 Human Review node，以及该 occurrence 唯一 attempt 1 running 历史；终态、多 attempt 或错误节点 / 版本明确拒绝，不按 latest running 猜测，也不自动新建 attempt 2。inputs 仍受原有一次写约束保护，完整执行的串行性依赖 Run / Outbox 的数据库 claim，获取 / 创建本身的唯一性由 occurrence 行锁与唯一约束保证。不同 scope 的同名节点不交叉复用审计；本轮未开放并行审核。

审核首次进入与 resume 通过同一 root scope 找到同一 occurrence，复用同一 running NodeRun attempt；本轮没有新增 NodeRun waiting、并行 pending projection、重试或恢复产品能力。审计 completed 与 Graph checkpoint 不构成跨系统原子提交；异常中断后的对账 / recovery_required 仍沿用既有边界，不重放终态记录。待审批查询与 targeted resume HTTP 已接入，Web 已提供单个文本审批闭环，Artifact 预览待后续任务。

## Workflow 编辑 HTTP API

业务接口均在 `/api/v1`，默认认证、no-store；写入检查 Origin，资源不存在或无权访问统一 404。

Project 使用 `GET / POST /projects`、`GET / PUT /projects/:id`；Workflow 使用 `GET / POST /projects/:projectId/workflow` 和 `PUT /workflows/:workflowId/draft`。Project 名称 / 视口与 Draft 各自维护 revision。初始化幂等，保存冲突返回 409，保存不发布或执行。请求与响应见 [Workflow contracts](../packages/contracts/src/workflow/workflow-api.ts)。

## Workflow 发布与版本 HTTP API

发布入口 `POST /workflows/:workflowId/publish`；版本摘要 `GET /workflows/:workflowId/versions`；固定版本 `GET /workflow-versions/:versionId`。发布锁定来源修订并原子分配版本号，失败不写版本；不解密凭证或调用模型。当前拒绝 Asset 绑定及未支持执行种类。精确 flow.if@1 已支持原生条件路由；Publish 与 Compiler 共享简单拓扑分析，放行分支内串行 / 并行 / ALL join 和静态证明安全的直接汇聚；汇聚按互斥 completion groups 编译为原生 edges / barriers，共同必需上游进入每一组，不新增领域汇聚节点或执行 step。候选输入可独立形成汇聚依赖，无需额外 ControlEdge；仅允许同一 If 两侧各一个来源并满足直接汇聚证明。仍拒绝不安全汇聚、普通单来源绑定直接读取互斥分支、嵌套 If 与不同 If region 交叉。Web 复用 Generic Node 编辑 string value、四种单条件和 true / false 命名控制出口；允许保存不完整 Draft，未知条件不静默改写。协议与能力限制见 [Node](node-model.md#if-条件节点与编译能力边界)。

## 生产 Runtime 装配

API 装配 Submission / Queue；Worker 装配 Consumer、Outbox Pump 和执行服务。执行服务核验持久意图，从 Run 派生项目 / 所有者，再创建有权限作用域的 Runner、Executor、能力和 Artifact 服务，不跨用户缓存。Node 类型说明由 Registry 提供，Catalog metadata 单独决定产品创建入口的暴露；服务对象不进入 State / checkpoint。

### Web 基础发布

dirty、修订冲突或保存未确认时禁止发布；发布锁定 Draft 编辑，不隐式保存或运行。当前保存修订的发布状态与最新版本分别展示，重复发布按 sourceRevision 找回版本，不拿 latest 猜测。目录刷新失败仍保留已确认身份；定位信息保留，但未实现自动聚焦或版本历史管理。

## Workflow Run HTTP API

| 方法与路径                                                  | 行为                                                                |
| ----------------------------------------------------------- | ------------------------------------------------------------------- |
| POST /workflow-runs                                         | 固定 workflowVersionId、invocationKey、inputs；受理返回 202         |
| GET /workflow-runs/:runId                                   | 安全 Run projection，含可选 outputs / error，不含 threadId          |
| GET /workflow-runs/:runId/execution-tree                    | 按 parent 只读一层 NodeRun 或 Child Execution；不执行、不修改状态   |
| GET /workflow-runs/by-invocation/:workflowId/:invocationKey | 授权 Workflow 下只读 lookup，返回 `{ run }` 或 `{ run: null }`      |
| GET /workflow-runs/:runId/pending-human-reviews             | 查询当前单个待审核产品对象；非 waiting 返回空 items                 |
| POST /workflow-runs/:runId/resume                           | 指定 interruptId / expectedWaitingRevision 与 V1 decision；202 受理 |

Start key 的等价性与终态保留规则见 [Workflow](workflow-model.md#start-invocation-身份)。入队确认失败返回 `WORKFLOW_QUEUE_UNAVAILABLE`（503），携带已持久化的 Run ID / key。lookup 不创建 Run / Outbox、不投递或执行；查无结果不能证明原 POST 不会稍后提交。

### Human Review 查询与恢复

[HTTP Contract](../packages/contracts/src/workflow/run/workflow-run-api.ts)的 Pending 响应为 `{ items }`，每项包含 opaque interruptId、waitingRevision、固定 WorkflowVersion 的 node id / name、纯文本 content、可选 instruction 与 submissionStatus（pending / submitted）。Run 非 waiting 返回空数组；没有通用 checkpoint inspection API，不返回 RuntimeValue wrapper、thread、task、namespace、NodeRunId 或完整 Definition。所有查询和提交均按 User → Project Owner → Run 授权，token 不能代替权限。

[产品服务](../packages/server/src/workflow/human-review/human-review.service.ts)在授权 Run 行锁内使用官方 Saver.getTuple 读取原 thread 的 head checkpoint，验证运行身份，并适配 LangGraph 1.5.0 的 INTERRUPT pending write。只接受 HumanReviewInterrupt V1 与 inline string；名称读取原版本，不读 Draft / latest。多个 pending interrupt 返回 HUMAN_REVIEW_CAPABILITY_UNSUPPORTED；未知 kind 或损坏 payload 返回明确的 HUMAN_REVIEW_INTERRUPT_UNSUPPORTED / INVALID（409），不伪装成审核。

POST `/resume` 的严格请求为 `{ interruptId, expectedWaitingRevision, value: { action: "approve" | "reject", feedback?: string } }`。旧裸 `{ value }` 不再属于产品 HTTP 协议；底层通用 Submission / Runner 仍供内部运行与测试使用。服务在同一 Run 行锁内验证 waiting、revision 完全相等、token 为当前 pending 审核，再原子写 Outbox。陈旧 token / revision 返回 HUMAN_REVIEW_STALE（409），不会创建恢复意图。

当前 revision 存在任意已持久化 resume intent 时 submissionStatus 为 submitted，包括投递未确认和 recovery_required；不暴露 Outbox 状态机、不允许修改已提交决策。沿用既有冲突语义：相同请求重复提交或不同 decision 均返回 WORKFLOW_RESUME_ALREADY_SUBMITTED（409）；Worker 已 claim 时可返回 Run 非 waiting 冲突。POST 202 不保证 Run 已变 running。投递 503 后可查询 Pending 确认 submitted，不能盲目再次提交。

Outbox 复用现有 value JSON，保存 `{ kind: "targeted_interrupt", interruptId, value: decision }`，waitingRevision 仍使用原列；无新增 DB / Job 顶层字段。Dispatcher 从持久化 Outbox 投递，Worker 校验 Job 与持久化 payload 完全一致后解包；Runner 验证当前 checkpoint 中的目标，再构造原生 `Command({ resume: { [interruptId]: value } })`。Runner 不解释 decision。通用单 interrupt 的兼容路径不用于正式 Human Review HTTP。

## Workflow Execution Queue

新 Run 与 start Outbox 同事务提交；resume 按 waiting 周期创建唯一意图。Job 不复制定义、State 或 thread。Worker 原子 claim 后执行，claim 前基础设施故障可重投，业务失败不自动重跑。

claim 后进程退出或结果不明进入 recovery_required；已完成或进入下一 waiting 周期时只补记意图，不重新 invoke。尚无 recovery_required 人工处理入口。队列配置和数据保留见[部署](deployment.md#workflow-执行队列)。

## PostgreSQL Checkpointer

API / Worker 启动时初始化官方 PostgresSaver，不提供内存回退。它与业务表使用同一 DATABASE_URL、独立连接池和 langgraph schema；初始化、备份与恢复见[部署](deployment.md#langgraph-postgresql-checkpointer)。

## 文本 AI 与 Provider Plugin

生产调用链是 Node → `text.generate` → ModelConfiguration → Provider Instance → ProviderCapability → Plugin → Provider API。节点只保存 modelConfigurationId，调用时重新验证 running Run、Run 项目权限、模型及 Provider Owner 与 enabled，再解密本次凭证；无默认厂商、自动替换或全局 credential 缓存。

| 插件                | 当前用途                                                |
| ------------------- | ------------------------------------------------------- |
| text_generation@1   | 正式 OpenAI / Anthropic 文本实现，SDK 只在插件内部使用  |
| openai_compatible@1 | 高级 Custom OpenAI-Compatible，可显式配置兼容地址与模型 |

两个插件关闭自动重试并隔离日志 / tracing，拒绝 redirect、空白、截断、过滤、工具调用等无效文本；成功正文包含本次实际 API credential 时以 `CAPABILITY_OUTPUT_INVALID` 拒绝，不返回正文、不重发。错误投影不带原始请求、响应或凭证。共用参数边界在[文本参数 Schema](../packages/plugins/src/text/parameters.ts)，各插件在此基础上收紧自己的配置。CapabilityInvoker 尚未透传取消信号，调用依赖插件 deadline。它们不构成通用媒体或内容安全框架。

## Plugin / Provider / 模型配置管理 HTTP

`GET /provider-plugins`、`/provider-catalog`、`/model-catalog` 返回安全目录。Provider / ModelConfiguration 归当前用户所有，管理入口为 `/providers` 与 `/model-configurations`；Owner 仅来自认证会话，创建请求不接受 projectId / ownerId。创建、列表、启停与凭证轮换见[管理 Controller](../apps/api/src/models/model-management.controller.ts)。绑定创建后不可改写；没有删除、远程插件安装或调用厂商 API 的模型发现。

官方 Provider / Model Catalog 随代码发布，当前为 OpenAI、Anthropic 及其预设文本模型；目录不是用户 ModelConfiguration。官方地址不由普通用户填写，自定义地址只属于高级兼容路径。凭证规则见[认证与安全](authentication.md#业务权限与密钥边界)。

## Web 用户模型设置

画布内复用同一抽屉配置当前用户的供应商、凭证和模型；所有自有项目（包括后续新建项目）共用，Query 缓存按用户 ID 隔离。Publish 在事务内按 Workflow Owner 校验模型 / Provider；Runtime 先核对 Run 的项目权限，再按相同用户身份读取配置并解密，不接受跨用户 ID 引用。节点从 Model Catalog 选择模型，仅写 modelConfigurationId；从节点进入供应商配置成功后继续原选择意图，取消不写入节点，设置页主动配置则留在设置。已选模型展示配置参数，不在节点另存。Secret 不回填、不进入 Form / Query 缓存或浏览器存储，请求发出及退出表单时清空；配置不触发生成。

[模型设置入口](../apps/web/src/features/models/model-settings.tsx)只负责用户身份和抽屉装配。`models/settings/` 管理查询、刷新、并发锁与表单会话；`models/catalog/` 展示供应商目录；`models/providers/` 维护供应商创建、管理和凭证轮换；`models/configurations/` 管理模型配置表单、列表及可用性；`models/shared/` 复用非秘密配置摘要，以及供应商与模型配置共用的 Schema 字段表单。凭证状态仍就近保存在各提交表单中，保持发送即清空、失败不回填的生命周期。

[模型选择入口](../apps/web/src/features/workflow/model-selection/model-selector.tsx)装配触发器和列表；`model-selection/selection/` 管理 Context、用户级资源查询、选择恢复与选项推导，`presentation/` 展示配置分组与目录状态，`configuration/` 处理明确的「添加并选择」。画布只依赖选择 Context，凭证表单不进入选择会话；配置恢复沿用原意图、可用性与显式选择规则。

## Web Graph Input 编辑职责

`workflow/inputs/definitions/` 提供 Root / Body 共用的输入定义操作、类型选项、名称校验和编辑控件；`inputs/bindings/` 负责本图 workflow_input 的绑定、重命名和兼容性清理。通用 Input 不依赖 Iteration。`iteration/inputs/` 只维护 composite、Body 输入、不变输入及 bodyInputMapping，依赖上述通用能力；原 Iteration 输入入口保留实例编辑导出。协议仍为 GraphInputDefinition / DataType / 原有 binding，修改范围与清理规则不变。

## Artifact 生产数据通道

PostgreSQL 保存身份与元数据，内容写 RustFS；只有 ready Artifact 可解析。内部 Runtime 可还原 JSON 或生成临时媒体访问资源，规则见[数据模型](data-model.md#artifact-与-asset)与[对象存储](object-storage.md)。Run 查询只返回 reference 身份，不 materialize、不签发 URL；Web 尚不能读取引用内容。Asset / Promote、自动对账与垃圾回收未接入。

## React Flow 数据适配

[Canvas 入口](../apps/web/src/features/workflow/canvas/workflow-canvas.tsx)只装配目录、viewport、节点添加和画布。`canvas/adapter/` 维护领域与 React Flow 的节点 / 边转换、绑定投影、Handle 协议及连线修改；[原适配入口](../apps/web/src/features/workflow/canvas/react-flow-adapter.ts)保留既有导出。`canvas/editing/` 负责来源替换 / 候选确认、Boundary 编辑与编辑上下文；`canvas/view/` 管理选择、测量和 Inspector 模式等页面状态；`canvas/rendering/` 放节点、边渲染及配套样式。

Inspector 的[入口组件](../apps/web/src/features/workflow/inspector/workflow-node-inspector.tsx)管理面板、标签和 Body 入口；`inspector/design/` 按节点类型编辑草稿，`inspector/runtime/` 展示真实 NodeRun、attempt、运行值与人工审批。二者继续使用原有 Context 与操作边界。

WorkflowDefinition 是唯一持久来源，React Flow 只管理视图；导出不保留 selected / dragging / measured。节点目录、创建与连接行为见 [Node](node-model.md)，界面约束见[前端规范](frontend-ui.md)。

候选输入以 `node.inputs[portKey]` 为唯一持久来源。[适配层](../apps/web/src/features/workflow/canvas/react-flow-adapter.ts)把每个来源投影为数据线，共用目标输入 Handle；通过 `data.projection = 'candidate-input'` 与真实 DataEdge 区分，禁止作为 DataEdge 导出。第二条数据连接复用确认弹窗，明确选择替换现有来源或添加候选；添加时移除原 DataEdge 并写入候选绑定。候选线通过删除后重新连接修改，不支持拖动重连端点。

删除候选线或来源节点只清理对应来源，剩余一个时保留候选 Draft，删光移除该 input binding。Save 直接发送 Definition，reload 从绑定重新投影，不生成真实 DataEdge。输入区域展示来源节点 / 输出端口名称及实际执行分支取值说明，不显示 JSON；候选不足提示补齐。Web 去重并限制新增至两个候选，只校验端点、Manifest 端口与基础类型；互斥和汇聚拓扑由 Publish / Compiler 权威验证，错误沿用发布面板展示。Template variable candidate、任意 N-way 和嵌套 If 编辑不在本版范围。

Template 的 `node_output` 变量也由同一适配层投影为数据线，以 `data.projection = 'template-input'` 标识；真实 DataEdge 不带 projection 标记。投影按 source node / source port / target node / target port 去重，alias 及正文不改写。用户直接插入变量即可建立可见依赖，删除最后一个对应 alias 后连线消失；投影不可直接删除或重连，须在输入编辑器中修改变量。Save / reload 仍只读写原有 Definition，所有输入投影均禁止导出为 DataEdge。

删除来源节点时统一清理相关 Template alias 及其正文 token，保留其他节点和 workflow_input 变量；无变量时保留剩余文字为 constant，文字也为空则移除绑定。此清理与 Candidate / 真实边及 Workflow 输出共用节点删除入口，不维护独立投影状态。当前 inputs 中只有 Template 与 Candidate 绑定可引用节点输出；constant、workflow_input 和 asset 不产生跨节点引用。依赖合法性继续由 Contract / Publish / Compiler 校验。

### Graph Execution Projection

[投影模型](../apps/web/src/features/workflow/runtime/graph-execution-projection.ts)区分发布版本中的 Definition Location、Graph Execution Instance 与 NodeRun occurrence / attempt。Root instance 是 WorkflowRun，直属记录要求没有 ChildExecution 归属且属于 root scope；Nested instance 是 ChildExecution，只接收 `childExecutionId` 精确匹配的直属 NodeRuns。先限定实例，再对本图局部 nodeId 分组；同名节点不能跨 graph / ChildExecution 覆盖。状态计算与 PendingHumanReview 沿用同一 `resolveWorkflowRuntimeNodes`；Canvas 选择逻辑、节点卡片和 Inspector 共享计算出的 map。审核等待只在 Root 合成，不将父图 PendingHumanReview 套到内部同名节点；Inspector 的历史 attempt 选择同时核对 occurrence 身份。

[查询上下文](../apps/web/src/features/workflow/runtime/use-graph-execution-projection.ts)按当前 Run 的 `workflowVersionId` 复用版本查询，核对 Workflow / Project 身份并保守比较完整执行定义，忽略节点 ui 位置和 JSON 对象键顺序；其他字段及数组顺序均须一致。Draft 修改输入、prompt、config 或图结构后撤下旧执行状态，返回 version_mismatch；位置移动不影响匹配。版本加载失败或缺失返回 unavailable，不借用运行表单中选择的其他版本。

Definition Canvas 下钻时，从已确定的父 graph instance 中找 owner 的唯一 occurrence，选其当前 attempt，再沿 Tree 的显式 parent 查询该 NodeRun 的 ChildExecutions。当前 `nestedGraphSlots` 只有唯一槽位，故可确定子图定义地址；不解析 scopeKey，不猜 invocationKey，也不全局搜索 nodeId。唯一 ChildExecution 自动解析；多个实例且调用方尚未提供选择时仍返回 ambiguous，并携带已完整读取的候选执行上下文。通用 `selectGraphExecutionInstance` 接收候选集合中的真实 executionId，继续沿相同边界投影 NodeRuns，不接受集合外 ID。没有执行返回 no_execution，多个 occurrence 返回 ambiguous，查询中返回 loading，无法确定版本或槽位返回 version_mismatch / unavailable。ambiguous 是待选择的上下文，不作为查询错误；未能解析的原因在 Canvas / Inspector 明确展示，no_execution 可按既有 idle 呈现。

ChildExecution 查询遍历全部 nextCursor 后判断数量，并检查分页 Run / Version / parent 归属、重复记录及游标循环。直属 NodeRun 复用已有完整、非分页的 `/node-runs` 查询结果，按显式执行边界过滤，保留 inputs / outputs / attempts；不从 Tree 摘要伪造完整 NodeRun。活动 Run 定时重新查询子执行，显式刷新同时更新 Run、版本与关联查询，切换 Run / Location 后旧响应不能覆盖新上下文。没有数据库迁移或新增 definitionRef，不改 Compiler / Runtime 身份；未来多 graph slot 不能用唯一槽位规则猜测关联。

[Iteration Item Selector](../apps/web/src/features/workflow/iteration/execution/iteration-item-selector.tsx)只负责 Body 执行上下文的选择。选项为实际 ChildExecution ID 与经过验证的 `metadata.index`，按 index 排序并显示 Item `index + 1`；缺失或重复 index、错误 kind 返回 unavailable，不按返回顺序或 scope 字符串猜测。0 Item 保持 no_execution，1 Item 直接解析且隐藏 Selector，N Item 默认选择最小 index。用户选择按 Run、Version、Definition Location、父 NodeRun attempt 隔离，只保留在当前页面会话；刷新及返回父图后再下钻时保留仍有效的 ID，所选 ID 消失才回退最小 index，回退后不会因旧 ID 再次出现而跳回。分页尚未读完时不提供部分候选。

Item 切换把 executionId 交给通用投影，使用已读取的完整候选和最新 NodeRuns 同步切换边界，不重新请求 Tree；Canvas 与 Inspector 一起切换 occurrence / attempts / 状态 / 输出。Inspector 历史 attempt 按 occurrence 隔离，不继承上个 Item 的选择。Selector 不创建虚拟 Item、独立运行状态或新的执行 API，不扩展 Item Retry / Resume、Body Runtime 或人工审核能力。

### Canvas 运行态与连线表现

节点状态仍由真实 NodeRun / PendingHumanReview 合成，经集中式 [runtime-presentation](../apps/web/src/features/workflow/runtime/runtime-presentation.ts)映射到 Canvas；不修改 Runtime Status 数据模型。画布不再显示状态胶囊或独立状态行，改为整节点边框、轻底色和标题区图标。running 使用青色边框、细 ring 与缓慢旋转图标及「正在执行」；waiting 使用琥珀色边框与手形图标、人工操作文字，待审内容摘要及现有 CTA 保留；failed 使用红色边框、轻底色和错误图标 / 文字；completed 仅保留低对比边框与小勾；idle 无可见状态标记，pending 仅有低权重时钟。选中轮廓与运行态边框独立，选中不覆盖等待 / 失败等语义色；Inspector 保留原有状态展示。

[连线渲染器](../apps/web/src/features/workflow/canvas/rendering/workflow-edge.tsx)复用 React Flow 的 getBezierPath / BaseEdge 和命中区域。DataEdge 在低对比底线上叠加 SVG 短划线，以 2.8 秒周期的负 stroke-dashoffset 表达 source → target；ControlEdge 使用低权重静态实线箭头。Template / Candidate 投影共用低强度数据流，以虚线底线和「模板」/「候选」标识区分，原有删除、重连与持久化规则不变。动画仅表达数据依赖，不表示实际传输或选中分支，不根据 DAG 猜测 Active Edge；Workflow 输出边界连线沿用原展示。减少动态效果偏好下关闭数据流 overlay 和运行图标旋转，静态边框、图标和箭头仍可识别。

### Web Workflow Draft 持久化

缺失 Workflow 时显式初始化，不用本地空图兜底。草稿允许未完成配置；保存失败保留编辑，冲突后经用户明确操作重读对应资源，不覆盖另一类未保存内容。Draft 修改不影响已发布版本及已有 Run。

### Editor session 离开保护

Editor 统一保护 dirty Draft、项目修改、进行中的保存 / 重载 / 发布，以及 submitting / uncertain Start；返回项目、账户和 Logout 共用确认，Logout 确认后才执行。clean 但未发布、已受理的 pending / running 不单独阻止离开。

unsafe 注册标准 beforeunload，safe / 卸载时解除。不改写 Router / history；同文档历史切换、崩溃或强制关闭不保证触发。明确授权失效时仍遵守原隐藏 / 跳转边界。

### Web invocation identity recovery

每个 invocation 在 localStorage 独立保存严格 metadata receipt，key 按格式版本 / user / project / workflow / invocationKey 隔离。只保存固定版本、创建时间与可选 Run ID，不保存 inputs、完整 request、凭证、URL、异常或 outputs。冻结合法请求后同步保存，成功才 POST；失败明确提示尚未发送，不回退 memory-only。

页面重进只读 lookup，核对 workflow / version / key / 已知 Run ID 后复用 Status tracking。未找到、冲突或查询失败时保留身份，可重新查询，不自动 POST / 换 key；存在未确认身份时，用户确认新旧请求可能同时执行后才发起独立 Run。accepted / queue uncertainty 补写失败不重发，旧 uncertainty 不被后续一次 4xx 消除。

确认 completed / failed / cancelled 后先由页面持有 Run，再自动清理 receipt；waiting 保留。清理不清空当前页面，但下次重进不依赖已删除的终态 receipt 自动发现历史。多 Run 不覆盖，storage event 只同步集合，不当锁或跨 Tab 自动提交。Logout 成功清本用户并失效晚到写回，失败保留；存储清理失败明确提示。离开保护仍保留，找到当前错误请求的 Run 后解除旧 uncertainty。

### Node Catalog 产品暴露

NodeRegistry 负责 Runtime 类型声明与实现；独立 NodeCatalog 负责产品创建条目；WorkflowDefinition 只持久化标准实例。`NodeCatalogEntry` 包含稳定 `id`、显示 `metadata`、产品 `category`、`exposure`、精确 `target: { type, version }` 与纯数据 `creation: { config?, inputs?, composite? }`。Entry ID 不充当 Runtime 类型身份，多个 Entry 可以 target 同一类型版本。生产条目随部署显式装配；新增 Runtime 注册不会自动生成 Entry。

| Entry ID             | Runtime target        | 暴露     | 产品分类   |
| -------------------- | --------------------- | -------- | ---------- |
| `text-generation`    | `ai.text_generate@1`  | public   | AI 能力    |
| `text-formatting`    | `data.format_text@1`  | internal | 数据处理   |
| `human-review`       | `flow.human_review@1` | public   | 工作流控制 |
| `conditional-branch` | `flow.if@1`           | advanced | 工作流控制 |
| `iteration`          | `flow.iteration@1`    | internal | 高级能力   |
| `subworkflow`        | `flow.subworkflow@1`  | internal | 高级能力   |

`GET /api/v1/workflow/node-types` 继续返回完整 Runtime Manifest，供已有节点渲染、Inspector、端口及 nested graph 编辑使用。Manifest 保留 Runtime 类型版本、端口、配置字段、executionKind、capabilities 与显示信息，不包含产品 exposure 或完整 GraphDefinition。独立 `GET /api/v1/workflow/node-catalog` 返回 Entry；两者均认证、no-store。Catalog 装配校验唯一 Entry ID、精确目标版本与实例 contract，返回独立数据副本，不公开服务实现。

Web 普通 Picker 使用 `isNodeCatalogEntryVisible` 只显示 public，并按 Entry ID 选择；创建回调重新查找当前条目及其精确 target Manifest，继续叠加 Body 等局部图能力约束。两份查询独立，Entry 失败只禁用创建，已有节点仍使用完整 Manifest 编辑。advanced surface 策略可表达 public + advanced，当前没有模式切换 UI；internal 不供普通 Picker 创建。`data.format_text` 用于确定性 Runtime / 验收，不在普通 Picker 展示。

共享 `instantiateNodeCatalogEntry` 负责创建标准 NodeDefinition：Manifest 配置默认值由 Entry config 显式覆盖，inputs 来自 Entry（缺省为空），composite 来自 Entry；调用方只提供实例 ID、位置与可选名称覆盖。完整输入数据经深复制与既有 NodeDefinition contract 校验，子图 copy-on-create 后归当前父 Draft，来源与不同实例不共享可变数据。Entry 后续变化不更新已有节点；实例不保存 Entry ID 或来源引用。Draft / Publish / Compiler / Runtime 继续使用已有协议与能力门禁，不读取 Catalog。

已有 Iteration / SubWorkflow 可继续加载、选择、Inspector 编辑、进入嵌套图、保存与发布。没有数据库 Template / TemplateVersion、共享子图引用或真实业务 Composite Entry；也未开放 Iteration → SubWorkflow 等嵌套执行能力。

领域无关的 AI 文本 Composite 实例化样例仅保存在 [test fixture](../packages/server/test/fixtures/ai-text-composite-entry.json)，不注册到生产 NodeCatalog，不进入 Catalog API 或普通 Picker。`internal` 是产品暴露策略，不是测试样例存储。测试条目以 `flow.subworkflow@1` 为 target，copy-on-create 的 graph 声明 `text:string` 输入、一个 `ai.text_generate@1` 和 `result:string` 输出；prompt 绑定局部 `workflow_input.text`，system 是摘要指令，模型配置为空，由用户在实例的正式模型选择器中补齐 `modelConfigurationId`。实例继续使用普通 Draft / Publish / Compiler / Capability / Plugin 协议。

### Web Human Review

正式目录中的 `flow.human_review@1` 沿用通用节点选择器与 Manifest Handle，不过滤 interaction。节点内设置支持名称（失焦或回车提交）、静态 instruction；content 复用现有文本 / Template / Candidate / DataEdge 输入机制，三个业务输出可连接下游，没有审批专属控制出口。设计配置只写 Draft，执行审批只在 Run 面板进行。

[Run 状态控制器](../apps/web/src/features/workflow/run/status/workflow-run-status.ts)在 waiting 时读取 Pending API，仅展示单条审核。卡片展示节点名称、审核说明、纯文本内容和可选反馈；通过 / 拒绝提交当前 opaque token、waitingRevision 与 decision，不展示这些内部身份。合法 reject 不被前端解释为运行失败。

提交中和 submissionStatus=submitted 禁止再次决策。POST 后只重读同一 Run / Pending，不创建新 Run；网络结果不明或 409 不自动 replay，按服务端 pending / submitted 恢复操作能力。查询失败撤下旧卡片，手动刷新后再确认；旧查询 / POST 响应受 Run generation 隔离，旧审核回调必须匹配当前 token 与 revision。新审核清空旧反馈。普通 pending 审核停止高频 Run 轮询；submitted 或 waiting 查询暂时返回空 items 时沿用原有单一 timer 确认进展，running 恢复常规跟踪，completed / failed 进入既有结果 / 失败视图。面板关闭不卸载页面级状态与请求。多个 Pending 或后端 capability 错误明确展示，不在前端猜测拓扑。

### Web Workflow Run Inputs

[Run Form](../apps/web/src/features/workflow/run/workflow-run-controls.tsx)从明确选中的已发布版本读取 Graph Input 声明，以 DataType 驱动文本、数字、布尔、文本列表与数字列表控件，不依赖名称、连接目标或 Iteration。列表从空数组开始，按项添加、删除并保留顺序，不要求手写 JSON。scalar text 保留原文与空字符串，number / boolean 保留 0 / false；原有 scalar nullable 与不支持类型的拦截行为保持。

[提交转换](../apps/web/src/features/workflow/run/workflow-run.ts)继续生成现有 inline RuntimeValue 与 Start 请求。required 列表至少一项；文本列表逐项拒绝空字符串 / 纯空白，其他文本原文保留。数字列表逐项校验十进制数字文本并转换为有限 number，拒绝空值、NaN、Infinity 与非法项，不通过过滤或填 0 修复。任一无效项阻止整个请求。optional 未勾选「提供此输入」时省略字段；明确提供的空列表按实际值提交 `[]`，不制造空白项，不改变后端 optional 语义。输入由页面级 Hook 持有，切换版本重置，提交中锁定增删与编辑。

### Web Workflow Run Result

Editor 的[执行工作区](../apps/web/src/features/workflow/editor/workflow-execution-workspace.tsx)以紧凑工具栏和可收起的右侧面板承载运行；宽屏并排、窄屏覆盖，配置与状态 / 结果分标签，长内容在面板内滚动。打开面板不会发起运行，关闭不清空输入或停止状态跟踪；受理后切到状态页，正常响应不强制重开已关闭面板。技术 ID 按需展开；保留未确认请求与其他可恢复 Run 的入口。

现有状态面板仅在 completed 时从 `runStatus.run.outputs` 逐项展示结果；不读取 Draft、Node 中间输出或另发 Result 请求。字符串保留换行并按普通文本显示，number / boolean / null 原值展示，array / object 使用格式化 JSON。空字符串有独立提示；`{}` 显示「此运行没有工作流输出」，缺失 outputs 显示「运行结果不可用」。

reference 只展示类型、kind 与 ID（Asset 包含版本），提示暂不支持预览，不生成 URL 或读取内容。Recovery 复用同一状态与 Result 展示；终态 receipt 清理不清空当前页面结果。其他 Run 状态不展示最终结果，failed 保留安全错误。

### Web Execution Tree 浏览

[执行工作区](../apps/web/src/features/workflow/editor/workflow-execution-workspace.tsx)的「状态与结果」在现有 Run 状态下增加只读执行过程。[浏览器](../apps/web/src/features/workflow/run/execution/execution-tree-browser.tsx)调用 `GET /workflow-runs/:runId/execution-tree`，只读取当前 parent 的一层；打开 Run 不递归加载整棵树。NodeRun 先查询 `parentType=node_run`，没有 Child Execution 时留在当前层并显示「无子执行」，不进入空层。Child Execution 用返回条目的 `type` 与 `id` 作为下一层 parent。面包屑保存每一层 parent 和进入时的显示名；返回上一级与点击上级都使用这条 parent。手动刷新只来自状态面板的刷新按钮，不跟随运行状态的定时查询，也不另建轮询。

`metadata.index` 为非负整数时显示 `#n`，不读取其他 metadata，也不展示 child execution、occurrence 或 Run 的持久化 id。状态复用 [runtime-presentation](../apps/web/src/features/workflow/runtime/runtime-presentation.ts) 的 running / completed / failed 文案。failed 且 DTO 带 error 时只读展示 message、stage 与 code。同一层不按 nodeId 合并 attempt。`nextCursor` 非空时追加下一页。列表直接使用 DTO 状态，不把 Human Review 的 waiting 合成进这一层；根画布仍按原规则合成。

节点名称来自与本次 Run `workflowVersionId` 一致的已加载版本定义：沿 composite body 按 nodeId 收集名称，仅在名称唯一时使用，否则显示「节点」。这不建立执行归属。[Tree 摘要投影](../apps/web/src/features/workflow/run/execution/execution-browse.ts)保留 NodeRun 的 id、nodeId、occurrenceId、attempt、status、parent 与 error。Tree 浏览仍为独立只读视图，不提供点击条目直接打开 Definition Canvas；Canvas 下钻中的唯一实例关联由 [Graph Execution Projection](#graph-execution-projection)负责。ChildExecution 没有持久化 definitionRef 或图路径，不提供 Retry、Resume、Cancel 或结果修改。

## 目录与依赖

| 目录                                 | 职责                                                                                                                                                                      |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| apps/web                             | Editor、账户 / 项目 / 模型管理；Workflow 按 editor、canvas、node-catalog、inputs、model-selection、publish、run 组织                                                      |
| apps/api / apps/worker               | 认证 HTTP 与提交 / 持久投递与执行                                                                                                                                         |
| packages/contracts                   | 无框架依赖的 JSON 协议和 Schema                                                                                                                                           |
| packages/workflow                    | 领域校验、编译、执行。definition 管静态语义，compiler 管编译与执行能力门禁，runtime 管执行原语、运行值和执行归属端口，run/submission 管受理与 Runner。内部分工见包 README |
| packages/server                      | 授权 Repository、基础设施和生产装配。workflow 内 node、run、runtime、human-review、execution-tree、queue 分责，见包 README                                                |
| packages/plugins / packages/database | 受信任插件（plugin 注册、catalog 目录、text 实现）/ Prisma 模型与迁移                                                                                                     |

run 内部区分 status、result、recovery 与 execution。execution 只读取 Execution Tree，并把当前层 NodeRun 保留为可投影结构；跨职责 API 留在 Workflow 根目录。已实现模块按领域归类，不按技术类型机械拆分，不保留重复入口。`packages/context` 仍为空入口。
