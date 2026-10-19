# 分步设计与实施方案

本文管理从平台边界到领域生产能力的设计顺序。顶层结论见 [平台核心模型](platform-model.md)，Workflow 层见 [Workflow 模型](workflow-model.md)，Node 层见 [Node 模型](node-model.md)，已实现能力见 [当前架构](architecture.md)。设计记录不代表功能交付。

## 当前阶段

2026-10-19：平台、Workflow 与 Node 基础已有实现；数据语义与承载已在 [数据模型](data-model.md) 明确。正式 DataType、RuntimeValue、版本化内容引用、Artifact / Asset 协议和类型 Registry 已实施。普通 NodeType 从 compile 改为 execute，action 编译包装调用统一 Executor 接口。

Codec、BindingResolver、NodeExecutor、内容 Store 与 NodeRunRecorder 已定义服务契约，尚未实现生产管线、大小预算、权限解析和业务持久化。State.outputs 已正式采用 RuntimeValue；生产 LangGraph 通道与 reducer 仍待 Graph Model 核定。项目保存与空节点目录保持当前边界。

**下一步是 Workflow Graph Model：先确定数据 / 控制边、Handle、激活依赖、Branch、Join 到 LangGraph 的映射，再实施完整 Compiler 与运行服务。** 当前 ControlEdge 是最小草案，不将它视为最终控制协议，不提前实现 Plugin、Batch 或生成流程。

本文件是当前阶段、下一步与待决策项的唯一维护入口；推进时原地修订，不堆叠旧计划或逐轮交付流水。文档维护方式见 [开发指南](development.md#文档维护)。

## 设计顺序

| 顺序 | 议题                                      | 本步需要回答的问题                               | 状态                                |
| ---- | ----------------------------------------- | ------------------------------------------------ | ----------------------------------- |
| ①    | 平台是什么                                | 平台定位、一级概念、领域层与执行底座             | 已记录顶层决策                      |
| ②    | Workflow 工作流模型                       | 静态定义、版本、输入输出及 WorkflowRun           | 已确定边界并实施基础库              |
| ③    | Node 节点模型                             | Manifest、服务端实现、实例、端口、版本与编译边界 | 已实施基础设施与目录接入            |
| ④    | State / 数据流模型                        | 单次状态、绑定求值、结果传递与并行隔离           | 值协议已实施，下一步确定 Graph 映射 |
| ⑤    | Runtime 执行模型                          | LangGraph 编译与服务接入、持久化、恢复及事件投影 | 待逐步设计                          |
| ⑥    | Tool 工具体系                             | 可调用操作、调用契约、权限及 Node / Agent 关系   | 待逐步设计                          |
| ⑦    | Plugin 外部能力体系                       | 能力声明、模型、凭证、版本与供应商适配           | 待逐步设计                          |
| ⑧    | Middleware 中间件体系                     | 日志、权限、成本、重试的介入边界                 | 待逐步设计                          |
| ⑨    | Human Review / Interrupt 人工介入         | 暂停、确认、恢复与生成副作用边界                 | 待逐步设计                          |
| ⑩    | Asset 资产体系                            | 生产资料、媒体引用、版本、归属与生命周期         | 待逐步设计                          |
| ⑪    | Batch / Parallel / SubWorkflow 长任务体系 | 显式批量、并行、结果收集及子流程生命周期         | 待逐步设计                          |
| ⑫    | Agent 智能体体系                          | 模型、工具、上下文与人工确认边界                 | 待逐步设计                          |
| ⑬    | 漫剧领域节点与模板                        | 在已确定底座上表达漫剧生产与领域资料             | 待逐步设计                          |
| ⑭    | 广告 / 产品 / 口播等扩展                  | 复用底座并补充领域节点和模板                     | 待逐步设计                          |

这是设计顺序，不要求逐个建设相互脱离的子系统；已经明确且能独立验证的内容同步落到代码。外部生成涉及的 Plugin、Asset、凭证和安全策略不能用占位实现跨过。后续路线不构成一次性实施授权。

Workflow 的可组合性与固定被调用版本原则已在 [Workflow 模型](workflow-model.md#workflow-组合与-subworkflow-边界) 确定。第 ⑪ 步继续细化父子运行与批量生命周期，不授权任意循环、递归调用或项目下多个独立画布 / 工作流。

## 下一步：Workflow Graph Model

数据语义与承载的确定规则集中在 [数据模型](data-model.md)，状态职责见 [WorkflowState](workflow-state.md)。下一步明确以下问题，再接入整图编译：

1. connection 数据依赖是否同时提供执行激活，何时需要额外 ControlEdge；数据与控制怎样避免双重调度或歧义？
2. React Flow 的 Data / Control Handle 与 Edge 如何保存，条件路由的 Branch 身份、未选中分支和 skipped 如何表达？
3. 静态并行、多上游、Join、可选输入和失败分支怎样映射 LangGraph fan-in，怎样确定等待哪些输入？
4. Send 局部状态与结果身份如何隔离，相同 nodeId 的并发结果如何收集；哪些 reducer、命名空间和更新规则必须明确？
5. 控制、交互和复合结构分别需要哪些 CompilationStrategy；Interrupt / Resume、SubGraph 如何保留版本、权限及副作用边界？
6. 图校验、运行上下文、NodeRun、Artifact、Codec 与引用授权怎样组装成真实服务，怎样限制 Checkpoint 和内联值大小？

不通过平台 ready 轮询或第二套状态机解决这些问题；继续使用 LangGraph 调度、Checkpoint、Send 和 Interrupt。不授权任意循环或项目下多个独立画布。现有 ControlEdge 可随明确 Graph Model 调整，不因开发期草案而添加兼容层。

## 从设计进入代码

每一步记录职责、关系、失败边界、已决策项与待决策项；明确且能独立验证的部分随设计实施，不等待用户再次要求。未确定部分保留边界，不用占位实现冒充可用能力。

1. 对照现有代码和官方资料核实技术事实，明确当轮改变的行为与验收条件。
2. 在现有应用与包中实现必要契约和适配，不为概念清单预建框架或提前拆包。
3. 接口、执行语义或数据库改变时同步更新文档和必要行为测试；数据变更遵守 [协作规范](../AGENTS.md)，只在必要时重置本项目开发数据。
4. 执行相关检查，交付时区分已实现、已验证、未验证和待设计。缺少真实模型凭证时如实记录，不用测试适配器替代生产能力。

启动与检查入口见 [开发指南](development.md)。后续每步以真实新增能力更新架构和阶段，不把整张路线图当作开发授权。
