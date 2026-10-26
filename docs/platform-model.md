# 平台边界

产品定位和仍有效的职责边界。已实现能力见 [当前架构](architecture.md)，阶段见 [实施方案](implementation-plan.md)。

DramaFlow 是团队自部署的 AI 视频生产工作流平台，漫剧优先，也可承载广告、产品宣传和口播。当前图为有向无环，普通多上游使用确定性 ALL Join。条件路由、显式迭代、人工审核和内嵌 SubWorkflow v1 的实际准入见当前架构；Batch 与其他控制能力按后续明确任务加入。任意循环、公开 SaaS、商业计费、长期记忆和知识库不在范围内。成本观察不等于计费。

一个项目恰好一张画布、一个逻辑 Workflow，可以有多次运行。Project、Canvas、Workflow 职责不同，不据此增加多画布或多工作流层级。被调用流程属于它自己的项目；组合时引用对方的固定版本，不能因此获得其他项目的权限。

| 概念               | 边界                                                                                 |
| ------------------ | ------------------------------------------------------------------------------------ |
| WorkflowDefinition | 静态 inputs、nodes、edges、outputs，不含运行状态                                     |
| WorkflowVersion    | 发布冻结的完整快照；发布不执行                                                       |
| WorkflowRun        | 绑定明确版本的一次运行                                                               |
| Node               | 只执行自身；不读取上下游，不调度全图                                                 |
| Edge               | 连接只在 edges。Data Edge 提供值，Control Edge 提供先后，不自动互相补齐              |
| State              | 单次运行的当前值，不是共享上下文或聊天记录                                           |
| NodeType           | 画布上的业务节点，例如 `ai.text_generate`。它请求能力，不指定厂商或 SDK              |
| Capability         | 节点需要的能力，例如 `text.generate`。同一能力可以由不同插件执行                     |
| Provider           | 用户实际使用的模型服务，例如 OpenAI、Anthropic、DeepSeek、Qwen。普通路径来自平台预设 |
| Plugin             | 受信任的执行实现，例如 `text_generation@1`。Vercel AI SDK 只是该实现的内部依赖       |
| Tool / Agent       | 操作和建议能力。不自动成为画布节点，不隐式改工作流或继续执行                         |
| Asset              | 可复用资料与产物；二进制和领域元数据分开。版本读取与 Promote 尚未实现                |
| Context            | 独立构建，只引入明确选择的数据。节点会话与全局会话隔离                               |

Workflow 描述怎么生产，Node 描述做什么，Capability 描述需要哪类能力，Provider 描述用户使用哪家服务，Plugin 负责执行。LangGraph 负责怎么执行。平台保存自己的定义并编译到 LangGraph，不自建调度器或暂停恢复状态机。角色、剧集、卖点等语义留在节点、资料和模板，不写进 Runtime。

## Workflow 通用性与业务解耦

DramaFlow 的产品优先服务视频创作，Workflow 基础设施则应通用、节点驱动、可组合、可复用。Workflow / Compiler / Runtime / Execution / Binding 只理解 Graph、Node、Port、Binding、Control Flow、Data Flow、Scope、Run、Artifact 等编排概念，不依赖 Episode、Chapter、漫剧、视频创作、商品或广告等业务语义。识别 `flow.iteration` 等结构节点的控制语义属于引擎职责，不等于理解具体业务。

具体业务能力优先封装为 Node + Plugin + Contract；已有节点足以表达时直接组合。Node 的业务 contract 可以包含小说拆集、分镜、视频、商品或广告信息，受信任 Plugin 实现实际能力，通用基础设施只处理显式类型、版本、输入输出和授权。新增业务能力主要通过新增或组合 Node / Plugin 完成，不应要求在 Workflow Engine 增加对应业务分支；纯业务计算不必为了形式引入外部 Plugin。

Node + Edge + Binding + Control Node 的组合表达宏观业务流程，包括串联、分支、迭代、汇聚和上下游关系。业务节点不自行读取全图或接管调度；Compiler / Runtime 不硬编码某种业务的生产步骤。已有通用能力不足且确有新的控制语义时，才独立设计基础能力，不把它伪装成普通 Action。

**数据基数不等于执行基数。** `Episode[]` 只是数组数据；普通节点输出它只完成本次节点执行。只有用户显式连接并实际执行 Iteration、Batch、Loop 等具有相应控制语义的节点，才可能创建多个子执行。名称为 Batch 或输出为 array 也不意味着一定存在子图；一份 Body Graph Definition 可以对应多份运行实例，Definition 与 Execution 必须分离。

Composite 之间共享的子图调用、Execution Scope、Run Tree、Retry / Resume 和 Observability 应优先复用通用机制。专属的元素选择、循环条件、聚合或失败策略留在对应 Node Strategy；通用层提供身份、父子归属、权限、记录与查询，并继续由 LangGraph 承担调度、checkpoint 和 interrupt / resume。复用审计机制不表示不同 Composite 必须采用相同失败传播策略。

当 `iterationXXX`、`subWorkflowXXX`、`loopXXX`、`batchXXX` 进入通用 NodeRun / Executor / Repository / 查询协议时，必须先判断是否实际表达通用 Execution 概念。禁止为每种 Composite 复制一组互斥归属字段或一套运行详情基础设施；专属字段可以留在 Strategy、节点 contract 或经校验的 extension。业务名出现在业务节点中、Iteration 名出现在 Iteration Strategy 中，本身都不是抽象缺陷。

实施新能力前先判断它属于业务 Node / Plugin，还是跨节点共享的编排基础能力，并检查已有 Graph、Binding、Scope、Run 和 Artifact 是否可复用。不为了抽象而抽象，不预建尚未获准的 Loop / Batch，也不把已接入的内嵌 SubWorkflow v1 扩展成跨版本调用，不强迫业务节点去业务化。当前执行模型见[架构](architecture.md#execution-归属审计)，演进设计与授权边界见[实施方案](implementation-plan.md#execution-tree-演进设计)。

## Provider、数据与副作用

已确定的产品模型是 Provider Catalog → Provider Definition → Provider Instance → Credential → Model Configuration。普通用户选择预设 Provider，填写该 Provider 要求的凭证，再选择或配置模型。Custom OpenAI-Compatible 允许高级用户配置 endpoint、API Key 和 model；当前保留 `openai_compatible@1`，它不作为所有 Provider 的基础交互。文本厂商协议由对应插件在内部适配。图片、视频、音频按 Provider 使用各自插件，不建一个覆盖全部模态的 Provider 抽象。实际目录与已接入范围见当前架构，未交付能力不能从候选模型推断。

草稿修改不影响已有运行。跨运行复用靠显式 Asset 引用，不靠复用可变 State。新素材写入 RustFS，不静默回退本地文件。

重试必须区分可安全重试的操作和可能收费的生成。受理结果不明时不能盲目重发，不承诺外部调用 exactly-once。人工确认、生成、运行和继续下游各自需要明确操作。

上下文与建议尚未实现，约束先成立：不把全部 State 或聊天自动加入提示词；原始对话与摘要分开；建议携带基础版本。用户确认应用时重新检查权限、Schema、版本和幂等性。应用建议不自动触发生成或运行。

协议见 [Workflow](workflow-model.md)、[Node](node-model.md)、[数据模型](data-model.md) 和 [Runtime](runtime-architecture.md)。
