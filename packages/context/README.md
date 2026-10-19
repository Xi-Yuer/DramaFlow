# @dramaflow/context

保留空入口，当前没有上下文构建、摘要、预算或业务对话实现。

上下文构建保持独立职责，单次 WorkflowRun 的 State 不自动成为模型上下文。节点和全局会话隔离，只引入用户明确选择或绑定的数据；具体接口随相关模型设计确定。

平台边界见 [平台核心模型](../../docs/platform-model.md)，推进顺序见 [分步设计与实施方案](../../docs/implementation-plan.md)。
