# 实施方案

仅维护当前工作和待决策项；能力、接口与限制以[当前架构](architecture.md)为准。规划不构成实施授权。

## 当前阶段

Canvas / Adapter / Node Inspector、通用 Input / Iteration 输入、模型设置与模型选择的职责拆分进入结构与交互验收；目录边界见[开发指南](development.md#前端职责目录)，实现入口见[当前架构](architecture.md#web-graph-input-编辑职责)。保持现有协议、提交与显式选择规则，只调整 Web 模块组织。Template 编辑器、Editor 项目元数据会话、后端模型服务与发布校验的集中职责留待后续分别处理，不与本轮通用输入和模型管理迁移混改。

Root Workflow Input → Boundary → Iteration.items 与 Run Form 数组提交等待人工验收；范围见[当前架构](architecture.md#web-workflow-run-inputs)。待人工检查文本 / 数字列表增删、实际提交、Body 映射与数组输出，以及草稿保存重开。Web 人工验收不创建验收 Workflow，不运行浏览器 E2E 或真实 Provider。

Human Review 第五阶段已接入现有 Run 面板的单个文本审批闭环，等待人工 Canvas / Run 验收。能力与限制见[当前架构](architecture.md#web-human-review)。本轮不运行 Browser E2E 或 Provider。

Canvas 小范围视觉优化待人工验收：运行焦点、人工等待、失败辨识、多个完成节点的安静程度，以及大量 DataEdge 的方向流动强度、ControlEdge 静态表现和投影标识。实现范围见[当前架构](architecture.md#canvas-运行态与连线表现)，不扩展 Editor 功能或执行语义。

Iteration 单 item 持久化与通用 Execution Tree 只读查询进入交付验收；能力与约束见[当前架构](architecture.md#execution-tree-只读查询)。后续 Web 运行树、单 item retry / resume、通用 scope 持久化及嵌套 Iteration 执行仍需独立任务。

## 待决策与后续边界

- Workflow Web 数据依赖可视化仍待人工 Canvas 验收；Template variable candidate、Switch / N-way 和 Nested If 不在当前授权范围。

- Runtime 运维：recovery_required 人工处理、业务记录 / checkpoint 对账、运行删除与保留策略；[独立实验](../experiments/langgraph-iteration-runtime/README.md)已复现 LangGraph 1.5.0 maxConcurrency=1 异常，依赖处理方案待独立评审，本轮不升级或绕过。
- Human Review 分支区域内审核、并行 pending、子 scope 的定义 / 版本 / 权限绑定待独立设计；嵌套 Iteration、Batch、SubWorkflow 及简单 If 之外的条件拓扑不能直接沿用当前技术预算公式。
- Artifact 内容 HTTP、Asset / Promote、媒体能力、Tool / Agent 和上下文构建均待独立任务；声明或测试夹具不代表产品已交付。

## Execution Tree 演进设计

本节是基于[当前执行归属审计](architecture.md#execution-归属审计)的后续持久化推荐设计；只读查询已交付，见[当前架构](architecture.md#execution-tree-只读查询)。通用 scope、迁移和新 Composite 尚未实施，本方案不构成授权。现有 IterationItemRun、NodeRun 归属字段、checkpoint 与 schema 保持不变。长期遵循[业务解耦原则](platform-model.md#workflow-通用性与业务解耦)，复用身份和审计，不另建调度器。

### 结论与模型定位

推荐 **C：IterationItemRun 最终作为 Iteration-specific extension / projection，底层执行归属使用通用的子图调用实例**。下文暂称该实例 ExecutionScope，命名表示实际调用的持久化身份，不等于已经确定新表或必须直接新增 NodeRun.executionScopeId。

A 保留每种 Composite 独立正式运行聚合，短期可以工作，但会让 NodeRun / Executor / Repository / 查询协议逐种增加归属字段。B 完全消除 Iteration 专属表达，则会把 index、集合快照位置和聚合语义挤进通用层。C 保留这些必要语义，让执行归属、父链、状态与查询统一；是否保留 extension 表或仅保留 projection，应由实际查询和约束需求决定。扩展中不再独立维护一份父链、status、时间和通用错误；这些必须有唯一权威来源，不能长期双写两套生命周期。

### 通用归属与定义定位

目标树以实际执行事实为依据，支持任意深度的交替归属；不从 DAG 连线、日志、数组顺序或 LangGraph namespace 猜测。

```text
WorkflowRun
└─ Root Scope
   └─ NodeRun（属于该 scope 的 occurrence 的一次 attempt）
      └─ Child ExecutionScope（由这一次父 NodeRun 发起）
         └─ NodeRun
            └─ Child ExecutionScope
               └─ …
```

建议最小通用语义如下；字段名是设计用语，实施前再固定 Contract / schema。

| 概念                               | 推荐边界                                                                                                                                                                               |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 持久化 id、workflowRunId、项目归属 | 服务器创建的执行身份与授权边界；不能以 nodeId / index 或显示名替代                                                                                                                     |
| ownerNodeRunId                     | 子调用关联具体父 attempt；对应当前 iterationNodeRunId。不同父 attempt 不共享子执行实例                                                                                                 |
| parent scope                       | 由 ownerNodeRun 的 occurrence 归属确定；若物化 parentScopeId，必须约束它与 owner 一致，不能维护两套可变父链                                                                            |
| slot 与 invocationKey              | 父节点内子图位置与稳定的局部调用 key；同一 owner / slot / key 重入复用，具体 index / key 如何产生由 Strategy 负责                                                                      |
| root scope                         | 每次 WorkflowRun 一个明确根作用域，无 owner；未来持久化方案确定前，查询层可将现有 root sentinel 投影为根，不能宣称已有 root 表；根状态直接读取 WorkflowRun，不另维护一份 root 生命周期 |
| scopeKey                           | 当前的兼容身份材料，迁移中保持稳定；不解析哈希，不替代持久外键、权限或定义地址                                                                                                         |
| definitionRef                      | 被调用图的固定 workflowVersionId 与 nodeId / graphKey 路径，复用 GraphDefinitionLocation；调用身份与定义身份分离                                                                       |
| status、时间、安全错误             | 子调用复用现有 NodeRun 运行状态与错误边界；只做执行事实记录，不通过 scope 状态重建暂停 / 恢复状态机                                                                                    |

跨项目 SubWorkflow 必须另外解析并授权目标的不可变版本；Root WorkflowRun 的版本与调用目标版本是两件事。持有 scopeId 或能遍历树不授予目标项目、凭证或 Artifact 的权限。版本与权限绑定不能仅由元数据或 scopeKey 传递。

NodeOccurrence 已是逻辑节点的身份权威，建议将通用 scope 归属首先落在 occurrence，保留 NodeRun → occurrence → scope 的关系。NodeRun context / DTO 可以统一提供 executionScopeId；如果为查询增加 NodeRun 直接外键，也必须由复合约束保证与 occurrence 一致，不成为第二套独立归属。不要简单叠加 executionScopeId 与 iterationItemRunId / subWorkflowRunId / loopRunId / batchRunId，也不要用一个无外键的 ownerType / ownerId 多态字段替代明确的 scope 关联。

NodeOccurrence 的唯一性仍表示同一图调用中的局部 nodeId，NodeRun attempt 仍只表示该逻辑节点的尝试。resume 复用原调用身份；显式重新调用与新父 attempt 创建新的子调用身份。当前 item index 不是 attempt，也不能独自充当跨重试的全局身份。未来单 item retry 如何区分新的调用、复用的逻辑 item 和 NodeRun attempt，需单独确定协议；本设计不通过终态回滚或新增 retry 状态提前实现它。

### Metadata 与专属 extension

| 信息           | 归属与约束                                                                                                                                           |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| kind           | 可有 `iteration_item`、`subworkflow_call` 等受控的结构种类 / extension 标识；核心用同一父子协议处理，不逐种硬编码详情或业务路由                      |
| key            | 只有经 Strategy 定义为稳定 invocationKey 的 opaque key 参与身份；Episode ID、显示名或可变 item 内容不能隐式作为引擎 identity                         |
| index          | Iteration 的固定快照位置；留在有类型的 Iteration extension，查询可投影通用 ordinal。Loop 的轮次、Batch 的分片序号须各自定义，不共享 index 的全部语义 |
| label          | 可选显示提示，不参与身份、排序、授权、调度或恢复；“第几集 / 第几章”等业务标签由业务节点、模板或显示适配提供，Runtime 不推断                          |
| metadata       | 仅在有实际需求时增加受 Schema、版本、命名空间和体积限制的结构化 extension，按权限投影；不放凭证、完整 item、二进制、大 JSON 或内部 checkpoint 信息   |
| 输入输出与素材 | 沿用 RuntimeValue / Artifact 引用；Tree 摘要不无条件复制 payload，也不新建一套内容存储                                                               |

通用 scope 负责身份与生命周期，Iteration extension 负责固定集合 index、已存在的快照 / 输入映射的解释和聚合关系。没有查询需求的元数据字段不预建；未知 extension 不阻止核心按显式 parent 遍历。

### 生命周期、控制流与观测

独立 Strategy 决定何时调用子图、选多少 item、怎么聚合，以及子失败是否传播到父节点。当前 ItemRun Repository 把 item 失败与父失败写在同一事务，符合现有 Iteration fail-fast 语义；长期通用记录接口不能对所有 Composite 隐式采用这一政策。需要原子记录多个结果时，由明确政策的调用方请求通用事务操作，不让 Repository 按业务名称决定策略。

共享层可复用授权、幂等创建、不可变归属、终态保护、完成 / 失败记录与安全摘要。普通异常与仓储异常保持既有分界；GraphInterrupt / ParentCommand 原样交回 LangGraph，当前 scope / NodeRun 保持 running，WorkflowRun waiting 与恢复 token 仍以现有 checkpoint 协议为准。不要为树展示自行增加 interrupt 状态、复制 checkpoint 表或轮询 scope 驱动调度。

Run Tree 是领域审计的查询投影，不是 LangGraph task tree，也不是新的运行真相。按 scope 隔离尝试和状态；父状态由实际记录 / Strategy 政策给出，不能简单以所有后代状态做统一 reduce。部分子执行完成、其他失败或仍 running 都必须原样表达。If 等仅路由而没有子图调用的节点不强制生成 Child Execution；未执行分支、空集合和无子图的批量 API 也不制造虚构 child。

Retry / Resume 将来复用这套身份、授权、审计及查询骨架，执行与 checkpoint 路由仍归原引擎和明确策略。审计与 checkpoint 不构成跨系统原子提交；崩溃 / 受理不明仍需 recovery_required 与对账，不能因树中存在 failed / running 记录就自动重放收费调用。当前 Human Review 的根 checkpoint 查询及单 pending 门禁不能据此宣称已支持 nested resume。

### 已交付的查询边界

通用 DTO、当前 Prisma source adapter 与统一只读 HTTP 查询已实施，字段、权限、逐层分页、错误及限制只维护在[当前架构](architecture.md#execution-tree-只读查询)。后续通用 scope 迁移必须维持该 DTO 的稳定身份与显式父子关系；不能把存储类型、scopeKey 或 checkpoint token 重新带回查询协议，也不能要求 Web 改成逐种 Composite 查询。

### 渐进迁移顺序

1. 只读 Run Tree DTO 与投影已经实施，以现有记录验证了通用查询边界；后续持久化演进从下一步开始，不借查询入口改写记录、建立替代调度或开启新 Composite。
2. 再独立确定通用 scope 的持久化 Contract / schema、root 身份、定义定位与 Iteration extension。新增前验证 owner、scope、occurrence 的同 Run / 项目一致性和无环父链；保留现有 ItemRun ID 或建立明确的一对一映射。
3. 迁移 root 与现有 ItemRun：root occurrence 归到所属 Run 的根 scope，Body occurrence 通过 Run / scopeKey 与 ItemRun 的已有精确关系映射。保留 NodeRun / occurrence / attempt / Artifact ID 和内容、输入输出、时间与错误；index 保留在 extension，不从日志或数组重新猜身份。过渡数据写入须可核对且有单一权威，不能长期维护两份独立生命周期。
4. 将通用 Executor context、CreateNodeRunInput、Repository 外键校验及记录错误切换为中立 scope 归属；Iteration Strategy 通过 adapter 提供 index 等专属信息。query adapter 改读新归属，但统一 DTO 与旧接口兼容投影不变；再逐个收敛旧专用字段。
5. 删除旧字段 / 存储前，先核对活动 Run、可恢复 checkpoint 与部署的 Compiler / Worker 版本。保留或显式映射 checkpoint 中父 NodeRun / ItemRun / scopeKey 身份；不改写 WorkflowVersion。缺失这些身份的旧 checkpoint 不凭位置回填，继续走既有恢复边界。只有迁移与恢复验证完成后才移除兼容投影，每个阶段单独授权。

### 下一步最小独立实施任务

**实现 Web 通用运行树的只读浏览。** 复用现有 Execution Tree DTO 和逐层分页入口，按显式父引用展开 NodeRun / Child Execution，显示各自真实状态和 attempt；不按 Iteration 存储类型选择查询，不解析 scopeKey，不从数组或 DAG 猜执行事实。范围仅限读取与浏览，不增加 Retry / Resume、执行写入口、新 Composite 或 schema 变更。需独立授权后实施。
