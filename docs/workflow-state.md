# WorkflowState 边界

状态承载采用 [数据模型](data-model.md) 中的 RuntimeValue。WorkflowState 的协议与 LangGraph Annotation 共用 runtime/state.ts，不建立第二套状态模型；实际接入范围见 [架构](architecture.md#数据与-node-基础库)。

## 生命周期与存储职责

WorkflowDefinition / Version 保存静态流程；WorkflowRun 保存运行身份与独立 threadId；WorkflowState 保存当前执行必需值；NodeRun 保存业务执行历史；Artifact / Asset 保存持久内容；Checkpoint 保存恢复图所需快照。它们互不替代。

State 不包含整个数据库、全部日志或原始媒体。图片、视频、音频及大型文档通过明确引用传递；输入 decode 只委托引用服务，字节预算与真实存储 / 授权服务仍须独立落实，不能用 JSON 结构校验冒充完成内容大小和权限策略。

## 五个分区

| 分区      | 职责                                                       | 边界                                                     |
| --------- | ---------------------------------------------------------- | -------------------------------------------------------- |
| run       | workflowId / workflowVersionId / workflowRunId / projectId | 本次运行不可变身份，不混入进度或日志                     |
| inputs    | Workflow 输入的 RuntimeValue map                           | 本次运行视为不可变                                       |
| outputs   | nodeId → outputKey → RuntimeValue                          | 只保存节点当前有效结果，不等于 Workflow 的最终输出契约   |
| variables | 显式工作流变量                                             | 不成为任意节点读写的隐式上下文                           |
| execution | 图执行必要控制状态                                         | 当前保留为空，具体控制字段及 reducer 随 Graph Model 明确 |

NodeOutputMap 已明确为 Record<string, Record<string, RuntimeValue>>，不再用 unknown 表示节点运行结果。输入和变量同样携带实际类型。run、inputs、variables、execution 使用单值通道；调用方提供运行初始值，Action wrapper 只写 outputs，不开放其他分区的并发写入。outputs 使用独立 reducer，default 每次生成空 map；通道定义不代表 Checkpoint 已持久化。

## 并行与历史

Action wrapper 等待 NodeExecutor 后只返回 `{ outputs: { [nodeId]: result.output } }`，不展开旧 state.outputs，不处理 Binding、业务 Schema 或 Artifact。项目与运行 ID 取自当前 state.run；工作流、能力及 RunnableConfig 由编译上下文工厂提供。Executor 继续只返回结果，不直接改 State；失败原样向图传播，不返回占位增量。

mergeNodeOutputs 按 nodeId 合并不同节点的 map，不修改 current / update。同一 nodeId 已是 current 的自有键时抛 DuplicateNodeOutputWriteError（DUPLICATE_NODE_OUTPUT_WRITE），即使值相同也不视为幂等写入；不合并同一节点的多个端口片段，不静默覆盖。[官方 reducer 参数说明](https://docs.langchain.com/oss/javascript/langgraph/graph-api#reducer-arguments) 中 current 是累计状态，不携带 step 身份。因此普通确定性 DAG 采用输出单次写入约束：同一步的并发重复写入及后续 step 对已有键的隐式覆盖均拒绝。重试、循环或审核后产生新 effective output，须另有明确的执行 / 版本语义，不能由 reducer 猜测。

State 只保留当前有效值。旧版本、失败记录、模型、耗时与成本进入 NodeRun 等业务记录。attempt 不等于函数重入次数；Send 分支也不能仅靠 nodeId 标识。审核回改的讨论不授权任意循环，也不绕过当前数据 / 控制联合 DAG 校验。

## Thread、审核与子流程

WorkflowRun.threadId 独立必填，createWorkflowRunConfig 将它映射到 configurable.thread_id，拒绝配置覆盖。恢复使用原 threadId、原不可变版本和兼容编译实现，知道线程 ID 不代表拥有权限。

首次启动由 WorkflowRunner 创建完整初始 State；状态反映以原生 StateSnapshot.next / tasks 与 interrupt 标记为依据，不在 State 增加 isInterrupted。State.outputs 继续保存节点数据，WorkflowRun.outputs 由独立 Resolver 按声明收集，完整边界见 [Runner](runtime-architecture.md#workflowrunner-首次启动)。

resume 只读取原 Run 的版本与 thread；原子 claim waiting → running 后，以 Command({ resume }) 继续原 checkpoint，不重建 initialState。原快照缺失或身份不符时失败，不重新运行已完成节点；恢复再次中断可回到 waiting。Runner 不查询 interaction NodeRun，具体关联由节点自身生命周期后续落实，见 [恢复边界](runtime-architecture.md#workflowrunner-恢复)。

审核继续用 LangGraph interrupt / Command.resume，waiting 是业务投影。节点恢复从开头重入，副作用需幂等，审核决策记录独立于 Checkpoint；WorkflowRun Repository 保存业务状态，不提供审核 API 或 Graph 恢复服务。[官方 Interrupts](https://docs.langchain.com/oss/javascript/langgraph/interrupts) 解释原生恢复机制。

Send 使用 branch-local 输入，不能争写全局 currentEpisode。SubWorkflow 通过明确输入输出映射组合，不复制整个父 State。当前 Data / Control Edge 均产生确定性执行依赖，相同节点对去重；Control Edge 不写 State 输入值，Data Edge 的端口取值独立于依赖编译。普通多上游的 [ALL Join](runtime-architecture.md#普通确定性依赖的-all-join) 由 LangGraph waiting edge 承担，不在 State 增加平台 ready 计数。条件分支、Send / Batch 与父子运行的执行映射单独设计，不把候选路径当作静态 ALL 等待集合，不自建轮询或恢复状态机。
