# 分步设计与实施方案

本文管理从平台边界到领域生产能力的设计顺序。顶层结论见 [平台核心模型](platform-model.md)，Workflow 层见 [Workflow 模型](workflow-model.md)，Node 层见 [Node 模型](node-model.md)，已实现能力见 [当前架构](architecture.md)。设计记录不代表功能交付。

## 当前阶段

2026-10-19：已确定 **① 平台、② Workflow、③ Node** 的基础边界。NodeType 静态说明书已落地为 type、version、metadata、inputs、outputs、configSchema、capabilities、ui；DataType 声明与结构兼容判断独立于运行值 Zod，Registry 精确匹配类型版本与 Preset，manifest 只公开静态声明和配置 JSON Schema。前端转换保留 typeVersion，仍独立于 React Flow 空白画布。

**下一步只拆解 ④ State / InputValue / Input Binding / Output 的数据流模型。** LLM 与图生视频仅用于检查静态声明边界，不作为进入数据流设计前必须实施的生产节点。说明书当前职责见 [NodeType 实施说明](node-type-implementation.md)，技术分工见 [Runtime 架构](runtime-architecture.md)。

完整 State / InputValue / Binding、整图 Compiler、生产节点、运行接口、数据库与持久 checkpointer 尚未实现。端口 required / defaultValue / multiple 只是声明，不代表固定值注入、多来源输入或多连接已经可用。Capability 也只有需求声明，没有 Resolver、Routing 或默认厂商选择。

本文件是当前阶段、下一步与待决策项的唯一维护入口；推进时原地修订，不堆叠旧计划或逐轮交付流水。文档维护方式见 [开发指南](development.md#文档维护)。

## 设计顺序

| 顺序 | 议题                                      | 本步需要回答的问题                                    | 状态                       |
| ---- | ----------------------------------------- | ----------------------------------------------------- | -------------------------- |
| ①    | 平台是什么                                | 平台定位、一级概念、领域层与执行底座                  | 已记录顶层决策             |
| ②    | Workflow 工作流模型                       | 静态定义、版本、输入输出及 WorkflowRun                | 已确定边界并实施基础库     |
| ③    | Node 节点模型                             | 静态说明书、实例、端口、配置、版本、Preset 与编译边界 | 已实施明确的基础契约与适配 |
| ④    | State / 数据流模型                        | InputValue、单次状态、来源绑定、结果传递与隔离        | 下一步只讨论此层           |
| ⑤    | Runtime 执行模型                          | LangGraph 编译与服务接入、持久化、恢复及事件投影      | 待逐步设计                 |
| ⑥    | Tool 工具体系                             | 可调用操作、调用契约、权限及 Node / Agent 关系        | 待逐步设计                 |
| ⑦    | Plugin 外部能力体系                       | 能力声明、模型、凭证、版本与供应商适配                | 待逐步设计                 |
| ⑧    | Middleware 中间件体系                     | 日志、权限、成本、重试的介入边界                      | 待逐步设计                 |
| ⑨    | Human Review / Interrupt 人工介入         | 暂停、确认、恢复与生成副作用边界                      | 待逐步设计                 |
| ⑩    | Asset 资产体系                            | 生产资料、媒体引用、版本、归属与生命周期              | 待逐步设计                 |
| ⑪    | Batch / Parallel / SubWorkflow 长任务体系 | 显式批量、并行、结果收集及子流程生命周期              | 待逐步设计                 |
| ⑫    | Agent 智能体体系                          | 模型、工具、上下文与人工确认边界                      | 待逐步设计                 |
| ⑬    | 漫剧领域节点与模板                        | 在已确定底座上表达漫剧生产与领域资料                  | 待逐步设计                 |
| ⑭    | 广告 / 产品 / 口播等扩展                  | 复用底座并补充领域节点和模板                          | 待逐步设计                 |

这是设计顺序，不要求逐个建设相互脱离的子系统；已经明确且能独立验证的内容同步落到代码。外部生成涉及的 Plugin、Asset、凭证和安全策略不能用占位实现跨过。后续路线不构成一次性实施授权。

Workflow 的可组合性与固定被调用版本原则已在 [Workflow 模型](workflow-model.md#workflow-组合与-subworkflow-边界) 确定。第 ⑪ 步继续细化父子运行与批量生命周期，不授权任意循环、递归调用或项目下多个独立画布 / 工作流。

## 下一步：④ 数据流模型

先解决输入如何同时表达 React Flow 连线、固定值、Workflow Input、Asset 与变量，再映射到 LangGraph 中传给节点的实际值。当前不提前实现 Tool / Plugin、模型选择或生产节点。

1. **InputValue 与来源。** NodeDefinition.inputs 的最终结构是什么？各来源如何做可序列化的显式区分，固定值、默认值与 required 如何协调，怎样避免把动态输入混入 config？当前 Binding 数组保留到替代协议明确，不先改为任意记录。
2. **Edge 与 Binding。** 谁是编辑权威来源，谁负责派生？怎样检查端口引用、DataType 兼容、映射一致性和联合依赖无环，避免两份数据独立漂移？
3. **值与缺失语义。** 怎样区分缺失、未就绪、空值、可选值、失败和 skipped？端口声明如何与执行值 Zod 契约协调，默认值何时校验与应用？
4. **WorkflowState。** 单次运行保存哪些输入、节点结果与引用，怎样与不可变定义、NodeRun、Asset 和模型上下文分离，并使用 LangGraph State Schema / reducer？
5. **多来源与并发。** multiple、array 和多结果收集各表示什么？怎样用 LangGraph 原生 fan-in、Send 与 reducer 处理集合、排序、身份和并行写入冲突？
6. **激活与数据。** 怎样将控制激活和数据依赖联合编译为原生边与条件路由，同时为 Batch、Human Review 和 Agent 保留状态隔离边界？

DataType 当前只支持明确的基础、媒体、领域标识和数组声明。object、文件、资产版本与完整领域结构的扩展需依据真实数据流和资产需求确定，不能把当前最小类型集合标成完整数据体系。结构兼容函数也不替代真实值、权限或整图校验。

运行继续绑定不可变 WorkflowVersion 与明确节点类型版本，定义不含密钥；contracts 不依赖 React Flow、NestJS、Prisma 或 LangGraph。调度、Checkpoint、Interrupt / Resume 交给 LangGraph，业务状态不驱动第二套 ready 轮询或暂停恢复状态机。

## 从设计进入代码

每一步记录职责、关系、失败边界、已决策项与待决策项；明确且能独立验证的部分随设计实施，不等待用户再次要求。未确定部分保留边界，不用占位实现冒充可用能力。

1. 对照现有代码和官方资料核实技术事实，明确当轮改变的行为与验收条件。
2. 在现有应用与包中实现必要契约和适配，不为概念清单预建框架或提前拆包。
3. 接口、执行语义或数据库改变时同步更新文档和必要行为测试；数据变更遵守 [协作规范](../AGENTS.md)，只在必要时重置本项目开发数据。
4. 执行相关检查，交付时区分已实现、已验证、未验证和待设计。缺少真实模型凭证时如实记录，不用测试适配器替代生产能力。

启动与检查入口见 [开发指南](development.md)。后续每步以真实新增能力更新架构和阶段，不把整张路线图当作开发授权。
