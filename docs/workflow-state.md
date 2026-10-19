# WorkflowState 边界

本文承接本轮 WorkflowState 讨论，维护已确定的职责与核心结构方向。**当前没有最终 RuntimeValue、完整 WorkflowState Schema、生产 reducer 或 Binding Resolver。** WorkflowRun / NodeRun 本轮只补充共享契约，不创建数据库表或运行服务；实际实现见 [当前架构](architecture.md)，下一步见 [实施方案](implementation-plan.md)。

## 生命周期与职责

| 对象                         | 回答的问题           | 保存范围                                         |
| ---------------------------- | -------------------- | ------------------------------------------------ |
| WorkflowDefinition / Version | 流程如何生产         | 静态节点、配置、Binding、控制关系及输入输出契约  |
| WorkflowRun                  | 这是哪一次运行       | 业务运行身份、明确版本、独立 threadId 与状态记录 |
| WorkflowState                | 图执行到此处需要什么 | 当前执行必需的值、引用及最小控制信息             |
| NodeRun Store                | 节点经历过什么       | 执行历史、快照、错误、耗时、模型与成本等业务记录 |
| Asset / Artifact Store       | 持久内容在哪里       | 具有独立生命周期的内容及其版本化引用             |
| Checkpoint                   | 如何恢复图           | LangGraph thread 的执行快照，不替代上述业务记录  |

State 不收集整张数据库、用户资料、日志、全部素材与历史。Definition、Run、State 和内容产物各有生命周期；同一项结果可能被执行快照引用、被 NodeRun 记录、作为内容对象持久保存，不能因此用其中一层替代其他层。[官方 Persistence](https://docs.langchain.com/oss/javascript/langgraph/persistence) 说明 checkpointer 的 thread 级执行状态职责。

## 五个核心分区

下表是已确定的建模方向，不是已导出的 TypeScript 接口或最终值协议。

| 分区      | 职责                                                    | 更新边界                                                   |
| --------- | ------------------------------------------------------- | ---------------------------------------------------------- |
| run       | workflowId、workflowVersionId、workflowRunId、projectId | 执行期间不可变，不放 status、progress、NodeRun 或日志      |
| inputs    | 启动本次运行时明确提供的 Workflow 输入                  | 本次执行期间视为不可变，workflow_input 从此解析            |
| outputs   | 按 nodeId / outputKey 组织的当前有效输出                | 不同节点的增量按节点键合并；不保存全部历史                 |
| variables | 显式声明的工作流作用域变量                              | 不成为所有节点随意读写的隐式依赖容器                       |
| execution | 确实影响图行为的最小控制状态                            | 后续按具体语义定义更新规则，不放进度、耗时、成本或完整事件 |

不可变是平台执行边界，尚未实现对应 State 初始化或更新校验。普通数据传递优先 Output → Binding → Input；variables 的初始化、读写权限与 reducer 仍待明确，本轮不增加变量 Binding 或全局变量服务。execution 可为后续显式批量、分支或子流程保留必要控制信息，不提前实现它们。

## 当前输出、并行更新与历史

outputs 以 nodeId 为一级键、节点声明的 outputKey 为二级键；它是当前节点结果集合，不等于 WorkflowDefinition.outputs 的最终暴露契约。不能将 script、characters、images 等业务字段直接固定在顶层 State。connection 的方向已确定为读取对应节点与输出键，实际解析仍需 RuntimeValue 与引用协议。

不同节点并行完成时，各自只提交自身结果。outputs 的 reducer 应按节点键合并这些独立更新，不能由默认整对象覆盖丢失其他节点结果。LangGraph 并行更新的顺序不保证；reducer 必须根据数据语义设计，不能依赖最后到达者。[官方并行说明](https://docs.langchain.com/oss/javascript/langgraph/use-graph-api#run-graph-nodes-in-parallel) 及 [Graph API reducers](https://docs.langchain.com/oss/javascript/langgraph/graph-api#reducers) 提供底层机制。

按节点合并只解决不同节点键的冲突。相同 nodeId 的并发分支不能盲目覆盖；必须先明确分支身份、收集与当前有效结果的选择规则。现有 Send 测试不等于已经实现这些平台语义。

节点先后产生新结果时，State 只保留当前有效输出；旧结果、失败记录、模型、token、耗时与成本进入 NodeRun 等业务历史。当前有效结果的切换、下游失效及恢复一致性尚未实现。讨论中的“改写 → 审核 → 改写”仅说明历史与当前值的区别，不授权任意循环、递归或绕过当前 DAG 约束。

## NodeRun 契约与持久化范围

NodeRun 契约增加必填正整数 attempt，用于后续明确区分节点执行记录；输入输出改为可选 inputSnapshot / outputSnapshot，尚未取得值时可省略快照。快照当前仍是 JSON record，不是最终 RuntimeValue。Schema 不分配 attempt、不创建记录，也不把每次函数重入自动当作新 attempt。

LangGraph 的中断、重试可能使节点函数从开头重跑，副作用必须遵守幂等与操作标识边界；业务 attempt 与函数调用次数不是同一概念。Send 分支也可能共享 nodeId，未来仅用 workflowRunId / nodeId / attempt 不一定足以标识每个分支，需随批量与分支模型确定。[官方重入与幂等说明](https://docs.langchain.com/oss/javascript/langgraph/graph-api#re-execution-and-idempotency) 解释原生重执行行为。

JSON 校验只能确认可序列化形状，不能禁止 base64 字符串、大文本，或保证脱敏、资产可访问与引用版本正确。本轮尚未实施快照大小、内容引用和安全策略，不能把通过 Schema 当作已经满足这些要求。

NodeRun Store 与 WorkflowRun 持久化暂缓：Workflow 版本发布与保存、资源权限、分支身份及状态投影一致性未定。孤立的空表不能替代可用 Store。当前没有 Run / NodeRun 数据库表、写入服务、执行历史或成本统计功能。

## 值的语义与承载方式

Image、Video、Character、Script、Shot[] 描述语义类型；inline / reference 描述值如何承载。两者是不同维度，不能将 asset_ref 当作 image 的替代 DataType，也不能先用任意 unknown 填完所有运行值接口。

小型值和必要领域元数据可以考虑内联；图片、视频、音频、文件及大型持久文本、文档应通过引用进入 State。禁止将二进制、Buffer 或 base64 媒体本体塞入图状态。大型小说与文档也不能因其是字符串就反复装入 checkpoint；具体阈值、引用结构与读取方式待值和内容模型设计。

```json
{ "kind": "asset_ref", "assetId": "asset_123" }
```

上例仅表达“以引用承载内容”的方向，**不是最终引用协议**。图片 / 视频仍须满足版本化资产引用约束；只有 assetId 的现有 AssetBinding 也不代表已经固定产物版本。不能用示例省略版本来弱化不可变运行的要求。

URL 是读取或预览入口，不是内容身份。后续应由有权限的资产服务按明确引用解析存储位置与临时访问 URL，不将供应商地址、签名 URL 或本地路径当作长期产物标识；相关服务尚未实现。

Asset 应覆盖可持久引用的内容，范围不局限媒体。Document、Character、Scene、Script、Storyboard 等只是待讨论的内容与领域方向；Asset、Domain Object / Entity、Artifact 的职责和版本关系尚未最终确定，不将它们全部提前建模成同一种资产。

## Thread、人工介入与审计

WorkflowRun 保留独立必填 threadId，映射到 LangGraph configurable.thread_id。它可以由创建运行的服务选为与 Run.id 相同的值，但契约不要求相等，也不在缺失时推断。createWorkflowRunConfig 使用 run.threadId，并拒绝调用方传入冲突 thread；当前不创建线程或运行。

恢复使用同一 threadId、原不可变 WorkflowVersion、兼容编译实现与持久 checkpointer。thread_id 是执行定位，不是资源权限；知道该值不能授权读取或恢复。根线程、子流程线程的关联与生命周期仍待实现。

人工介入继续使用 LangGraph interrupt / Command.resume；WorkflowRun / NodeRun 的 waiting 是业务投影，不驱动第二套恢复状态机。未来 HumanReviewRecord 保存 reviewer、decision、feedback、createdAt 和 nodeRunId 等审计关联，独立于 checkpoint，不能从一份 State 快照替代审计。当前没有 HumanReviewRecord、审核 API 或持久化审核服务。[官方 Interrupts](https://docs.langchain.com/oss/javascript/langgraph/interrupts) 说明同 thread 恢复及节点重入规则。

## Send 与子工作流

全局 WorkflowState 与 Send 的局部输入分离。每个动态分支通过自己的 episode / item 等上下文工作，不能争写全局 currentEpisode；结果按明确身份和 reducer 汇总，不按并发完成顺序覆盖同一个节点键。[官方 Send](https://docs.langchain.com/oss/javascript/langgraph/graph-api#send) 支持向下游传入各分支局部 State。

子 Workflow 按固定版本与显式 Input Mapping / Output Mapping 组合，不直接共享整个父 State，也不借共享变量绕过契约或权限。[官方 Subgraphs](https://docs.langchain.com/oss/javascript/langgraph/use-subgraphs) 提供不同 State 之间包装映射的机制，平台的父子运行和分支协议仍待设计。

## 后续建模顺序

先确定 **DataType + RuntimeValue + Reference + Domain Object**，统一语义类型、内联值、持久引用和领域对象边界，再完成 WorkflowState、各通道 reducer、Binding Resolver 与完整 Workflow Compiler。本轮不导出最终 WorkflowState 或 RuntimeValue，不把 State 方向、JSON 快照、泛型 LangGraph 测试标成完整执行能力。
