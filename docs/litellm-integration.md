# LiteLLM 集成架构评估

本文记录拟议的集成边界，不表示功能已交付。代码核对基线为 `19ba4f4`；资料核对日期为 2026-10-21，读取了用户提供的[中文文档](https://docs.litellm.com.cn/docs/)、[上游文档](https://docs.litellm.ai/docs/)与 BerriAI 官方源码。在线文档和 `main` 不能替代固定发行版验收。当前阶段、下一步和任务依赖统一维护在[实施方案](implementation-plan.md#litellm-集成任务拆解)；已实现能力仍以[当前架构](architecture.md#文本-ai-与-provider-plugin)为准。

## 推荐结论

采用独立、内网部署的 LiteLLM Gateway，作为受信任 `litellm@1` 插件的底层 AI 协议兼容服务。保留 DramaFlow 的 Provider Instance、Model Configuration、凭证加密、能力契约、发布校验和 Worker 解析。模型配置只由 DramaFlow 管理；不建立 LiteLLM 用户模型数据库或双向配置同步。

这是跨插件契约、Secret 传输、部署和 A4 目录展示的改造，超过一次局部 Adapter 替换。应先验证固定版本的 Gateway 行为，再分步接入；不通过修改现有 `openai_compatible@1` 的 endpoint 就宣布完成。

逻辑绑定保持：

```text
Workflow Node → Capability → Model Configuration
→ DramaFlow Provider Instance → litellm@1 → LiteLLM Gateway → 实际厂商
```

执行链保持：

```text
HTTP → PostgreSQL Outbox → BullMQ → Worker → WorkflowRunner
→ NodeExecutor → CapabilityInvoker → PluginRegistry → litellm@1
→ LiteLLM Gateway → Provider
```

Gateway 不读取 DramaFlow 数据库，不消费 BullMQ，不执行 LangGraph，不拥有 WorkflowRun / NodeRun。浏览器只访问 DramaFlow API。API 保存、列表、启停及发布仍不调用模型；目录数据优先使用本地固定版本快照，Gateway 暂时不可用不应阻止编辑与静态发布校验。

| 形式                                 | 判断                                                                                                      |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| 独立 Gateway 服务                    | 首选。符合已有独立 Worker 和 Compose 服务结构，可独立固定版本、重启、观测和扩容                           |
| 每个 Worker 的 sidecar               | 后续有隔离或延迟需求时可选；会随 Worker 复制 Python 进程、连接池和部署配置，不是当前必要条件              |
| Node Worker 内嵌 Python SDK / 子进程 | 不采用，增加进程生命周期和跨语言接口负担                                                                  |
| 自建 Python 兼容服务                 | 不作为首选；若官方 Gateway 在固定版本中缺少必要安全边界，应先说明缺口，不立即维护新的网关或逐厂商 Adapter |

## 当前代码决定的约束

以下是影响方案的代码证据；完整现状不在本文重复维护。

| 代码入口                                                                                                                                            | 对集成的影响                                                                                                            |
| --------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| [文本节点](../packages/workflow/src/node/text-generation.ts)                                                                                        | 只保存 `modelConfigurationId` 并请求 `text.generate`，可继续与 Provider 无关                                            |
| [运行时解析](../packages/server/src/models/workflow-capabilities.factory.ts)                                                                        | 每次检查 running Run、项目所有者、模型 / Provider enabled 和 capability 后解密；这一权限顺序须保留                      |
| [模型管理服务](../packages/server/src/models/model-provider.service.ts)                                                                             | 创建、轮换、静态可选性、发布分别使用插件 Schema；扩展配置描述时必须一起覆盖这些路径                                     |
| [数据库迁移](../packages/database/prisma/migrations/20261020070000_model_providers/migration.sql)                                                   | 触发器固定 Provider 配置及模型绑定，只有凭证与 enabled 可更新；不能原地把旧实例改为 LiteLLM                             |
| [SecretsService](../packages/server/src/secrets/secrets.service.ts)                                                                                 | AES-256-GCM + ownerId AAD 可继续使用；当前轮换是替换 Provider credential，加密主密钥没有自动重加密轮换机制              |
| [插件接口](../packages/plugins/src/provider-plugin.ts)、[Registry](../packages/plugins/src/plugin-registry.ts)                                      | 每个插件目前只有一套配置 / 凭证 Schema，每个 capability 只有一套模型参数 Schema，尚不足以表达同一插件下多种厂商认证形态 |
| [现有兼容插件](../packages/plugins/src/openai-compatible.ts)                                                                                        | 已关闭 SDK / LangChain 重试、流式和 tracing；仅改 baseURL 会把现有 apiKey 用作 Gateway 认证，缺少独立的上游凭证通道     |
| [A4 表单](../apps/web/src/features/models/model-forms.tsx)、[Schema 编译](../apps/web/src/features/models/schema-fields.ts)                         | 当前“接入方式”直接枚举插件，表单仅支持扁平标量对象，不能直接接任意上游 Schema                                           |
| [节点错误投影](../packages/workflow/src/runtime/node-execution-error.ts)、[执行服务](../packages/server/src/workflow/workflow-execution.service.ts) | 外部错误仍沿 execute 失败路径；`recovery_required` 属于 Outbox 的结果不明保护，不是新的模型错误状态                     |

## 配置所有权

| 对象 / 字段                                      | 唯一权威来源                               | LiteLLM 接收或管理的内容                         |
| ------------------------------------------------ | ------------------------------------------ | ------------------------------------------------ |
| Provider Instance、项目归属、显示名              | DramaFlow                                  | 不创建对应用户资源                               |
| 实际 provider 类型 / 接入档案                    | DramaFlow 不可变配置                       | 执行请求中的明确路由标识                         |
| 上游 endpoint、region、API version 等            | DramaFlow Provider configuration           | 本次请求所需的字段；可受管理员出口策略限制       |
| Provider credential                              | DramaFlow encryptedCredentials             | 运行期间按需使用明文，不写用户凭证库             |
| model / deployment 名称                          | DramaFlow Model Configuration              | 明确的实际模型，不依赖可变业务 alias             |
| model settings                                   | DramaFlow Model Configuration              | 已校验的标准参数，由 LiteLLM 转换厂商协议        |
| capability 定义、输入 / 输出及实现资格           | DramaFlow contracts + 受信任 Plugin        | 支持信息作为证据，不能直接改写领域契约           |
| enabled                                          | DramaFlow                                  | 调用前拒绝停用项，无需同步网关                   |
| Gateway 地址、服务认证、镜像版本、出口和日志策略 | 部署配置                                   | 平台级基础设施配置，不是用户 Provider Instance   |
| 厂商 / 模型参考目录                              | LiteLLM 版本化资料，DramaFlow 保存派生快照 | 只读参考资料，不是用户已配置模型或权限的权威来源 |

网关可以有少量部署级 provider wildcard 路由，例如已验收的 `deepseek/*`、`anthropic/*`；这些是受控协议入口，不按用户 / 项目 / Model Configuration 生成条目。Worker 从明确选择的 Provider 和模型构造路由名，拒绝模型名覆盖已选 Provider、任意 router 参数及未开放能力。不要开放不受限制的全局 `*` 入口。

不调用 `/model/new`、credential 管理 API 或 Admin UI 来同步 DramaFlow 记录，也不向网关复制 DramaFlow 用户 / team / project 权限。LiteLLM 的数据库模型管理是另一种合法产品模式，但本项目已有 A3/A4，启用它会引入第二套可变配置与轮换流程。[上游 Model Management](https://docs.litellm.ai/docs/proxy/model_management)和[配置覆盖规则](https://docs.litellm.ai/docs/proxy/configs)说明了其数据库所有权行为。

## Secret 流转与网关认证

推荐按以下顺序执行：

1. 用户经现有受鉴权创建 / 轮换 API 提交完整凭证，服务端校验后加密存入 DramaFlow；读取 DTO 继续排除明文和密文。
2. Worker 按运行重新核验项目权限、Provider / 模型状态与能力，在执行边界解密。
3. 插件在隔离的 transport 中构造请求。Gateway 服务凭证用于 `Authorization`；厂商凭证使用 LiteLLM 官方 clientside credentials 请求字段，例如 `api_key`。上游地址使用 `api_base`，Azure 等需要独立验证 `api_version` 或对应认证字段。
4. Gateway 在服务端内存中使用上游凭证调用明确 Provider，返回标准结果；DramaFlow 只保留安全输出与错误摘要。
5. 后续调用重新读取密文；轮换后的新凭证自然生效，无网关同步窗口。已发出的调用不被追溯替换，停用也不等于撤回厂商已受理请求。

官方 [Clientside LLM Credentials](https://docs.litellm.ai/docs/proxy/clientside_auth)提供这条路径；`api_base` / `base_url` 的请求覆盖受配置授权控制。优先按 provider 路由限定覆盖字段和 endpoint 范围，不因支持 BYOK 就允许任意请求字典。`user_config` 也能携带完整 Router 配置，但会扩大可控路由、重试和配置处理范围，本方案不把它作为常规请求格式。

Gateway 是新增的明文 Secret 信任边界，不能声称凭证永远不离开 Worker，也不能承诺 Python / Node 堆内字符串在请求结束后立即擦除。目标是无应用级持久副本、无跨用户复用、无日志 / trace / 请求镜像泄漏；SDK 连接缓存、异常和后台 callback 仍需用固定镜像做验证。

具体约束如下：

- 不给 Gateway 挂载 DramaFlow `.env`、`CREDENTIAL_ENCRYPTION_KEY`、数据库连接或对象存储凭证；尤其不能复用 Compose 的整个 `x-app-environment`。
- 首期不配置 LiteLLM DB / Redis，不启用模型存储、用户虚拟密钥体系、响应缓存、spend payload 日志或第三方 tracing callback。关闭 debug 并验证正常及异常日志；“未连接 DB”本身不能证明无泄密。
- 无数据库的最小服务认证可以采用强随机 master key，官方鉴权源码存在该路径；它具有管理员权限，不能伪称为受限 inference key。仅受信任服务持有，禁止公开网关，限制可访问路径并关闭 Admin UI。需要细粒度机器身份时，另行验证官方 custom auth / 既有 mTLS 入口；不默认为每个用户创建网关 key 或另开数据库。[鉴权源码](https://github.com/BerriAI/litellm/blob/main/litellm/proxy/auth/user_api_key_auth.py)、[Custom Auth](https://docs.litellm.ai/docs/proxy/custom_auth)。
- 同机私有容器网络不发布 Gateway 宿主端口；跨主机使用 TLS / mTLS。实际 Provider 使用 HTTPS；本地模型地址必须由管理员显式允许，不能通过自定义 api_base 访问云 metadata 或平台内部管理服务。重定向和解析后的目标也要验证，延续现有插件拒绝自动重定向的边界。
- transport 只把 allowlist 字段送入请求，Secret 不放在 messages、metadata、LangChain 通用配置、Workflow、Outbox、NodeRun 或 checkpoint 中。不将 LiteLLM 原始错误正文转发给客户端。
- Gateway 不配置默认用户厂商凭证；缺失凭证应在 DramaFlow 边界失败，不能降级使用宿主环境或另一个账户。并发使用同一模型的两个 Provider Instance 必须分别命中各自 credential / endpoint。

API Key 不能概括全部认证。Bedrock 的临时 AWS 凭证、region，Vertex 的项目 / 地域 / 服务账户或工作负载身份，Azure 的 API version / deployment，需要各自的接入档案及验收。当前 `Record<string, string>` 可容纳多个秘密字段或 JSON 字符串，但不能因此宣称已支持完整 IAM / OAuth 生命周期。若某认证模式只能使用网关主机身份，它必须是管理员显式建立、用户明确选用的独立接入档案；不静默替代用户凭证，也不必因此转移所有 Secret 所有权。

## Provider、Plugin 与 Capability 调整

新增官方内置 `litellm@1`，不改写 `openai_compatible@1` 的行为。现有插件继续服务旧绑定及明确选择的直接兼容协议接入；新 Provider 按用户选择使用 LiteLLM。可以复用文本输出校验、标准参数映射等小型 helper，不先抽取覆盖所有未来外部服务的统一执行框架。

Plugin 表示受信任能力实现，Provider Instance 表示具体配置与凭证。一个 LiteLLM 插件覆盖多个实际 AI Provider；将来 ComfyUI、Kling Native、FFmpeg、外部 Service 仍是独立实现。无需现在把所有非 AI 服务强塞入 Model Configuration，也不把当前 `ProviderPlugin` 接口扩成动态安装系统。

建议增加服务端“接入档案 / connection profile”描述层：

- 同一个 `litellm@1` 可以发布多个真实 Provider 档案，各自提供安全配置 Schema、凭证字段、开放能力与参数约束。档案 ID 与 Plugin ID 分开，内部仍精确绑定插件版本。
- 在不可变 `Provider.configuration` 中记录稳定判别字段，如 `providerType`；其余字段按选定档案校验。Gateway 地址不放在用户 endpoint 字段中，`baseURL` 若保留只表示上游地址。
- Registry 统一根据插件版本和 configuration 解析有效 Schema；创建、凭证轮换、模型创建、可选性、发布及 invoke 均使用同一解析规则。原插件保留单一默认档案语义。
- 当前接口要求 `z.ZodObject`，不能只换成 discriminated union 就结束。公开目录应为选定档案提供可呈现的扁平 Schema，服务端继续做完整交叉字段校验。
- 模型 settings 需要考虑 provider / model 差异；现有 temperature 与 maxOutputTokens 可作为首批标准领域参数，不开放任意 `extra_body`。网关设置 `drop_params=false`，不静默删除用户选择的参数。模型特有参数仅在档案支持并完成测试时开放。
- Plugin 版本还应绑定经过测试的 Gateway 协议范围及目录快照。固定镜像 digest；升级时验收旧绑定，不用浮动 `latest` 或在线 metadata 改写已有配置意义。

上述字段可以先放入既有 JSON configuration / settings，预计不需要新增业务表、重建迁移或同步数据库。若后续确有跨实例查询 / 索引需求，再评估独立列。更换旧 Provider 的插件、endpoint 或模型时创建新资源，只有用户明确修改草稿绑定并发布后才用于新的版本；已有 WorkflowVersion 不迁移。

Capability 是平台协议，是否实现由 Plugin 声明并验收。例如 `image.generate` 可以绑定 LiteLLM，也可以绑定 ComfyUI；`video.generate` 可以绑定 LiteLLM 或原生服务。一个模型有视觉输入能力不等于它能生成图片，也不意味着目前只接受文本的 `text.generate` 已支持多模态输入。

## A4、模型发现与 A6

A4 的“供应商 → 多个模型配置”产品结构继续成立。需要改的是接入目录：普通用户先选择“DeepSeek”“Anthropic（Claude）”“OpenAI”“Gemini”等实际接入服务；Claude 是模型系列，Bedrock / Azure 是不同接入渠道，同名模型跨渠道不能混为一个 Provider。LiteLLM 实现身份可以留在管理员诊断信息中，普通创建流程不要求理解它。

前端从 DramaFlow 安全目录获取上述选项，不硬编码另一套厂商表；选择接入档案后展示经过筛选的 endpoint / 地域 / 认证字段。默认 endpoint 如来自档案，必须可见并随创建固化，不隐藏选择厂商。同名模型的不同参数配置继续用配置 ID 区分，凭证独立输入、清空和轮换机制继续复用。

LiteLLM 能降低目录维护成本，但不能直接作为完整 A4 表单规范或 A6 权限来源：

| 资料 / 接口                                                               | 可靠用途                                            | 不可推导的结论                                                                                                          |
| ------------------------------------------------------------------------- | --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `provider_list`、`get_provider_fields`；当前源码的 `GET /model/settings`  | 厂商标识与认证 / 配置字段候选，可构建版本化接入档案 | 不是完整稳定 JSON Schema；`/model/settings` 标记为 `include_in_schema=False`，不能当长期稳定公共契约                    |
| 模型 cost / context map，`get_model_info`；当前源码的 `/utils/model_info` | 型号建议、上下文上限、mode、`supports_*` 信息       | 不保证完整、实时、地区适用，也不证明账户有权限或额度                                                                    |
| `get_supported_openai_params` / `/utils/supported_openai_params`          | 精确 provider + model 的标准参数名参考              | 不等于类型、范围、枚举、参数互斥等完整校验 Schema                                                                       |
| `/model/info`、`/model_group/info`、通常的 `/v1/models`                   | Gateway 已配置部署 / 分组 / 可见模型的信息          | 不是 DramaFlow Model Configuration 目录，不应该据此创建第二套模型实例                                                   |
| wildcard + `check_provider_endpoint`                                      | 部分 Provider 的真实上游模型发现                    | 文档明确使用部署 credential 或网关环境凭证，不使用调用者转发到 `/v1/models` 的 Provider key；列表仍不代表当前用户可调用 |

源码入口见[官方 proxy_server.py](https://github.com/BerriAI/litellm/blob/main/litellm/proxy/proxy_server.py)，模型资料见[官方 cost map](https://github.com/BerriAI/litellm/blob/main/model_prices_and_context_window.json)，参数行为见[Input Params](https://docs.litellm.ai/docs/completion/input)，发现权限边界见[Model Discovery](https://docs.litellm.ai/docs/proxy/model_discovery)。这些入口须与选定发行版重新对照，不保证 `main` 上的新 utility 已进入该发行版。

优先在构建 / 升级时提取并校验 metadata，生成本地只读目录，记录来源版本；只暴露已支持的档案，凭证字段过滤默认值、示例等内容。DramaFlow 仍维护中文展示、安全分类、可呈现字段子集、标准参数约束及少量差异，不再维护厂商 HTTP 协议。未知 Schema 明确拒绝，未知模型保留手填 / 未验证提示，不将缺失 metadata 自动判断为不支持，也不以支持声明证明可访问。

模型列表建议区分“已配置”“目录收录”“该凭证最近探测到”，后者若建设，必须显式操作、按项目 / Provider 和凭证轮换版本隔离缓存；无密码读取接口不能被悄悄改成探测。当前方案不为补齐动态发现引入常驻凭证副本。生成式连通性测试可能收费，不能在保存或发布时隐式执行。

A6 仍按 Node 所需 capability 读取 DramaFlow 的 Model Configuration，结合本地 availability 选择并保存 ID；不直接访问 LiteLLM，不保存 provider 字符串 / gateway model alias，不自动切换停用引用。目录和远程发现只改善推荐与提示，不是 A6 的前置条件。本轮不实施 A6 或 Prompt / Variable / Context Selector。

## 部署与故障责任

LiteLLM 提供 retry / fallback 能力，但其默认值和多层 SDK 行为不能直接继承。首期要求 LangChain、Worker HTTP client、LiteLLM Router、LiteLLM 内部 SDK 以及任何转发代理的生成 POST 重试均关闭；同时关闭普通、上下文窗口、内容策略和流中 fallback，不做自动切换模型 / 厂商。官方[配置参考](https://docs.litellm.ai/docs/proxy/config_settings)、[Fallbacks](https://docs.litellm.ai/docs/proxy/reliability)、[Timeouts](https://docs.litellm.ai/docs/proxy/timeout)提供配置入口，但最终验收以模拟上游实际收到的请求次数为准。

| 场景                 | 责任与行为                                                                                                                                                                                   |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| timeout              | DramaFlow 定义调用预算；Worker 强制覆盖连接及完整响应体的总 deadline，Gateway 上游 timeout 略短，留出返回错误余量。传递取消信号只用于中断本地等待，不证明厂商未计费                          |
| retry                | Outbox / BullMQ 只按现有规则重投未 claim 的执行命令、补记终态；不能据网关 429 / 503 重跑整个 Workflow。首期生成调用零自动重试；未来如增加重试，必须独立定义可证明未受理的边界                |
| rate limit           | Provider 决定其真实配额；Gateway 可负责部署级并发背压与限流拒绝，DramaFlow 负责用户可见状态和平台调度。429 与 Retry-After 是提示，不自动换模型。无共享存储不能声称有跨网关副本的全局精确限流 |
| LiteLLM unavailable  | 若可证明连接建立前失败，记录网关不可达；否则保守判断 outcome unknown。已 claim 的本次节点按既有失败路径结束，不切回直接 Provider 插件                                                        |
| Provider unavailable | Gateway 归一化协议；插件识别安全错误类别。明确拒绝与受理结果不明分开；5xx、超时或断连不能证明未受理                                                                                          |
| 已受理但连接丢失     | 不再次生成、不声称 exactly-once。进程存活且失败记录成功时，沿 NodeRun / WorkflowRun failed 和 Outbox failed；Worker 死亡或无法可靠确认执行结果时，沿现有 Outbox recovery_required 核查       |
| streaming            | 首期继续关闭。未来由 Gateway 处理厂商流、Worker 聚合 / 校验，平台单独投影进度；完整终态输出才能完成 NodeRun。浏览器断连不取消后台 Run，流中断不重新发起生成                                  |

当前 `CapabilityError` 仅提供 `rejected` / `outcome_unknown`，`externalCapabilityError` 把 4xx 归入 rejected；新增网关后不能仅靠 HTTP 状态判断原始受理阶段，尤其 408 或中间代理错误。新插件应在自身边界做保守映射，缺少证据一律 unknown；不要未经验证将新分类套到旧插件。

当前 `toNodeRunError` 仅持久化执行阶段安全摘要，不保存 `CapabilityError.outcome`，所以现有记录不能直接告诉操作者“网关拒绝 / 上游结果不明”。若本次接入需要诊断区分，增加受控、无 Secret 的错误摘要字段应作为单独可测的小变更；不改变 Run 状态机、不新增自动恢复接口。也不能把所有 unknown 一律转成 recovery_required。

插件接口虽有 `signal`，当前 `CapabilityInvoker` / 文本节点 / Worker factory 没有贯通该参数；因此不能宣称现有 Workflow 已具备端到端取消。首次接入必须至少维持插件独立总 deadline。需要传递运行取消时，应另行界定接口与行为，不将 HTTP 连接状态冒充运行取消。

首期新增基础设施仅为固定版本 Gateway 服务、只读部署策略、独立服务认证 Secret、网络 / TLS 边界、readiness / liveness 和脱敏运行指标。若使用 master key，管理路由必须有独立访问限制；可利用已有入口设施，必要时增加轻量内部反向代理，但不实现新的 AI 协议网关。不要使用会触发真实模型生成的健康检查。

不新增 LiteLLM 数据库、迁移同步器、消息队列、持久卷或独立 Redis。以后若需要分布式限流或集中预算，再单独评估共享 Redis 及存储；不能顺带接管项目权限。Gateway 的崩溃是额外故障点，应单独观测，不能让它使所有非 AI 工作流能力不可用。

## LiteLLM 覆盖的限度

官方已有 chat、embedding、图片、语音合成、转写及部分视频等端点；不能沿用“LiteLLM 只支持文本”或“所有媒体都已统一支持”这两种假设。[支持的端点](https://docs.litellm.ai/docs/supported_endpoints)、[视频能力](https://docs.litellm.ai/docs/videos)。

是否采用 LiteLLM 要按固定版本、实际 Provider、具体 capability、所需参数和任务生命周期验证。以下情况允许 Native Plugin：

- ComfyUI 的工作流图、节点输入、历史及队列协议。
- Kling 等原生渠道中 LiteLLM 未覆盖或不能完整表达的版本、参数、异步任务查询 / 取消；不能仅因有通用 `/videos` 就宣布覆盖。
- 本地 FFmpeg、内容发布、外部 Service 等非模型能力。
- 厂商专属认证或生命周期暂不能安全经过 Gateway 的情况。

HTTP passthrough 可以转发请求，但不等于已经提供领域输入输出、参数转换、异步任务恢复或素材管理。是否走 LiteLLM 与是否实现某个 DramaFlow Capability 是两次独立判断。本评估不授权媒体节点、Asset、Human Review、Agent、Batch / SubWorkflow、插件市场或动态代码安装。
