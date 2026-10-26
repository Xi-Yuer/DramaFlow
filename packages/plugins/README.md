# @dramaflow/plugins

受信任的静态 PluginRegistry。按 pluginId 与整数版本精确查找，统一校验配置、凭证、模型参数和能力输入输出。不访问数据库，不提供远程安装或默认厂商。

源码按职责分目录：

- `plugin/`：插件契约、调用错误和 PluginRegistry。
- `catalog/`：官方 Provider Catalog 与 Model Catalog，把预设厂商和模型落到插件配置。
- `text/`：文本插件。`parameters.ts` 是两端共用的地址、凭证和生成参数边界；`openai-compatible.ts` 与 `text-generation.ts` 各自适配协议。

`text_generation@1` 在内部使用 Vercel AI SDK 执行 `text.generate`。官方 OpenAI / Anthropic Provider Definition 在 `catalog/`，映射到这一个插件。`openai_compatible@1` 是高级 Custom OpenAI-Compatible。调用边界见 [当前架构](../../docs/architecture.md#文本-ai-与-provider-plugin)。

业务能力按 Node + Plugin + Contract 扩展，业务流程通过图组合；Plugin 不向通用 Compiler / Runtime 注入领域流程或自建运行树。新增能力前遵循[业务解耦原则](../../docs/platform-model.md#workflow-通用性与业务解耦)，纯业务计算不强制依赖外部 Plugin。
