# @dramaflow/contracts

平台共享协议，提供身份、用户资料、会话摘要、基础项目及 Workflow 基础 Schema。不依赖 React Flow、NestJS、Prisma 或 LangGraph，第三方类型在适配层转换。

Workflow 已提供元数据、版本元数据、运行元数据、六种运行状态、契约名称及输出来源校验。时间使用 ISO 字符串；运行元数据不包含输入输出值，也不替代运行状态机。

`createWorkflowSchemas({ dataType, node, edge })` 要求显式传入三个具体 Zod Schema，组合输入输出、静态定义、草稿与版本 Schema。已检查顶层额外字段、名称和节点标识重复、输出来源节点存在；Node、Edge、DataType 没有宽松默认值。具体边引用、输出键存在性、类型兼容与无环校验仍待相应模型接入，组合器不能独立充当完整发布校验。

项目保存协议仍只有基础元数据与视口，不接收 Workflow 定义。`revision` 仅用于并发保存，不等同于不可变工作流版本。

模型见 [Workflow 模型](../../docs/workflow-model.md)，实施范围见 [当前架构](../../docs/architecture.md#workflow-基础库)，推进顺序见 [分步设计与实施方案](../../docs/implementation-plan.md)。Schema 能力复用 [Zod 官方实现](https://zod.dev/api)。
