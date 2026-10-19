# WorkflowState 边界

状态承载采用 [数据模型](data-model.md) 中的 RuntimeValue。当前已有 TypeScript State 协议与 typed outputs，没有生产 LangGraph State Schema、reducer 或整图调度适配，实际接入见 [架构](architecture.md)。

## 生命周期与存储职责

WorkflowDefinition / Version 保存静态流程；WorkflowRun 保存运行身份与独立 threadId；WorkflowState 保存当前执行必需值；NodeRun 保存业务执行历史；Artifact / Asset 保存持久内容；Checkpoint 保存恢复图所需快照。它们互不替代。

State 不包含整个数据库、全部日志或原始媒体。图片、视频、音频及大型文档通过明确引用传递，具体 Codec、字节预算与存储服务尚未实现，不能用 JSON 结构校验冒充完成内容大小和权限策略。

## 五个分区

| 分区      | 职责                                                       | 边界                                                     |
| --------- | ---------------------------------------------------------- | -------------------------------------------------------- |
| run       | workflowId / workflowVersionId / workflowRunId / projectId | 本次运行不可变身份，不混入进度或日志                     |
| inputs    | Workflow 输入的 RuntimeValue map                           | 本次运行视为不可变                                       |
| outputs   | nodeId → outputKey → RuntimeValue                          | 只保存节点当前有效结果，不等于 Workflow 的最终输出契约   |
| variables | 显式工作流变量                                             | 不成为任意节点读写的隐式上下文                           |
| execution | 图执行必要控制状态                                         | 当前保留为空，具体控制字段及 reducer 随 Graph Model 明确 |

NodeOutputMap 已明确为 Record<string, Record<string, RuntimeValue>>，不再用 unknown 表示节点运行结果。输入和变量同样携带实际类型；这不表示已实现初始化、更新检查或 Checkpoint 持久化。

## 并行与历史

不同节点的 outputs 应按节点键合并，不能默认整对象覆盖。相同 nodeId 的并发分支必须明确分支身份和结果收集规则，不能依靠最后完成者覆盖；最终通道与 reducer 交给下一步 Graph Model 核定。[官方并行说明](https://docs.langchain.com/oss/javascript/langgraph/use-graph-api#run-graph-nodes-in-parallel) 介绍原生更新机制。

State 只保留当前有效值。旧版本、失败记录、模型、耗时与成本进入 NodeRun 等业务记录。attempt 不等于函数重入次数；Send 分支也不能仅靠 nodeId 标识。审核回改的讨论不授权任意循环，也不绕过当前联合 DAG 校验。

## Thread、审核与子流程

WorkflowRun.threadId 独立必填，createWorkflowRunConfig 将它映射到 configurable.thread_id，拒绝配置覆盖。恢复使用原 threadId、原不可变版本和兼容编译实现，知道线程 ID 不代表拥有权限。

审核继续用 LangGraph interrupt / Command.resume，waiting 是业务投影。节点恢复从开头重入，副作用需幂等，审核决策记录独立于 Checkpoint；当前没有生产审核 API 或 Run Store。[官方 Interrupts](https://docs.langchain.com/oss/javascript/langgraph/interrupts) 解释原生恢复机制。

Send 使用 branch-local 输入，不能争写全局 currentEpisode。SubWorkflow 通过明确输入输出映射组合，不复制整个父 State；分支、父子运行、Join 与控制依赖的精确模型留在下一步，不自建 ready 轮询或恢复状态机。
