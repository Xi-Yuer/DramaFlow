# 平台边界

产品定位和仍有效的职责边界。已实现能力见 [当前架构](architecture.md)，阶段见 [实施方案](implementation-plan.md)。

DramaFlow 是团队自部署的 AI 视频生产工作流平台，漫剧优先，也可承载广告、产品宣传和口播。当前图为有向无环，普通多上游使用确定性 ALL Join。条件路由、显式批量、子流程和人工确认按后续明确任务加入。任意循环、公开 SaaS、商业计费、长期记忆和知识库不在范围内。成本观察不等于计费。

一个项目恰好一张画布、一个逻辑 Workflow，可以有多次运行。Project、Canvas、Workflow 职责不同，不据此增加多画布或多工作流层级。被调用流程属于它自己的项目；组合时引用对方的固定版本，不能因此获得其他项目的权限。

| 概念 | 边界 |
| --- | --- |
| WorkflowDefinition | 静态 inputs、nodes、edges、outputs，不含运行状态 |
| WorkflowVersion | 发布冻结的完整快照；发布不执行 |
| WorkflowRun | 绑定明确版本的一次运行 |
| Node | 只执行自身；不读取上下游，不调度全图 |
| Edge | 连接只在 edges。Data Edge 提供值，Control Edge 提供先后，不自动互相补齐 |
| State | 单次运行的当前值，不是共享上下文或聊天记录 |
| NodeType | 画布上的业务节点，例如 `ai.text_generate`。它请求能力，不指定厂商或 SDK |
| Capability | 节点需要的能力，例如 `text.generate`。同一能力可以由不同插件执行 |
| Provider | 用户实际使用的模型服务，例如 OpenAI、Anthropic、DeepSeek、Qwen。普通路径来自平台预设 |
| Plugin | 受信任的执行实现，例如 `text_generation@1`。Vercel AI SDK 只是该实现的内部依赖 |
| Tool / Agent | 操作和建议能力。不自动成为画布节点，不隐式改工作流或继续执行 |
| Asset | 可复用资料与产物；二进制和领域元数据分开。版本读取与 Promote 尚未实现 |
| Context | 独立构建，只引入明确选择的数据。节点会话与全局会话隔离 |

Workflow 描述怎么生产，Node 描述做什么，Capability 描述需要哪类能力，Provider 描述用户使用哪家服务，Plugin 负责执行。LangGraph 负责怎么执行。平台保存自己的定义并编译到 LangGraph，不自建调度器或暂停恢复状态机。角色、剧集、卖点等语义留在节点、资料和模板，不写进 Runtime。

已确定的产品模型是 Provider Catalog → Provider Definition → Provider Instance → Credential → Model Configuration。普通用户选择预设 Provider，填写该 Provider 要求的凭证，再选择或配置模型。Custom OpenAI-Compatible 允许高级用户配置 endpoint、API Key 和 model；当前保留 `openai_compatible@1`，它不作为所有 Provider 的基础交互。文本厂商协议由对应插件在内部适配。图片、视频、音频按 Provider 使用各自插件，不建一个覆盖全部模态的 Provider 抽象。OpenAI 与 Anthropic 已有代码定义的 Catalog。其他 Provider、媒体插件和选择界面尚未实现。LiteLLM 与 Bifrost 已评估并否决，证据在 experiments。

草稿修改不影响已有运行。跨运行复用靠显式 Asset 引用，不靠复用可变 State。新素材写入 RustFS，不静默回退本地文件。

重试必须区分可安全重试的操作和可能收费的生成。受理结果不明时不能盲目重发，不承诺外部调用 exactly-once。人工确认、生成、运行和继续下游各自需要明确操作。

上下文与建议尚未实现，约束先成立：不把全部 State 或聊天自动加入提示词；原始对话与摘要分开；建议携带基础版本。用户确认应用时重新检查权限、Schema、版本和幂等性。应用建议不自动触发生成或运行。

协议见 [Workflow](workflow-model.md)、[Node](node-model.md)、[数据模型](data-model.md) 和 [Runtime](runtime-architecture.md)。
