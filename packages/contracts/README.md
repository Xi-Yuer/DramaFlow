# @dramaflow/contracts

平台共享协议，提供身份、用户资料、会话摘要、基础项目及 Workflow / Node 基础 Schema。不依赖 React Flow、NestJS、Prisma 或 LangGraph，第三方类型在适配层转换。

Workflow 已提供元数据、版本元数据、运行元数据、六种运行状态、契约名称及输出来源校验。时间使用 ISO 字符串；运行元数据不包含输入输出值。Run / NodeRun 状态是基于 LangGraph 执行事实生成的业务投影，不用于驱动另一套调度器。

Node 已提供静态实例、输入绑定、端口映射 Edge、Preset、NodeRun 及八种状态 Schema。来源统一为 nodeId / outputKey；同一目标端口不能重复绑定；配置、输入输出必须为 JSON，错误采用 code / message。NodeRun 是记录结构，不内置状态转换或权限检查。

`createWorkflowSchemas({ dataType, node, edge })` 要求显式传入三个具体 Zod Schema，可以使用现有 `nodeDefinitionSchema` 与 `edgeDefinitionSchema`。已检查顶层额外字段、名称和节点标识重复、输出来源节点存在；具体边引用、来源输出键、类型兼容、映射一致性与无环校验仍待接入，组合器不能独立充当完整发布校验。DataType 不提供宽松默认值。

项目保存协议仍只有基础元数据与视口，不接收 Workflow 定义。`revision` 仅用于并发保存，不等同于不可变工作流版本。

模型见 [Workflow 模型](../../docs/workflow-model.md) 与 [Node 模型](../../docs/node-model.md)，实施范围见 [当前架构](../../docs/architecture.md)，推进顺序见 [分步设计与实施方案](../../docs/implementation-plan.md)。Schema 能力复用 [Zod 官方实现](https://zod.dev/api)。
