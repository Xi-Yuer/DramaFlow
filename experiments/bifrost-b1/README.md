# Bifrost B1：DramaFlow BYOK 与安全边界准入

**NO-GO。** 固定真实 Gateway 可以按请求使用用户 key，完成 OpenAI / Anthropic 协议转换，且本轮 50 个 redirect 不跟随。但 `max_retries=0` 不能关闭底层复用连接重试：Provider 读完整个 POST 后断开，Gateway 再发一次；只断开一次时最终返回 200。另有空平台 Virtual Key 绕过独立平台认证的问题。完整脱敏记录见 [result.json](result.json)，源码定位见 [source-audit.json](source-audit.json)。

本实验只验证准入，不注册生产 Plugin，不修改 apps / packages、领域模型、A4 / A6、Workflow、发布或正式 Worker。不使用真实用户 key、收费模型或业务数据库。当前阶段及下一步只维护在[实施方案](../../docs/implementation-plan.md#当前阶段)。既有 LiteLLM L1 / L2 / L2.1 证据保留。

## 业务前提

主路径是 DramaFlow 官方 Provider Definition / Catalog 预设协议、endpoint、capabilities、credential / configuration schema，用户选择 Provider 并填写 BYOK。Provider Definition 是评估方向，本轮未实现。Bifrost 只是候选 compatibility implementation，不是 Plugin System，也不是模型、凭证或用户权限的业务权威来源。

| 内容                                                           | 所有权与本次验证                                                                         |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Provider Definition、Instance、Credential、Model Configuration | DramaFlow 持有；实验不建立对应 Bifrost 用户资源                                          |
| endpoint                                                       | 主路径由平台预设；Gateway 只保留平台级协议配置                                           |
| 用户 API Key                                                   | 调用驱动以 AES-256-GCM + owner AAD 合成加密，每次 invocation 解密后放入请求头            |
| model / 参数                                                   | 每次明确传入 `provider/model`、messages、max_tokens、stream=false                        |
| Workflow 绑定                                                  | 继续是 modelConfigurationId；不增加 bifrostProviderId / bifrostModelId / bifrostConfigId |
| Custom OpenAI-Compatible                                       | 单独高级路径；缺失任意 endpoint 的请求级覆盖不构成本次 NO-GO 原因                        |
| 其他 Capability                                                | 不要求全部经过 Bifrost；Native Kling、ComfyUI 等仍可有独立 Plugin                        |

## 固定版本与复现

- 官方 [HTTP v2.3.2 release](https://github.com/maximhq/bifrost/releases/tag/transports%2Fv2.3.2)，源码 commit `a05ea20e68bf116a35e9f05b1a3d749624b3935e`。
- 镜像 tag `maximhq/bifrost:v2.3.2`，实际运行锁定 index `sha256:f5b18826349fe9e1c402c10d19f1cbb5567a3c800ad928580d07f72e69106ec7`，本机 linux/arm64 manifest 另见 [image.lock.json](image.lock.json)。不使用 latest。
- 二进制 SHA-256 `07d7a6ac0ea3f8b584ce025498d619c89daf313e47506fba70b8c1488d39bb09`；嵌入 Go `1.27.3`、core `1.13.1`、framework `1.10.1`、fasthttp `1.74.0`，运行基础 Alpine `3.23.6`。完整实际依赖见 [dependencies.lock.json](dependencies.lock.json)。四份关键 Core 文件与 `core/v1.13.1` tag 单独逐字节核对一致，不只依据 transport 分支推测。
- Oracle / TCP relay / 只读审计使用 Python `3.13.9-alpine3.22` 固定镜像，digest 见 [fixture-image.lock.json](fixture-image.lock.json)。它们只用于测试。

需要 Docker Compose、Node 24、OpenSSL。本次在 Docker Desktop linux/arm64 上执行；amd64 manifest 已锁定但未实跑。仓库根目录运行：

```sh
docker pull maximhq/bifrost@sha256:f5b18826349fe9e1c402c10d19f1cbb5567a3c800ad928580d07f72e69106ec7
docker pull python@sha256:e5fa639e49b85986c4481e28faa2564b45aa8021413f31026c3856e5911618b1
node experiments/bifrost-b1/run.mjs
```

脚本按 NO-GO 退出 1，不应改成成功退出。新结果写 `.local/bifrost-b1/<batch>/result.json`，不会覆盖已提交证据。临时合成 Secret、证书、SQLite 与容器在 finally 清理；不会加载项目 `.env`。没有 pull 默认浮动镜像，镜像缺失时应先按锁文件拉取。

## 实验网络与判据

真实官方二进制通过公开 CLI、config.json 和 Direct API Key 运行，没有修改镜像、私有字段或函数。两个 Gateway 分别验证官方默认 endpoint 和平台固定 `base_url`；第三个 file-only 启动对照退出后不常驻。所有 Provider DNS（包括 `api.openai.com` / `api.anthropic.com`）仅在 Docker internal network 指向本地 oracle，TLS 用临时 CA 严格验证，没有实际连接外部模型。双网络 relay 只转发 TCP 字节，不处理 HTTP、不重试、不改写响应。它不是拟新增生产代理。

Oracle 在**读完整个 POST body 后**记录调用 UUID、credential SHA-256 前 16 位、Host、path、TLS、源连接端口、model、body SHA-256、identity、body keys、认证头指纹及 Anthropic version。它不记录 key 原文。计数是 Provider dispatch，不是付费生成成功次数，也不宣称 exactly-once。

驱动没有 retry，fetch 不跟随 redirect；生成均为非 streaming。每个故障先 warmup，在 `max_conns_per_host=1` 下建立可确认的连接复用。故障 invocation 的记录不包含 warmup，另用 warmId 指向对照。EOF / RST 首次命中的连接与 warmup 相同，补发换新连接，body hash 与 key 不变。不能把此补发解释成不同 invocation。

## Request-level BYOK 与隔离

使用[官方 Direct API Key](https://docs.getbifrost.ai/providers/request-options#direct-api-key)：服务端 `allow_direct_keys=true`，每次请求携带 `x-bf-direct-key:true`、用户 `x-api-key`；平台 VK 使用独立 `x-bf-vk`，不混用两个 Secret。

推理主路径、A/B 32 次并发（每协议每账户 8 次）与 Gateway 重启后下一次调用均成功；每条 oracle 记录只收到本账户 credential，model / identity 一致。两种实际出站：

| 统一入口                                       | Provider wire protocol                                                                                     |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `POST /v1/chat/completions`，`openai/gpt-b1-*` | `https://api.openai.com/v1/chat/completions`，Authorization Bearer，messages，`max_completion_tokens`      |
| 同一入口，`anthropic/claude-b1-*`              | `https://api.anthropic.com/v1/messages`，x-api-key，anthropic-version `2023-06-01`，messages，`max_tokens` |

平台 VK / setup token 没有进入 Provider 请求。此实验验证协议转换及 Secret 隔离，不验证真实厂商 key 权限、模型质量或所有 Provider 的认证形态。

没有注册用户 Key、用户 Provider、用户 / project、model record 或 ModelConfiguration，也没有配置默认厂商 key。运行中 SQLite（含 WAL）核验：`config_providers=2` 是平台协议预设；`config_keys=0`、`config_models=0`、`governance_model_configs=0`。两条合成 pricing / parameter 记录只是冻结的参考 metadata，不是用户模型配置。文件及 WAL 未发现 Provider key。API catalog 前后仍为相同的两条平台预设。

`config_store.enabled=false` 的实际启动对照退出 1，原因为 `failed to initialize governance handler: config store is required`；固定版本不能声称已验证无 DB 完整 HTTP Gateway。实验使用仅承载平台配置与参考目录的临时 SQLite；不需要 PostgreSQL、Redis 或用户配置同步。重启清掉 tmpfs DB 后仍可从平台配置启动，下一请求 BYOK 即成功。

## Redirect

两协议 × 五种状态 × 五种关系，共 50 个用例。关系包括 same-origin（同 hostname/port 的 path-only Location）、hostname change、port change、HTTP→HTTPS、HTTPS→HTTP。每个 target 都由 oracle 提供对应 HTTP/TLS listener。

| Provider status | OpenAI 每次 POST | Anthropic 每次 POST | target 请求 / key / body |
| --------------- | ---------------- | ------------------- | ------------------------ |
| 301             | 1                | 1                   | 0 / 无 / 无              |
| 302             | 1                | 1                   | 0 / 无 / 无              |
| 303             | 1                | 1                   | 0 / 无 / 无              |
| 307             | 1                | 1                   | 0 / 无 / 无              |
| 308             | 1                | 1                   | 0 / 无 / 无              |

Gateway 将同一 3xx status 作为错误返回。两条文本路径最终走 fasthttp `Client.Do`，不是 `DoRedirects`；本次无需额外 no-redirect 配置。代码也有其他功能使用的 `MakeRequestWithContextFollowRedirects`，不能把本次结论推广到所有 Provider / Capability。未来调用方同样必须禁止跟随 Gateway 的 3xx。

## Fault matrix 与不可关闭的底层重试

正式公开配置 `network_config.max_retries=0`；无请求 fallback、路由规则、别名 failover、响应 cache、session stickiness 或多 key 池。provider 和 model 每次明确选择。日志和 catalog 返回也核对 max_retries=0。

| Oracle 场景             | OpenAI HTTP / POST  | Anthropic HTTP / POST |
| ----------------------- | ------------------- | --------------------- |
| 400                     | 400 / 1             | 400 / 1               |
| 401                     | 401 / 1             | 401 / 1               |
| 403                     | 403 / 1             | 403 / 1               |
| 429，Retry-After=2      | 429 / 1             | 429 / 1               |
| 500                     | 500 / 1             | 500 / 1               |
| 503                     | 503 / 1             | 503 / 1               |
| Provider timeout        | 504 / 1             | 504 / 1               |
| 收完 POST 后 EOF        | 502 / **2**         | 502 / **2**           |
| 第一次 EOF、第二次成功  | 200 / **2**         | 200 / **2**           |
| 收完 POST 后 TCP RST    | 502 / **2**         | 502 / **2**           |
| 第一次 RST、第二次成功  | 200 / **2**         | 200 / **2**           |
| malformed JSON          | 500 / 1             | 500 / 1               |
| malformed schema        | 200、空 choices / 1 | 500 / 1               |
| 200 body 部分写出后断开 | 502 / 1             | 502 / 1               |
| 正常输出故意回显 key    | 200 / 1             | 200 / 1               |

真实来源：OpenAI 与 Anthropic handler → 公共 `MakeRequestWithContext` → fasthttp `Client.Do` → `contextTransport.RoundTrip`。`ConfigureDialer` 无条件配置 `StaleConnectionRetryIfErr`。在池中复用的连接上，transport 已 `req.Write` / `Flush`，读响应头失败后仍返回 retry=true；callback 对 EOF / reset 等允许 redial。新连接上再次失败才不重试，所以此 oracle 为 2 次而不是无限重发。

源码注释把“响应头解析失败”视作 Provider 尚未处理，实测反例是 oracle 已读完整个 POST。公开 Gateway NetworkConfig 只有上层 max_retries，没有关闭此 callback 的配置入口。未找到覆盖该固定二进制的正式开关；不 monkey patch、不 fork、不为绕过它增加代理或取消连接池。

明确 Gateway 拒绝（无上游 POST）可归 definitely_rejected。Provider 401 / 403 / 429 需验证具体拒绝契约后才可认定 definitely_rejected；本次 oracle 知道它们拒绝，不代表任意 error body 都可信。已经 dispatch 的 3xx / 5xx、timeout、断连、解析失败保守为 outcome_unknown；空输出不能因 HTTP 200 算成功。尚未发送且可证明连接前失败才可 definitely_failed。此处不增加正式错误枚举或 Run 状态。已有 CapabilityError 的 rejected / outcome_unknown 与既有失败路径继续成立，recovery_required 仍是执行基础设施不确定性，不用来掩盖重复生成。

## Secret 生命周期与输出边界

DirectKeyFromHeaders 构造请求级 Key，未发现像 LiteLLM Python SDK 那样按 credential 持有 SDK client 的 TTL cache；HTTP 连接池按 provider/host 共享，认证头每次构造。共享连接的 A/B 隔离测试通过。但 Key.Value / headers / request buffers 使用普通 Go string / byte，不可靠清零。清理请求 context 引用不等于清除堆、池和所有副本。

只读内存侧车在并发完成及故障结束后仍找到 A/B 合成 key；Gateway 重启且尚无用户调用时未找到 A/B key，之后 BYOK 调用成功。此扫描只返回布尔值，未输出或保存内存。它无法证明所有引用、残留时限、GC 后状态或可靠零化；不能给出未验证的驻留 TTL。生产若采用此类组件，必须把整个进程、dump、诊断和运维权限视为 Secret 边界；本轮没有为此新增正式设施。

| 位置                            | 本次实测与限制                                                                                                           |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Gateway response/error          | Provider error.message 故意包含 key、endpoint、prompt marker，会原样出现在 Gateway error；正常 content 回显 key 也会透出 |
| response headers / extra_fields | 存在 Provider 私有 header、路由、key 名、内部参数等；不允许透传                                                          |
| parser error                    | malformed response 错误携带上游 body 片段；虽本次片段不含 key，不能假定安全                                              |
| warn 平台日志                   | 受限配置下未发现 key、prompt、endpoint 或注入 traceback；保留请求路径 / 状态 / trace ID。未宣称默认 debug 日志安全       |
| metrics                         | 实际认证读取为 200，扫描未发现 key、prompt、endpoint；无任意自定义用户 labels                                            |
| traces / connectors             | 无 OTEL / Maxim 等 exporter 加载，无外部 trace 服务；不能由此证明启用插件也安全                                          |
| config / SQLite / WAL           | 无用户 key 或用户模型记录，平台自定义 endpoint 在配置 / WAL 是预期的平台配置持久化                                       |

实验复用 L2 的 [allowlist projection](../litellm-l2/protocol.mjs)，只是保守安全投影验证，不声称已实现 Bifrost 专属分类器。成功只保留已校验非空 text，拒绝已知 Secret 回显；失败只保留平台固定 code、outcome、message 与范围合法 status。所有原始 headers、errors、extra_fields、endpoint、body、traceback 均丢弃。业务日志只应保留 invocation ID、耗时、成功与固定分类，不使用同一个 raw error object。已知 credential 检测是额外保护，不替代输出 Schema 与 allowlist。

本次配置：warn；enable_logging=false；logs_store=false；disable_content_logging=true；retain_content_in_object_storage=false；allow_per_request_content_storage_override=false；logging_headers=[]；无 tracing / cache / 自定义 callback。后续每个 connector 有自己的内容开关，不能只设 client 的 disable_content_logging 就宣称所有 exporter 安全。Worker 自己也不记录请求体或原始响应。

## 独立平台认证的额外限制

`enforce_auth_on_inference=true` 仍将 Direct Key 算作认证，未配置 required_headers 时，缺失平台 VK 可成功 dispatch，见 [auth-negative-control.json](auth-negative-control.json)。公开 `client.required_headers:["x-bf-vk"]` 能使完全缺失 header 返回 400、0 POST；非法非空 VK 返回 401、0 POST。但空值 `x-bf-vk:""` 满足 required_headers 的“存在”检查，随后被视为没提供 grant-bearing credential，Direct Key 又使认证成立，最终返回 200、1 POST。

因此本次没有验证出只靠这些 Gateway 开关即可强制独立平台 credential 的可靠组合。setup token 只保护管理 API，不能冒充 inference 的平台认证。只靠 Worker 正常发送正确 VK 也不能证明 Gateway 拒绝错误调用方。本轮记录反例，不继续添加认证代理或修补治理代码。

## Endpoint、模型发现与部署成本

预设 Provider + 用户 key 的模式自然适配；固定 `network_config.base_url` 的 Custom OpenAI-Compatible 也实跑成功。Direct Key 正式头只承载 key，URL 来自平台 Provider 配置。探测 body `api_base` / `base_url` 与两个猜测的 endpoint header 均仍请求 endpoint-a，未改变为 endpoint-b；这些猜测字段不是公开能力，不应作为未来调用协议。

没有验证出两个用户在同一个预设 Provider 上以请求级 endpoint 分流的正式 HTTP 能力。需要预注册不同平台自定义 Provider 的方案会增加配置所有权问题；本轮未实施。高级 Custom 路径可保留现有 openai_compatible@1 独立实现，不影响主路径评估。

模型发现最小测试：两协议各 A/B 一次 `/v1/models?provider=...`，实际使用本次 key 发出一个原生模型列表 GET。A 的上游 200、B 的上游 403 都正确传回；但 A 的列表在本次 Direct Key 默认过滤后变成 `data:[]`，不能宣称已验证出完整可用的 BYOK 模型发现。固定源码 Direct Key.Models=[]，provider 的列表转换按此过滤。参考 catalog 提供模型 / pricing / parameter 信息，不能作为用户权限证明，也不应成为 DramaFlow ModelConfiguration 的第二 Source of Truth。没有实现 A6 或完整发现系统。

资源实测如下，原始 KiB 值见 result.resources。这是本次配置与 Docker VM 的观测，不是 benchmark。

| 项目                                 | 实测                                            |
| ------------------------------------ | ----------------------------------------------- |
| idle RSS                             | 96.0 MiB                                        |
| 一次正常调用后 RSS                   | 112.6 MiB                                       |
| 32 次少量并发后 RSS                  | 125.3 MiB                                       |
| ARM64 镜像展开 / 压缩层              | 268,411,292 / 90,341,336 bytes，约 256 / 86 MiB |
| 进程启动到观察健康                   | 640 ms                                          |
| PostgreSQL / Redis / Python 常驻依赖 | 无 / 无 / 无                                    |
| 配置存储                             | 平台 SQLite；本次 file-only 完整 HTTP 启动失败  |

启动时间为进程 StartedAt 到驱动观察健康的上界，包含轮询开销，不包括 pull。两条参考 datasheet 来自实验本地 file URL，生产若需要目录应冻结可信资料；否则有远端目录获取依赖。

生产候选形态只需一个 Gateway 进程加平台 SQLite / 配置，未要求 PostgreSQL、Redis、Python 或其他常驻服务；测试的第二 Gateway、oracle、relay、只读审计侧车均不属于生产部署。SQLite 与平台 metadata 同步仍比“完全无存储的纯转发进程”多成本。

Worker 概念调用可保持 provider / model / credential / input / options，不必管理 Bifrost 用户、用户 Provider 或模型记录。仍需独立 deadline、双 Secret、固定 Provider 映射、严格输入与 allowlist 输出投影。Provider timeout 应小于 Worker 完整 deadline 并预留返回错误时间；本实验用 3 秒上游预算、10 秒调用预算只为故障注入，不是生产默认。

相比 LiteLLM，本次重定向与 Go 部署较简单，也没有 Python SDK credential client cache；但未消除进程 Secret、错误净化、认证和配置存储边界，且同样无法保证单次生成最多 dispatch 一次，因此不能认定达到所需安全 / 运维简化。无需修改 DramaFlow 领域模型来运行实验；更改 Run 状态、接受重试或引用 Bifrost ID 都不能解决准入失败。

## 验证范围

驱动完成 159 个生成 invocation 案例，共收到 164 个 Provider POST，另有四次模型列表 GET。覆盖正常 / 认证对照、32 并发、50 redirect、双协议故障及 warmup、endpoint 探测、无 DB 启动、SQLite/WAL、内存、metrics、日志与重启检查。正向断言失败与预期 NO-GO 分开记录；result.failure 缺失表示测试驱动完成，result.blockers 才是准入问题。代码另经 Node 语法、ESLint、Python AST、Prettier、证据计数 / hash 与文档链接核对。

未验证真实收费模型、其他 Provider / Capability、streaming、OAuth / Bedrock 多字段认证、HA、生产 Linux 资源或完整默认/debug exporter 泄漏路径。不以有限场景声称所有功能安全，也不为 NO-GO 继续修补 Gateway。
