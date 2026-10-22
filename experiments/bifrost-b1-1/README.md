# Bifrost B1.1：Transport Retry 最小准入验证

**NO-GO。** fasthttp 有正式公开的关闭机制，但固定 Bifrost HTTP `v2.3.2` 未向 Gateway 配置或 Provider client 注入接口暴露该机制。不能把“依赖库有公开字段”当作“现有 Gateway 已可配置”。本轮未改依赖、未构建 fork、未增加代理，也未修改 DramaFlow 生产代码。

范围仅为 transport 控制点核查及 missing / empty / invalid VK 各一次。没有重跑 B1 矩阵；由于找不到可应用于固定 Gateway 的正式关闭入口，也没有把新一轮正常 / EOF / TCP RST 调用包装成关闭成功的验收。证据见 [source-audit.json](source-audit.json)、[result.json](result.json)。当前阶段与下一步统一见[实施方案](../../docs/implementation-plan.md#当前阶段)。

## 固定版本与触发路径

复用 B1 [镜像锁](../bifrost-b1/image.lock.json)：HTTP `v2.3.2`、Core `v1.13.1`、fasthttp `v1.74.0`，release commit `a05ea20e68bf116a35e9f05b1a3d749624b3935e`。固定源码逐文件 hash 和定位链接保存在 source-audit；不使用 main 或浮动 tag。

1. `NewOpenAIProvider`（openai.go:47）与 `NewAnthropicProvider`（anthropic.go:87）直接创建 `*fasthttp.Client`，保存到各自私有 `client` 字段。
2. `ConfigureDialer`（utils.go:594）无条件写入 `RetryIfErr=network.StaleConnectionRetryIfErr`，并使用 Bifrost 自己的 `contextTransport`。
3. `contextTransport.RoundTrip`（roundtripper.go:115）获取池连接，执行 `req.Write` / `Flush`，随后读 response headers。复用连接读头失败时返回 retry=true，即使 Provider 已收到完整 POST。
4. fasthttp `HostClient.Do`（client.go:1621）收到该 retry=true，执行 Bifrost callback；`StaleConnectionRetryIfErr` 对 EOF / reset 等返回 retry=true，循环再次 `c.do(req, resp)`，产生第二次 POST。

这是 Bifrost 安装的定制策略触发 fasthttp transport 循环，不是 fasthttp 默认认为 POST 幂等，也不是 `network_config.max_retries` 的模型级重试。Bifrost 没设底层 attempts 上限，因此仍继承 fasthttp 默认 5；定制 callback 和 transport 还会进一步限制尝试，B1 已测复用连接用例实际为 2 次。

## 正式 API 与 Gateway 可达性

依据[固定 fasthttp 官方源码](https://github.com/valyala/fasthttp/blob/v1.74.0/client.go#L1621)逐步检查了循环，未只根据字段名判断：

| 控制点                               | 固定版本含义                                                                                                      | Bifrost HTTP v2.3.2 是否可用                          |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `MaxIdemponentCallAttempts=1`        | 第一次错误后 `attempts>=maxAttempts` 立即退出，发生在 callback 之前；即使 callback 允许 POST 重试也不会进入第二轮 | Gateway 没有配置映射，也没有暴露生成 client           |
| `MaxIdemponentCallAttempts=0` / 负数 | 使用默认 5，不是关闭                                                                                              | 不能把 max_retries=0 等同于这个字段=1                 |
| `RetryIfErr` 返回 retry=false        | client 所有者可通过公开 callback 拒绝重试                                                                         | Bifrost 内部无条件安装自己的 callback，无公开覆盖入口 |
| `RetryIf`                            | 已弃用；仅当 RetryIfErr 未设置时才使用                                                                            | Bifrost 已设置 RetryIfErr，单设 RetryIf=false 不生效  |
| `RetryIfErrUpstream`                 | 若设置，优先于 RetryIfErr                                                                                         | Bifrost 这两条路径未设置，也未暴露                    |
| `Client.ConfigureClient`             | fasthttp 公开的 HostClient 初始化 callback                                                                        | 不等于 Bifrost 的可注入 callback；固定 Gateway 未暴露 |

核对范围包括固定 release 的 NetworkConfig、ProviderConfig、BifrostConfig、公开 config.schema.json、CLI、环境变量读取以及两条实际 constructor / handler。没有找到 disable transport retry / max transport attempts / 自定义生成 HTTP client 的正式入口。

`CloneFastHTTPClientConfig` 复制 RetryIfErr / ConfigureClient / MaxIdemponentCallAttempts 只是内部复制逻辑，不是外部注入点。辅助 HTTPClientFactory 也不创建上述两条生成路径的 client。即使独立 Go 程序可以拥有 fasthttp client，也不能据此声称现有固定 Gateway 已满足准入。

本轮不尝试关闭连接池、改依赖、私有字段、monkey patch、新 Go Gateway、fork 或 L7 proxy。若要直接设置上述字段，需要上游提供并交付正式配置；当前版本无法通过本轮允许的入口应用该机制。

## Transport 计数的证据来源

以下是**沿用 B1 已执行证据，本轮未重跑**。result 中保存原案例 ID、时间及 B1 结果文件 hash；不把它们列为新执行测试。

| 场景                          | OpenAI B1 POST | Anthropic B1 POST | B1.1 新执行 |
| ----------------------------- | -------------- | ----------------- | ----------- |
| 正常 200                      | 1              | 1                 | 否          |
| Provider 收完 POST 后 EOF     | 2              | 2                 | 否          |
| Provider 收完 POST 后 TCP RST | 2              | 2                 | 否          |

没有可应用的关闭配置，因此不存在 normal=1 / EOF=1 / RST=1 的新 Gateway 通过结果。Provider 已生成但响应丢失可以是 outcome_unknown；这不能授权 Gateway 再次 dispatch，也不需要新增 Run 状态来表达本轮结论。

## 最小平台认证复测

真实固定 Gateway，`allow_direct_keys=true`、`enforce_auth_on_inference=true`、`required_headers=["x-bf-vk"]`，配置一个有效平台 VK，使用合成 Provider key。只发三次生成入口请求，各用唯一 ID；本地 stub 读完整个 POST 后计数。

| x-bf-vk      | 本轮 Gateway status | Provider POST |
| ------------ | ------------------- | ------------- |
| missing      | 400                 | 0             |
| empty        | 200                 | 1             |
| invalid 非空 | 401                 | 0             |

`required_headers` 仅检查 header 名存在；空 VK 在 credentialFromContext 中不形成 credential，Direct Key 又被 PresentedAnyCredential 当作已认证。管理端 dashboard Basic/JWT 的 InferenceMiddleware 恒跳过，不能补足独立平台认证。固定 request-options 文档称 Direct Key 单独使用会返回 401，与固定源码及实测冲突，本轮采用实际行为。

未找到在当前 Direct Key 模式下强制“有效平台 VK AND Provider key”的稳定配置。结论是 **application authentication insufficient → Worker-only network isolation required**，不等于认证绕过已修复。

如未来部署，Gateway 必须无公网 / 宿主发布端口，使用默认拒绝的网络策略，仅放行授权 Worker，拒绝 Web、API 及其他 workload 直接访问；能加入该网络的部署权限属于可信运维边界。只放在普通共享私网不够。该约束可由现有容器 / 编排网络策略承担，不要求新增 L7 服务；本轮仅评估，没有实施生产策略。网络隔离不能修复重复 POST，所以整体仍为 NO-GO，不能给“带部署约束的 GO”。

## 复现与检查

需要 B1 已锁定的 Bifrost / Python 镜像与 Docker Compose，无需新增镜像或真实凭证：

```sh
node experiments/bifrost-b1-1/run.mjs
```

脚本只运行三个 VK 请求及无生成副作用的健康检查；不会调用 B1 run.mjs。内部测试网络不发布宿主端口，由 fixture 容器内的 Python client 调用 Gateway，不经过 HTTP proxy。不加载项目 .env，不使用生产数据库。平台 Secret 通过临时环境文件、Provider key 通过 stdin；结果不保存明文或原始响应。容器、网络与临时配置在 finally 清理。

退出码 1 表示固定版本 NO-GO；result.completed=true 且没有 failure / cleanupFailure 表示这次验证完整结束。新结果位于 `.local/bifrost-b11/<batch>/result.json`，不会覆盖提交的证据。检查限于脚本语法 / ESLint、Python AST、Prettier、固定源码与历史证据 hash、本地链接及三个 VK 计数；没有执行生产测试或其他 B1 专项。
