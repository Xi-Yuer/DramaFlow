# @dramaflow/contracts

平台共享协议，当前仅提供身份、用户资料、会话摘要及基础项目的 Schema 和类型。项目保存名称、视口及 revision，不含节点、连线、工作流定义或插件协议。

不依赖 React Flow、NestJS、Prisma 或 LangGraph；第三方类型在各自适配层转换。外部输入与响应在边界校验，后续协议按用户规划逐步定义。

[平台核心模型](../../docs/platform-model.md) 中的概念是设计边界，不直接转成占位接口。Workflow、Node、State、Tool、Plugin 等契约随 [分步设计与实施方案](../../docs/implementation-plan.md) 逐步确定；当前项目 `revision` 仅用于并发保存，不等同于不可变工作流版本。
