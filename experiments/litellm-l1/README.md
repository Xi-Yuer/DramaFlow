# LiteLLM Gateway 固定版本验证

本实验使用真实 LiteLLM Gateway 和本地 OpenAI / Anthropic 协议服务，验证请求级凭证、endpoint 覆盖、账户隔离及无数据库推理。它只验证 Gateway 边界，不连接 DramaFlow 数据库、Redis、Worker 或 Workflow Runtime；合成凭证直接模拟执行边界解密后的输入。

## 固定版本与复现

| 项目                   | 固定值                                                                                            |
| ---------------------- | ------------------------------------------------------------------------------------------------- |
| LiteLLM Python package | `1.104.5`，由容器内 `importlib.metadata.version` 检查                                             |
| 官方发行               | [v1.104.5](https://github.com/BerriAI/litellm/releases/tag/v1.104.5)                              |
| 官方 tag               | `ghcr.io/berriai/litellm:v1.104.5`                                                                |
| 实际锁定镜像           | `ghcr.io/berriai/litellm@sha256:a0649f3d460eaa431dd4c38cf2fb698fb969e417e4a6c4f1d411408815a75d07` |
| 本轮运行平台           | `linux/arm64`                                                                                     |
| ARM64 manifest         | `sha256:5d57eb042d5e99e8a84568d013f49cead608bf079774584a2f5e887dbfc7d461`                         |
| ARM64 image config     | `sha256:c4df97753c538fbdaa6069982fd311c4bbd73caee4d15023de78c3e538c7b449`                         |

[image.lock.json](image.lock.json) 同时记录 AMD64 manifest。后续复现按 digest 拉取，不能将 tag 或在线 `main` 的行为视作同一份镜像。

仓库根目录执行：

```sh
docker pull ghcr.io/berriai/litellm@sha256:a0649f3d460eaa431dd4c38cf2fb698fb969e417e4a6c4f1d411408815a75d07
node experiments/litellm-l1/run.mjs
```

要求 Docker / Compose 和 Node.js；驱动只使用 Node 标准库，Gateway、stub 和测试 relay 共用锁定镜像，无额外 npm / Python 安装。它不加载仓库 `.env`，网关 master key 与 A/B 厂商 key 均每次随机生成。临时 Compose 环境文件权限为 `0600`，结束后删除。

本机 Docker daemon 拉取 registry 时出现 EOF；本轮通过宿主机取得同一官方 manifest 与全部 blob，逐个校验 SHA-256 后导入。Docker 的该导入路径不保留 RepoDigests，驱动仅在本地镜像 config digest 与锁文件完全相同时接受 image ID，并在结果中记录 `localVerifiedImport`。这不是任意本地 tag 兜底；常规复现仍使用上面的官方 digest。

每次创建独立随机 Compose project，Gateway / upstream 只连接 `internal` 网络，没有外网出口。测试 relay 只将宿主 loopback 的随机端口转发至固定实验目标，不转换 AI 协议、不重试，也不持有凭证环境变量；它解决 Docker internal 网络不直接发布端口的限制。独立网络和容器在结束后清理，不操作现有 DramaFlow 基础服务。

## 实验组成与正式接口

- [config.yaml](config.yaml) 只有 `openai/*`、`anthropic/*` 两个协议级 wildcard，没有用户模型记录、默认 `api_base` 或厂商凭证。每种协议的 `api_base` 只允许匹配本地 A/B 路径。
- [upstream.py](upstream.py) 是仅用于测试的协议服务。OpenAI 路径要求 Bearer；Anthropic 路径要求 `x-api-key`、`anthropic-version`、独立 `system` 字段及原生 Messages 请求 / 响应。原始合成凭证只在 stub 内存记录中供驱动核对，服务不打印或持久保存它。
- [run.mjs](run.mjs) 以同一 `POST /v1/chat/completions` 接口调用两个 Provider，逐条比较上游实际收到的凭证、endpoint、模型和参数。健康轮询使用 `GET /health/liveliness`，不发起生成。
- [cache_observer.py](cache_observer.py) 只被独立 `gateway-cache` 容器加载，通过官方 CustomLogger callback 观察真实的进程内 SDK cache。普通 / debug 验证容器不加载探针。探针不修改缓存或响应，只输出类型、数量、TTL、布尔判断与合成凭证 hash。

请求格式由测试驱动生成，等价于：

```json
{
  "model": "anthropic/claude-3-5-sonnet-20241022",
  "messages": [
    { "role": "system", "content": "L1 synthetic system" },
    { "role": "user", "content": "本地合成测试输入" }
  ],
  "temperature": 0.25,
  "max_tokens": 64,
  "stream": false,
  "api_base": "http://upstream:8080/anthropic/a",
  "api_key": "本次合成的 Provider Credential"
}
```

HTTP `Authorization: Bearer ...` 单独携带 Gateway Credential。Gateway endpoint 是 relay 转发的 `gateway:4000`；`api_base` 是实际模型服务地址。没有 `user_config`、模型 / credential 管理 API、虚拟密钥或配置同步。

## 验证结论

**GO，可以进入 L2 的后续验证；本实验不构成生产 Runtime 接入或生产安全验收。**

| 问题                  | 结论与实测证据                                                                                                                                                      |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A 请求级 credential   | 可行。同一次统一调用携带独立 `api_key`，两个上游协议均收到对应账户 key；后续省略 key 明确失败，没有复用上一请求                                                     |
| B 无 LiteLLM Model DB | 可行。没有 DATABASE_URL / REDIS_URL；运行中的 `prisma_client` 为 None；共享 Router 始终只有两条 wildcard。销毁并重建 Gateway 容器后，重新按请求传入参数即可继续执行 |
| C 并发隔离            | 48 个并发请求覆盖两协议 × 两账户 × 12 请求，所有上游 credential / endpoint / model / settings 逐条匹配。相同 prompt 的重复、跨账户和换 key 请求也各自到达上游       |
| D endpoint override   | 满足这两条已测渠道。OpenAI 的 `api_base` 含 `/v1`，Anthropic 的不含 `/v1`；自定义 OpenAI 模型名原样到达上游。超出配置正则的地址在 Gateway 拒绝，未到达 stub         |
| E 协议兼容            | 通过。统一 Chat Completions 输入被转换成原生 Anthropic Messages 路径、认证头和 body，原生响应又被转换回统一输出，DramaFlow 不必自己实现这一转换                     |
| F Secret exposure     | 普通成功响应、普通日志和两种上游反射错误中未检出完整测试 key；仍发现 endpoint / 请求内容暴露及内存保留，详见下节                                                    |
| G 限制                | 只验证上述文本 API Key 渠道；无 DB 模式管理能力、复杂认证、其他能力、TLS / SSRF 全边界及生产故障语义不在本次验收内                                                  |

Gateway 无认证返回 401；错误 master key 或把 Provider key 当 Gateway key 时返回 400，均未请求上游。越界 `api_base` 被认证边界拒绝，本版本观察到 401，错误正文明确指出 endpoint override 未获授权；不能把所有认证或策略拒绝都假定为 401 / 403，也不能只凭状态码判断失败阶段。

测试返回的合成文本带协议、账户及 prompt 标记，证明结果来自指定本地 upstream。它不是模型质量测试，也没有使用 LiteLLM `mock_response` 或生产测试替身兜底。

## Secret 与缓存的实际观察

1. **存在凭证内存缓存。** 独立运行探针在 `LLMClientCache` 中观察到分别引用 A、B key 的 `AsyncOpenAI.api_key` 对象，默认 TTL 为 600 秒；共享 Router 配置与全局 Provider credential 未被写入这些 key。关闭响应缓存并不会关闭 SDK client cache。TTL 也不等于所有堆对象在 600 秒时立即擦除。
2. **存在 endpoint 返回。** 成功响应头 `x-litellm-model-api-base` 包含上游地址；错误正文和错误日志也可能包含上游路径 / 地址。后续 Plugin 必须只输出领域结果和安全错误，不能把 Gateway 响应头 / 原始错误直接交给浏览器、NodeRun 或 checkpoint。
3. **debug 会记录请求内容。** 实际启动 `--detailed_debug` 后，日志包含 messages、模型、参数、endpoint 和带掩码的认证字段。本轮未发现完整 key，但不能据此允许生产 debug，或推导所有 Provider / callback 都安全。后续要求 debug / verbose 关闭，日志和 callback 按允许字段收集。
4. **固定版本会遮盖测试 key。** stub 故意在两种协议的 400 错误正文中反射完整 key，本版本在 Gateway 响应及默认错误日志中将它替换为 `REDACTED`。这只证明本实验的 key 格式和路径，不替代 DramaFlow 自身脱敏边界。
5. **没有观察到凭证文件。** 驱动扫描 Gateway 容器新增 / 修改且小于 64 MiB 的普通文件，未检出完整合成凭证；实验没有 DB、用户配置卷或响应缓存。这是限定范围文件检查，不是全进程内存、swap 或 crash dump 的清除证明。

本轮配置使用强随机 master key、每路由 endpoint 正则、无默认厂商 key，关闭响应缓存、debug、spend logs 与外部 callbacks；仅缓存观察容器显式启用本地只读探针。master key 仍有网关管理权限，正式服务身份与管理路由限制留给后续验证，不能把实验 master key 模式描述成最小权限的推理 key。

## 结果文件与验证边界

驱动将脱敏结果写到根目录 `.local/litellm-l1/<随机批次>/result.json`，并保存已替换完整合成 key 的普通 / 错误 / debug 日志；目录由 Git 忽略。失败只输出安全摘要，临时凭证文件和测试容器均清理。结果包含固定镜像、实际 package 版本、平台、测试文件 SHA-256、上游逐条凭证 fingerprint 及缓存观察。

可提交的本轮脱敏结果见 [result.json](result.json)，不含 credential 明文或实际用户配置。重新运行时以新批次结果为准，只有脚本完成且清理成功才视为复验通过。

尚未验证 Azure / Bedrock / Vertex 的附加认证字段与生命周期，不能外推为任意 Provider 均支持同样的 override。没有测试 metadata / 模型管理 API，也不因此依赖其稳定性。本轮没有运行 429 / 503、断连、超时、流式或 Worker 崩溃的完整故障矩阵；这些仍属于后续任务。

整体职责与所有权见[架构评估](../../docs/litellm-integration.md)，当前阶段及下一步仅维护在[实施方案](../../docs/implementation-plan.md#litellm-集成任务拆解)。
