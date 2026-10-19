# 分步设计与实施方案

本文管理从平台边界到领域生产能力的设计顺序。顶层结论见 [平台核心模型](platform-model.md)，Workflow 层见 [Workflow 模型](workflow-model.md)，Node 层见 [Node 模型](node-model.md)，已实现能力见 [当前架构](architecture.md)。设计记录不代表功能交付。

## 当前阶段

2026-10-19：① 平台、② Workflow、③ Node 已有基础模型与实现；④ 已确定四类 Binding、控制 / 数据分离，以及 [WorkflowState 核心边界](workflow-state.md)：run / inputs 不可变、outputs 当前有效值与历史分离、variables 显式、execution 最小、存储分工和分支局部数据。

本轮将独立 threadId、NodeRun 正整数 attempt 与可选 inputSnapshot / outputSnapshot 落到契约。Run / NodeRun 持久化暂缓，Workflow 版本保存、权限、分支身份及投影一致性尚未定；JSON 快照不是最终 RuntimeValue，也未执行大小、内容引用或脱敏策略。实际代码能力统一见 [当前架构](architecture.md)。

**下一步先确定 DataType + RuntimeValue + Reference + Domain Object，再完成 State、Binding Resolver 和完整 Compiler。** 不导出最终 State，不创建孤立空表或提前接入运行服务；生产目录仍为空，项目保存协议不变。

本文件是当前阶段、下一步与待决策项的唯一维护入口；推进时原地修订，不堆叠旧计划或逐轮交付流水。文档维护方式见 [开发指南](development.md#文档维护)。

## 设计顺序

| 顺序 | 议题                                      | 本步需要回答的问题                               | 状态                             |
| ---- | ----------------------------------------- | ------------------------------------------------ | -------------------------------- |
| ①    | 平台是什么                                | 平台定位、一级概念、领域层与执行底座             | 已记录顶层决策                   |
| ②    | Workflow 工作流模型                       | 静态定义、版本、输入输出及 WorkflowRun           | 已确定边界并实施基础库           |
| ③    | Node 节点模型                             | Manifest、服务端实现、实例、端口、版本与编译边界 | 已实施基础设施与目录接入         |
| ④    | State / 数据流模型                        | 单次状态、绑定求值、结果传递与并行隔离           | 核心边界已定，下一步统一值与引用 |
| ⑤    | Runtime 执行模型                          | LangGraph 编译与服务接入、持久化、恢复及事件投影 | 待逐步设计                       |
| ⑥    | Tool 工具体系                             | 可调用操作、调用契约、权限及 Node / Agent 关系   | 待逐步设计                       |
| ⑦    | Plugin 外部能力体系                       | 能力声明、模型、凭证、版本与供应商适配           | 待逐步设计                       |
| ⑧    | Middleware 中间件体系                     | 日志、权限、成本、重试的介入边界                 | 待逐步设计                       |
| ⑨    | Human Review / Interrupt 人工介入         | 暂停、确认、恢复与生成副作用边界                 | 待逐步设计                       |
| ⑩    | Asset 资产体系                            | 生产资料、媒体引用、版本、归属与生命周期         | 待逐步设计                       |
| ⑪    | Batch / Parallel / SubWorkflow 长任务体系 | 显式批量、并行、结果收集及子流程生命周期         | 待逐步设计                       |
| ⑫    | Agent 智能体体系                          | 模型、工具、上下文与人工确认边界                 | 待逐步设计                       |
| ⑬    | 漫剧领域节点与模板                        | 在已确定底座上表达漫剧生产与领域资料             | 待逐步设计                       |
| ⑭    | 广告 / 产品 / 口播等扩展                  | 复用底座并补充领域节点和模板                     | 待逐步设计                       |

这是设计顺序，不要求逐个建设相互脱离的子系统；已经明确且能独立验证的内容同步落到代码。外部生成涉及的 Plugin、Asset、凭证和安全策略不能用占位实现跨过。后续路线不构成一次性实施授权。

Workflow 的可组合性与固定被调用版本原则已在 [Workflow 模型](workflow-model.md#workflow-组合与-subworkflow-边界) 确定。第 ⑪ 步继续细化父子运行与批量生命周期，不授权任意循环、递归调用或项目下多个独立画布 / 工作流。

## 下一步：DataType / RuntimeValue / Reference / Domain Object

State 的职责与结构方向已确定，集中维护在 [WorkflowState 边界](workflow-state.md)。先解决值和引用的两个维度，再将它们应用到最终 Schema、reducer 与执行适配：

1. DataType 如何表达 Image、Character、Script、Shot[] 等语义，RuntimeValue 如何独立表达 inline / reference 承载，避免把 asset_ref 当作语义类型？
2. 哪些小型值与领域元数据可以内联，哪些大型持久内容需要引用？Asset、Domain Object / Entity、Artifact 的身份、结构、生命周期如何区分？
3. Reference 怎样固定版本、执行权限与解析内容；URL 怎样仅作为读取入口？现有 AssetBinding 只有 assetId，不能视为已经完成版本固定或资产读取。
4. Node Input / Output、四类 Binding 与真实 Zod 值校验怎样共享同一约定；JSON record、DataType.any、快照和最终 RuntimeValue 各承担什么范围？
5. 引用和领域对象明确后，怎样完成 State 的输出身份、同节点并发冲突、Send 局部输入及各通道 reducer，而不依赖更新顺序或隐式全局变量？
6. 怎样为快照、Checkpoint、大文本与媒体定义大小、引用、安全和审计策略，并保持业务记录、状态投影与外部副作用一致？

本轮 asset_ref 示例不是最终协议；图片 / 视频版本化引用约束继续有效。审核回改示例不授权任意循环。State 只保存当前有效值，完整历史与审核审计由后续 Store 承担，不能从 Checkpoint 直接替代产品记录。

之后再实现 Binding Resolver、最终 WorkflowState 和整图 Compiler；Plugin Resolver、Tool、Agent、Middleware、Batch、HumanReview、SubWorkflow 与生产 Run Store 继续按对应范围推进。调度、Checkpoint、Interrupt / Resume 均复用 LangGraph，不新增第二套执行状态机。

## 从设计进入代码

每一步记录职责、关系、失败边界、已决策项与待决策项；明确且能独立验证的部分随设计实施，不等待用户再次要求。未确定部分保留边界，不用占位实现冒充可用能力。

1. 对照现有代码和官方资料核实技术事实，明确当轮改变的行为与验收条件。
2. 在现有应用与包中实现必要契约和适配，不为概念清单预建框架或提前拆包。
3. 接口、执行语义或数据库改变时同步更新文档和必要行为测试；数据变更遵守 [协作规范](../AGENTS.md)，只在必要时重置本项目开发数据。
4. 执行相关检查，交付时区分已实现、已验证、未验证和待设计。缺少真实模型凭证时如实记录，不用测试适配器替代生产能力。

启动与检查入口见 [开发指南](development.md)。后续每步以真实新增能力更新架构和阶段，不把整张路线图当作开发授权。
