# @dramaflow/workflow

保留空入口及 LangChain / LangGraph 基础依赖，当前没有节点注册、工作流定义、图校验、编排适配或执行能力。依赖安装不代表相关功能已实现。

后续作为工作流核心及执行适配的候选承载包，职责见 [平台核心模型](../../docs/platform-model.md) 与 [架构与目录职责](../../docs/architecture.md)。Runtime 保持领域无关，漫剧、广告、口播的生产语义由领域节点与模板表达；调度交给 LangGraph，不另建调度框架。

当前阶段、下一步及具体接口设计统一按 [分步设计与实施方案](../../docs/implementation-plan.md) 维护，不在空入口预建类型或执行器。
