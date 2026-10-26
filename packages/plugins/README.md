# @dramaflow/plugins

受信任的静态 PluginRegistry。按 pluginId 与整数版本精确查找，统一校验配置、凭证、模型参数和能力输入输出。不访问数据库，不提供远程安装或默认厂商。

`text_generation@1` 在内部使用 Vercel AI SDK 执行 `text.generate`。官方 OpenAI / Anthropic Provider Definition 也在本包，映射到这一个插件。`openai_compatible@1` 是高级 Custom OpenAI-Compatible。调用边界见 [当前架构](../../docs/architecture.md#文本-ai-与-provider-plugin)。

业务能力按 Node + Plugin + Contract 扩展，业务流程通过图组合；Plugin 不向通用 Compiler / Runtime 注入领域流程或自建运行树。新增能力前遵循[业务解耦原则](../../docs/platform-model.md#workflow-通用性与业务解耦)，纯业务计算不强制依赖外部 Plugin。
