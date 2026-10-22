# 当前架构与目录职责

本文件维护已实现能力和公开接口。协议约束分别见 [Workflow](workflow-model.md)、[Node](node-model.md)、[数据模型](data-model.md) 与 [Runtime](runtime-architecture.md)；阶段只见[实施方案](implementation-plan.md)。

## 已实现的基础工程

已有登录、账户中心、项目管理、React Flow 草稿编辑和项目模型管理。前端使用 Next.js App Router、Ant Design、TanStack Query；业务 API 默认认证，项目按当前所有者隔离。

Web 可加载 / 保存真实草稿、移动节点、编辑 Data / Control Edge；尚无节点添加 / 配置、节点模型选择、发布和运行操作。服务端已有正式发布与 Run HTTP。每项目一个逻辑 Workflow，Project 与 Draft 分别保存 revision，发布另有 version。

PostgreSQL / Prisma 保存业务记录，Redis / BullMQ 交付执行命令，RustFS 保存内容，官方 PostgreSQL Checkpointer 保存图快照。API 负责提交，独立 Worker 执行图。

## Workflow 基础库

`packages/contracts` 定义中立 JSON 协议；`packages/workflow` 提供类型 / 节点 Registry、发布静态校验、Binding / Codec、Action Compiler、Submission 与 Runner。普通确定性 Action DAG 已可执行；其他 executionKind 只有声明边界。

草稿可保留未完成配置；发布严格验证真实节点 / 端口、类型、必填来源及本地模型绑定。版本保存完整不可变定义，以 workflowId / version、workflowId / sourceRevision 唯一约束保护。执行只读取指定版本，不回退 draft / latest。

## Workflow 编辑 HTTP API

以下接口均以 `/api/v1` 为前缀，默认认证、no-store；写入检查 Origin。资源不存在或无权访问统一 404。

| 方法与路径                         | 行为                                            |
| ---------------------------------- | ----------------------------------------------- |
| GET / POST /projects               | 项目列表 / 创建；新建时原子创建默认 Workflow    |
| GET / PUT /projects/:id            | 读取 / 按 revision 保存名称与视口               |
| GET /projects/:projectId/workflow  | 读取完整草稿；缺失时不隐式创建                  |
| POST /projects/:projectId/workflow | 空请求或 `{}` 幂等初始化；保留已有草稿          |
| PUT /workflows/:workflowId/draft   | `{ expectedRevision, definition }` 保存完整草稿 |

Project 不嵌入图内容。草稿保存与项目保存独立，冲突返回 409；保存不发布、不调用模型、不创建 Run。初始化按项目行锁和唯一约束落实幂等。

## Workflow 发布与版本 HTTP API

| 方法与路径                          | 行为                                              |
| ----------------------------------- | ------------------------------------------------- |
| POST /workflows/:workflowId/publish | `{ expectedRevision }`，返回 201 与完整快照       |
| GET /workflows/:workflowId/versions | 版本倒序摘要，最多 20 条，使用 beforeVersion 分页 |
| GET /workflow-versions/:versionId   | 读取指定完整快照                                  |

发布事务锁定 Workflow，校验来源修订并分配版本号；过期 / 重复修订返回 409，失败不写版本、不消耗版本号。当前拒绝 Asset 绑定、命名控制端口和非 Action 结构。文本模型归属、enabled、插件能力及参数在同一事务中验证并持有共享行锁；不读取密文、不解密或探活。

## 生产 Runtime 装配

API 只装配 Submission / Queue；Worker 装配 Consumer、Outbox Pump 和执行服务。`WorkflowExecutionService` 核验持久意图，从 Run 读取真实项目 / 所有者，再构造有权限作用域的 Runner、Executor、能力和 Artifact 服务，不跨用户缓存 Runner。

Node 目录与执行共用 `WorkflowNodeRegistryModule`。`ArtifactRuntimeFactory.forRun` 提供真实 Writer / Resolver / Codec；`WorkflowCapabilitiesFactory.forRun` 提供按 Run 授权的能力调用。服务对象不进入 State 或 checkpoint。

## Workflow Run HTTP API

| 方法与路径                        | 行为                                              |
| --------------------------------- | ------------------------------------------------- |
| POST /workflow-runs               | `{ workflowVersionId, inputs }`，受理成功返回 202 |
| GET /workflow-runs/:runId         | 状态、输入、最终输出和安全错误摘要                |
| POST /workflow-runs/:runId/resume | `{ value }`，受理成功返回 202                     |

身份由当前用户与固定版本派生，拒绝客户端提供 threadId、状态或项目归属。响应不公开 threadId / executionId；非 waiting 或重复恢复意图为 409。HTTP 在事务提交后确认入队；503 仍可能已保存可执行意图，不能据此盲目重提。

## Workflow Execution Queue

Run 与 start Outbox 同事务写入；resume 在行锁下按 waitingRevision 创建唯一恢复意图。Job 只携带 kind、workflowRunId，resume 另含 executionId / value，不复制定义、State 或 thread。

Worker 在执行前核对意图并原子 claim。claim 前基础设施故障可以重投；业务失败不自动重跑。claim 后进程退出或结果不明进入 recovery_required，Run 保留真实状态；已有 completed / 下一 waiting 只补记意图终态。没有自动恢复或人工处理入口，详见 [Runtime](runtime-architecture.md)。

## PostgreSQL Checkpointer

API / Worker 启动时通过应用级 `WorkflowCheckpointerService` 初始化官方 PostgresSaver，在同一 DATABASE_URL 的 langgraph schema 持久化。独立 pg 连接池、串行 setup 与真实读取健康检查，不提供内存回退；配置和备份见[部署](deployment.md#langgraph-postgresql-checkpointer)。

## 数据与 Node 基础库

`DataTypeRegistry` 负责真实值校验；共享 `isTypeAssignable` 负责静态兼容。`NodeRegistry` 按 type / version 精确匹配，公开 JSON Manifest。生产节点目录目前只有 `ai.text_generate@1`，GET /workflow/node-types 不公开实现或凭证。

NodeExecutor 统一执行绑定、输入记录、decode、三组 Schema、业务调用、encode 和完成记录。NodeRun 独立保存 attempt 与业务历史；State 只保留当前 RuntimeValue。完整失败与恢复规则见 Runtime，值和引用规则见数据模型。

## 文本 AI 与 Provider Plugin

NodeType、Capability、Provider、Plugin 彼此独立。`ai.text_generate` 是工作流中的业务节点；`text.generate` 是它请求的能力；OpenAI、Anthropic 是用户使用的模型服务；`text_generation@1` 是执行该能力的受信任插件。Vercel AI SDK 只出现在这个插件内部，用来完成 OpenAI / Anthropic 文本协议。

已落地的正式文本链：

```text
Workflow Node
→ text.generate
→ ModelConfiguration
→ Provider Instance
→ ProviderCapability
→ text_generation@1
→ Vercel AI SDK
→ Provider API
```

Node 输入为 prompt / 可选 system，输出为 text，config 只保存 modelConfigurationId。当前正式支持 OpenAI 与 Anthropic。

已确定的产品模型是：

```text
Provider Catalog
→ Provider Definition
→ Model Catalog
→ Provider Instance
→ Credential
→ Model Configuration
```

平台可以预设 OpenAI、Anthropic、DeepSeek、Gemini、Qwen、Kimi、智谱、豆包等 Provider。普通用户选择 Provider，填写该 Provider 要求的凭证，再从 Model Catalog 选择该 Provider 下具备所需 Capability 的模型。自定义 endpoint、协议或厂商身份只属于高级 Custom OpenAI-Compatible。Model Catalog 是代码中的模型与能力目录，不是项目里保存的 ModelConfiguration；节点仍只保存 modelConfigurationId。

| 插件                | 定位                                                                                                                            |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| text_generation@1   | 正式文本实现。内部使用 ai 7.0.148、OpenAI 4.0.99、Anthropic 4.0.85，按 configuration.provider 调用 Chat Completions 或 Messages |
| openai_compatible@1 | 高级 Custom OpenAI-Compatible。保留 LangChain ChatOpenAICompletions，配置兼容地址、模型和 apiKey                                |

图片、视频、音频按各自 Provider 使用对应插件，例如视频原生适配、ComfyUI 图像或语音插件。文本插件和 Vercel AI SDK 只覆盖当前的 `text.generate`。LiteLLM 与 Bifrost 已评估并否决，证据在 experiments，不进入生产依赖。

OpenAI 与 Anthropic 的 Provider Definition 随代码发布，不进数据库。两者都映射到 `text_generation@1`：OpenAI 固定 `https://api.openai.com/v1`，Anthropic 固定 `https://api.anthropic.com/v1`。用户通过目录创建实例时只提交凭证；`provider` 与 `baseURL` 由定义写入实例 configuration。`ModelProvider.providerDefinitionId` 记录这个关联，直接按插件创建的实例（含 `openai_compatible@1`）该字段为空。其他厂商尚未注册。

Registry 统一校验配置、凭证、输入输出及模型参数，精确绑定插件版本，不自动切换。`text_generation@1` 的 maxOutputTokens 必填（1—65536），temperature 可选（0—1）。`openai_compatible@1` 两项可选，temperature 为 0—2。timeoutMs 默认 60000，范围 100—180000。HTTP(S) endpoint 拒绝 userinfo、query、fragment。

Provider 与模型绑定不可改写；凭证可轮换，enabled 可变。每次 invocation 检查 running Run、当前所有者 / 项目及 enabled，再经 SecretsService（AES-256-GCM，ownerId 作 AAD）解密当前凭证。SDK client / model 按调用创建，无全局 credential 缓存，无 SDK / Gateway 领域 ID。

`text_generation@1` 显式 maxRetries=0、isStepCount(1)，custom fetch 使用 manual redirect；关闭 telemetry 和原始请求 / 响应收集。内部检查 OpenAI refusal，在自动日志前拒绝 SDK warnings，将 statusCode 映射至既有安全错误。`openai_compatible@1` 保留原重试 / tracing / 日志隔离与 LANGCHAIN_VERBOSE 拒绝机制。拒绝空白、截断、过滤、工具调用等无效文本，成功仅返回 `{text}`。

原始 SDK / Provider 错误、headers、凭证不进入 NodeRun / API 错误投影；正常 NodeRun.inputs 仍记录显式 prompt。超时或 5xx 按受理结果不明处理，不自动重发。既有 CapabilityInvoker 尚未透传取消信号，生产调用依赖插件 deadline。

生产链测试覆盖真实鉴权 HTTP、发布、Outbox、BullMQ、独立 Worker 和两种本机协议，以及凭证轮换、权限隔离、单次失败请求与安全投影。OpenAI / Anthropic 收费模型未在 C2.1 调用；旧兼容插件另有操作者显式选择服务的 live 验收。复验入口见[开发指南](development.md)。

## Plugin / Provider / 模型配置管理 HTTP

| 方法与路径                                                     | 行为                                                                                                |
| -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| GET /provider-plugins                                          | 受信任且允许配置的插件精确版本、JSON Schema 和凭证字段约束                                          |
| GET /provider-catalog                                          | 官方 Provider 的安全目录：id、名称、能力、凭证字段和用户配置 Schema                                 |
| GET /model-catalog                                             | 官方模型目录。可选 `capability` 精确筛选；项含稳定模型 id、显示名、providerDefinitionId 和能力      |
| GET / POST /projects/:projectId/providers                      | Provider 列表 / 按插件 Schema 创建                                                                  |
| POST /projects/:projectId/providers/catalog                    | 按 Provider Definition 创建实例。请求为定义 id、名称和凭证；官方 Provider 不接受用户填写的 endpoint |
| GET / PATCH /projects/:projectId/providers/:providerId         | 安全详情 / 修改 enabled                                                                             |
| PUT /projects/:projectId/providers/:providerId/credentials     | 完整替换凭证                                                                                        |
| GET / POST /projects/:projectId/model-configurations           | 模型配置列表 / 创建                                                                                 |
| GET / PATCH /projects/:projectId/model-configurations/:modelId | 模型详情 / 修改 enabled                                                                             |

所有业务读写按项目所有者授权。列表为有界游标分页；读取投影排除凭证明文和密文。无效参数 / Schema 为安全 400，停用绑定为 409，密钥或服务不可用为安全 503。没有删除、原地改绑、调用厂商 API 的模型发现或远程插件安装。Provider Catalog 与 Model Catalog 目前只有 OpenAI 与 Anthropic：前者是服务定义，后者是 `gpt-4o` 与 `claude-sonnet-4-20250514` 两个 `text.generate` 模型。目录不含用户 API Key。ModelConfiguration 仍是项目内的模型实例，执行链不读取 Catalog。

## Web 项目模型设置

项目画布内提供模型设置抽屉。模型供应商页以 Provider Catalog 为卡片，展示目录中的名称和能力；未配置时按 credentialFields 提交目录创建接口，已配置由同一定义的 Provider Instance 判断，并可轮换凭证和启停。自定义接入单独保留插件 Schema。模型页仍手写模型 id。`ai.text_generate` 的 model-selector 按节点声明的 `text.generate` 查询 Model Catalog，按 Provider 分组展示显示名；已有可选 ModelConfiguration 时只把 `modelConfigurationId` 写入节点。Provider 未配置时进入对应的凭证配置。Provider 已配置但该目录模型还没有 ModelConfiguration 时，沿用模型配置创建接口，并填写该能力已有的生成参数。未知结构禁止提交。Secret 不进入 Form store、Query / Mutation 缓存、URL 或浏览器存储；请求发出及退出组件时清空，不回填已保存值。创建 / 轮换不触发模型生成，设置操作不丢失未保存画布。

## Artifact 生产数据通道

PostgreSQL 保存 Artifact 身份、来源、类型、JSON / blob 编码、私有 key、大小与摘要；内容统一写 RustFS。Writer 先登记 writing，上传后确认 ready，只有 ready 可解析。失败补偿、提交结果不明及保留记录见[对象存储](object-storage.md)。

JSON decode 还原业务值；媒体使用 BinaryContent，blob decode 返回含临时 signed URL 的 MediaResource。引用授权限定项目 / Run，不自动下载任意 URL，不把临时 URL 回写 State。Asset 版本读取、Promote、资产库、自动对账与垃圾回收尚未实现。

## React Flow 数据适配

React Flow 只管理视图，平台 WorkflowDefinition 是持久内容。renderer 读取精确 Manifest；数据 / 控制 Handle 隔离，selected / dragging / measured 不保存。端口、单连接、类型和过期事件规则见[Node](node-model.md)。

### Web Workflow Draft 持久化

真实草稿可加载、保存并刷新恢复；旧项目缺失 Workflow 时显式初始化，不用本地空图兜底。Project（名称 / 视口）与 Draft 各自维护 revision、脏状态和冲突处理。保存失败保留编辑，409 后经明确操作重读对应资源，不覆盖另一类未保存内容。

## 目录与依赖

| 目录               | 职责                                                     |
| ------------------ | -------------------------------------------------------- |
| apps/web           | 编辑器、账户 / 项目 / 模型管理与前端适配                 |
| apps/api           | 身份与业务 HTTP，提交运行                                |
| apps/worker        | Outbox Pump、队列消费与图执行                            |
| packages/contracts | 无框架依赖的 JSON 协议和 Schema                          |
| packages/workflow  | 领域校验、Registry、Compiler、Codec、Submission / Runner |
| packages/server    | 共享基础设施、授权 Repository、凭证与 Runtime 装配       |
| packages/plugins   | 受信任 ProviderCapability 实现与 PluginRegistry          |
| packages/database  | Prisma 模型与业务迁移；pgvector                          |
| packages/context   | 空入口，尚未实现上下文构建                               |

历史技术证据在 experiments，默认不读、不进入生产镜像；路线结论见实施方案。
