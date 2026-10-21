# @dramaflow/plugins

提供受信任的静态服务端 PluginRegistry；按 pluginId 与整数版本精确查找，一个 ProviderPlugin 可声明多个能力。Registry 统一校验插件配置、凭证、模型参数及能力输入输出，错误只保留安全分类，不传播 SDK 原始 message、响应或 cause。

OpenAICompatiblePlugin@1 实现 text.generate，通过 LangChain ChatOpenAICompletions 调用显式配置的 HTTP(S) baseURL、model、apiKey；不从环境选择模型或凭证。输入为 prompt 与可选 system，输出为 text；模型参数仅支持有界 temperature / maxOutputTokens。超时默认 60 秒，可在 100 毫秒至 180 秒内明确配置，LangChain 与 SDK 重试均关闭。

文本能力只接受非空白字符串结果；截断、内容过滤、拒绝、工具调用或内容块结果明确失败，不把它们作为完整文本输出给下游。

模型调用隔离父级及自动 LangSmith tracing，关闭 SDK 日志；LANGCHAIN_VERBOSE=true 时明确拒绝执行，避免全局详细日志打印原始供应商异常。超时、连接断开与 5xx 标记 outcome_unknown，不能作为自动重发依据。测试包含本机 HTTP 协议服务，证明标准协议、无自动重试、超时与错误脱敏，不代表真实模型质量或实际供应商调用验证。

Capability 表达能力，Plugin 适配提供者，Tool 表达操作；不要求固定调用层级。没有默认 Provider、动态 npm 插件加载、远程安装或插件市场。浏览器只读取安全声明，适配器和密钥留在服务端。数据库配置、所有者/项目权限与密钥加密属于应用基础设施，本包不访问数据库或全局工作流 State。

顶层职责见 [平台核心模型](../../docs/platform-model.md)，当前阶段见 [实施方案](../../docs/implementation-plan.md)。
