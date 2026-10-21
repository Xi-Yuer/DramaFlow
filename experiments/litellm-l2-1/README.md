# Provider 出站 No-Redirect 准入验证

**NO-GO。** 固定 LiteLLM `1.104.5` 的直接出站方案仍不能通过双协议准入。正式 OpenAI session 注入可以阻止该路径的全部已测重定向，但原生 Anthropic 不使用这个 session；普通 HTTP forward proxy、HTTPS CONNECT 和正式 HTTPX transport 切换均未解决问题。没有修改第三方包、私有字段、Workflow / Run 模型或正式 Worker。

固定镜像及架构沿用 [L1 锁文件](../litellm-l1/image.lock.json)，实际执行 `linux/arm64`。记录 [128 个用例及实际调用链](result.json)，包括 80 个跨 origin 基线、10 个 session 注入对照、10 个 transport 切换对照、20 个 forward / CONNECT 对照和 8 个正常成功对照。所有 retry / fallback 为零，streaming 关闭，不连接业务数据库，不调用真实模型。

## 实际负责 redirect 的组件

使用 Python `sys.setprofile` 只读记录真实 Gateway 调用的函数、类名和 redirect 布尔值，不替换函数；读取 `_transport` 只用于确认类型，不作为控制机制。源码文件 hash / 关键行与依赖版本保存在结果的 `sourceAudit`，运行观察在 `observations`。

| 路径      | 实际调用链                                                                                                                                                              | 启用者与第二跳执行者                                                                                                                                             |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OpenAI    | `OpenAIChatCompletion.acompletion` → `_get_openai_client` → OpenAI Python `AsyncOpenAI` → `httpx.AsyncClient` → `LiteLLMAiohttpTransport` → aiohttp                     | LiteLLM `openai/common_utils.py` 在 `_get_async_http_client` 构造 HTTPX client 时显式 `follow_redirects=True`；HTTPX `_send_handling_redirects` 构造并发出第二跳 |
| Anthropic | `AnthropicChatCompletion.acompletion_function` → `get_async_httpx_client` → LiteLLM `AsyncHTTPHandler.post` → `httpx.AsyncClient` → `LiteLLMAiohttpTransport` → aiohttp | `AsyncHTTPHandler` 的构造参数默认 `follow_redirects=True` 并交给 HTTPX；同一 HTTPX redirect loop 发出第二跳。此路径没有调用 Anthropic Python SDK                 |

运行中实际为 OpenAI SDK `2.33.0`、HTTPX `0.28.1`、httpcore `1.0.9`、aiohttp `3.14.4`。两条默认路径的 HTTPX `follow_redirects` 均为 true，底层 aiohttp `_request` 的 `allow_redirects` 为 false。因此不能把重复请求归因于 aiohttp 内部另一次跳转，也不能通过 Anthropic SDK 配置修复未参与执行的组件。

## 正式控制点核对

| 控制点                                     | 官方资料 / 实测                                                                                                                                                                                          | 判断                                                                       |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Gateway YAML / env                         | 核对[配置参考](https://docs.litellm.ai/docs/proxy/config_settings)与固定镜像读取点；未找到覆盖这两条生成路径的正式 redirect 开关                                                                         | 没有已验收的双协议控制，不声称所有未来版本均不支持                         |
| OpenAI HTTP client                         | [LiteLLM OpenAI 文档](https://docs.litellm.ai/docs/providers/openai#set-ssl_verifyfalse)公开 `litellm.aclient_session`；实验在官方 callback 加载的模块中注入 `httpx.AsyncClient(follow_redirects=False)` | OpenAI 五种状态均只发一次，Gateway 返回 500；Anthropic 仍第二跳，不准入    |
| OpenAI SDK 的 `http_client`                | [官方 SDK](https://github.com/openai/openai-python#configuring-the-http-client)支持自定义 client，但 Gateway 中 SDK 对象由 LiteLLM 创建                                                                  | 上述注入可覆盖 OpenAI，不能控制另一条 handler                              |
| Custom HTTP Handler                        | [官方文档](https://docs.litellm.ai/docs/completion/http_handler_config)明确限定 `aiohttp_openai/` 等路径                                                                                                 | 不是本次 `openai/` 与原生 Anthropic 的通用注入点，不替换 Provider 名称绕过 |
| `DISABLE_AIOHTTP_TRANSPORT=True`           | 正式 env；实际换成 `httpx.AsyncHTTPTransport`                                                                                                                                                            | HTTPX client 的 follow 仍为 true，两协议五种状态均第二跳                   |
| `AsyncHTTPHandler(follow_redirects=False)` | 固定源码确有构造参数，但未找到把它稳定注入这两条 Gateway 路径的公开配置契约                                                                                                                              | 不把直接依赖内部模块 / 私有注入当作正式方案，没有实施 monkey patch         |

[HTTPX 官方说明](https://www.python-httpx.org/compatibility/#redirects)确认跟随是可配置行为；本问题来自 LiteLLM 创建的 client，而非 HTTP 协议强制要求。

## 实测请求次数

以下均是一次 invocation；数字为 `Provider 总 HTTP 请求数 / 生成 POST 数`，包含初始目标与第二跳。每种状态均分别测 OpenAI / Anthropic；所有被跟随的案例最终都返回 Gateway 200。

| 运行方式                         | 301               | 302        | 303        | 307             | 308             |
| -------------------------------- | ----------------- | ---------- | ---------- | --------------- | --------------- |
| 默认 OpenAI                      | 2 / 1，第二跳 GET | 2 / 1，GET | 2 / 1，GET | **2 / 2，POST** | **2 / 2，POST** |
| 默认 Anthropic                   | 2 / 1，GET        | 2 / 1，GET | 2 / 1，GET | **2 / 2，POST** | **2 / 2，POST** |
| 官方 session 注入 OpenAI         | **1 / 1**         | **1 / 1**  | **1 / 1**  | **1 / 1**       | **1 / 1**       |
| 同一注入下 Anthropic             | 2 / 1             | 2 / 1      | 2 / 1      | **2 / 2**       | **2 / 2**       |
| HTTPX transport，两协议分别测    | 2 / 1             | 2 / 1      | 2 / 1      | **2 / 2**       | **2 / 2**       |
| 普通 forward proxy，两协议分别测 | 2 / 1             | 2 / 1      | 2 / 1      | **2 / 2**       | **2 / 2**       |
| HTTPS CONNECT，两协议分别测      | 2 / 1             | 2 / 1      | 2 / 1      | **2 / 2**       | **2 / 2**       |

默认路径的每种状态还分别覆盖下表的八种 origin 关系，行为一致。307 / 308 第二跳 body SHA-256 与初始 POST 相同；301 / 302 / 303 第二跳 body 为空。全部 128 个用例共记录 **243 个 Provider HTTP 请求，174 个 POST**。

## Redirect credential 安全

表格描述默认路径中第二跳实际收到的本次 Provider credential，覆盖五种 redirect 状态；不使用真实凭证，oracle 仅记录 fingerprint / 字节数 / hash。两个 hostname 是独立 DNS 名，属于不同 HTTP origin；它们都指向隔离实验服务，未访问任何外部系统。

| origin 关系                       | OpenAI Authorization | Anthropic x-api-key |
| --------------------------------- | -------------------- | ------------------- |
| path-only                         | **保留**             | **保留**            |
| same-origin 绝对 URL              | **保留**             | **保留**            |
| hostname change                   | 移除                 | **保留**            |
| port change                       | 移除                 | **保留**            |
| hostname / scheme / port 同时变化 | 移除                 | **保留**            |
| HTTP:8080 → HTTPS:8443            | 移除                 | **保留**            |
| HTTPS:8443 → HTTP:8080            | 移除                 | **保留**            |
| 同 host HTTP:80 → HTTPS:443       | **保留**             | **保留**            |

HTTPX 对同 host 标准端口 HTTPS upgrade 存在保留 Authorization 的例外；不能笼统称“跨 origin 一律去凭证”。它不把 `x-api-key` 作为 Authorization 处理。Anthropic 在 HTTPS downgrade 中仍将 key 发往明文目标，是独立于重复生成的阻塞证据。

OpenAI 在多数跨 origin 场景去掉 Authorization，也仍把 307 / 308 的完整请求 body 发往第二跳，不能视为 prompt / SSRF 边界已经安全。初始 `api_base` 的 path regex 没有阻止这些 `/target/...` 路径。

## Egress proxy 评估

普通代理已证伪：测试 proxy 自身使用不跟随的标准 `http.client`，没有 retry。它把 Location 返回给 LiteLLM 后，HTTPX 仍重新请求；oracle 记录了实际经过代理的 HTTP 路径以及 CONNECT 建连，不能把这些成功路径误认为流量绕过了代理。HTTPS CONNECT 只隧道传输 TLS，代理看不到加密后的 3xx，更无法净化它。

有可能满足准入的是 **L7 response filter**，在 LiteLLM 看见 3xx 前改写成无 Location 的终态，并对任何失败禁止重发。需要同时保证：

1. Gateway 无法绕过过滤层直接访问 Provider；只允许显式最终 endpoint。
2. HTTPS 流量采用明确的 reverse proxy TLS 终止与验证，或有治理的 TLS interception；仅加 `HTTPS_PROXY` 不足够。
3. 动态 endpoint 安全传递、DNS / IP / port / path allowlist、Host / SNI 和证书校验一致，不把 Provider 配置或 Secret 复制到新数据库。
4. proxy 不理解模型、不做 retry、fallback 或协议转换，不落盘 body / credential，普通日志不含 endpoint。
5. 过滤后的 502 等错误仍是 `outcome_unknown`：第一跳已可能生成，不能因改写成失败就判未受理。

NGINX 的正式 [`proxy_intercept_errors` / `error_page`](https://nginx.org/en/docs/http/ngx_http_proxy_module.html#proxy_intercept_errors)、[`proxy_next_upstream off`](https://nginx.org/en/docs/http/ngx_http_proxy_module.html#proxy_next_upstream)提供候选机制；只设置 `proxy_redirect off` 不会阻止 client 跟随。新增 TLS 处理、动态目标协议和防绕过网络边界超过“普通代理”的复杂度，不能凭文档当作已通过。

本轮没有建设或验收该 L7 生产候选。尝试获取固定 `nginx:1.28.0-alpine` 镜像时 registry 认证连接失败，未启动 NGINX，也未据此作出其行为结论；没有无限更换镜像或增加未固定依赖。**NO-GO 针对现有固定 Gateway 及已验收控制点，不代表 L7 过滤在技术上不可能。**

## NO-GO 后的替代路线

以下是候选比较，不构成更换技术栈或继续实施授权，也没有把任何替代方案标成通过。

| 维度             | A. LiteLLM + 受控 L7 egress                                       | B. Bifrost Gateway                                                                                                                                                               | C. 统一 TypeScript AI SDK 层                                                                                                                 |
| ---------------- | ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| 用户 BYOK        | 保留已验证请求级 key；代理短暂接触明文                            | [正式 Direct Key](https://docs.getbifrost.ai/providers/request-options#direct-api-key)可按请求传原始 key，须额外启用并独立认证                                                   | 如 AI SDK direct Provider factory 的 `apiKey`，无需服务端 key DB                                                                             |
| 动态 endpoint    | 需要新增动态目标传递 / 校验，不能为每个用户同步 nginx 配置        | [Provider Setup](https://docs.getbifrost.ai/deployment-guides/config-json/providers)有 base URL；本轮未确认 HTTP 推理请求可直接覆盖 endpoint，不能用逐用户 Provider 记录同步代替 | OpenAI / Anthropic factory 正式支持 `baseURL`，按本地配置构造                                                                                |
| Secret ownership | DramaFlow 唯一业务 SoT；扩大为 Worker + Gateway + egress 信任边界 | 可以保持 DramaFlow ownership；缓存、日志、独立认证与无 DB 仍需固定版本验证                                                                                                       | 保持 DramaFlow ownership，Secret 留在 Worker 与厂商调用路径，SDK 内存 / 错误仍需验证                                                         |
| Provider 覆盖    | 保留 LiteLLM 兼容范围，新增协议仍要验收 transport                 | 官方列出多种厂商，目标名单与 capability 逐项核对                                                                                                                                 | 依赖统一 SDK 的受维护 Provider packages，特殊认证 / 媒体能力仍可 Native Plugin                                                               |
| 资源与调用复杂度 | Python Gateway + egress，新增一跳及 TLS / 网络策略维护            | 一个 Go Gateway、一跳；资源需同负载实测，不照搬营销倍数                                                                                                                          | 无额外 Gateway 进程 / 一跳，消耗 Worker 资源；需 SDK 与现有 LangChain 抽象衔接                                                               |
| 天然 no-redirect | 当前否；依赖过滤层，未验收                                        | **未验证**；不能因使用 Go / fasthttp 就认定所有 Provider 不 follow                                                                                                               | 默认 global fetch 会 follow，**也非天然保证**；两 factory 有正式 custom `fetch` 可强制 `redirect: 'error'`，仍须固定版本实测并关闭 SDK retry |
| 后续维护         | 多一套安全关键基础设施和故障矩阵，成本最高                        | 固定版本升级与 Gateway 协议适配；重点防止产生第二套配置 SoT                                                                                                                      | 统一领域映射和包版本管理，厂商协议由 SDK 维护；不能退化成 DramaFlow 自写逐厂商 Adapter                                                       |

C 的控制点依据 [OpenAI](https://ai-sdk.dev/providers/ai-sdk-providers/openai)、[Anthropic](https://ai-sdk.dev/providers/ai-sdk-providers/anthropic)官方 factory 文档。本比较没有执行 Bifrost 或 AI SDK，也没有修改既定 LangChain / Plugin 边界。

建议优先对 **C 做一个固定版本、双协议的独立准入 spike**：其动态 endpoint / BYOK / custom fetch 控制点更直接，且不增加 Secret 中转服务。若保留独立 Gateway 是硬约束，再评估 B；其请求级 endpoint 与 no-redirect 是先验收项。A 仅适合愿意长期维护 L7 egress 的部署，不为继续使用 LiteLLM 默认增加此复杂度。

## 复现与验收边界

```sh
docker pull ghcr.io/berriai/litellm@sha256:a0649f3d460eaa431dd4c38cf2fb698fb969e417e4a6c4f1d411408815a75d07
node experiments/litellm-l2-1/run.mjs
```

需要 Docker Compose、Node 22+ 与 OpenSSL。运行创建随机 project、短期自签证书（客户端明确信任且保持验证开启）、合成 key 和独立 internal 网络，loopback 入口仅用于驱动。结束清理容器、网络及临时 Secret；不加载项目 `.env`，不操作既有开发服务。固定镜像本地 fallback 仍须匹配 L1 config digest。

当前应退出码 1 并报告 NO-GO；具体失败条件保存在 `blockers`，`failure` 只表示实验未完成或断言异常。不能删除 Anthropic 或跨 origin 场景使其变绿。`fixtureSha256` 可核对实际运行源文件；原 L1 / L2 实验源代码及结果未改写。输出在 `.local/litellm-l2-1/<批次>/`；提交结果不包含完整凭证或真实 prompt。

没有修改正式 Runtime、CapabilityInvoker、Provider / Model Configuration、Workflow / Run、A4 或数据库，没有执行 L3～L9 / A6。没有进行收费模型、全 Provider、生产性能或 L7 代理上线验收。
