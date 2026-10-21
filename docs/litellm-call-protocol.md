# LiteLLM 模型调用协议

本文定义后续 `litellm@1` 必须遵守的调用、安全投影和失败语义，不表示生产 Plugin / Runtime 已实现。证据来自固定 LiteLLM `1.104.5` 镜像中的实际代码与[真实 Gateway 故障实验](../experiments/litellm-l2/README.md)，镜像 digest 复用[锁文件](../experiments/litellm-l1/image.lock.json)。当前阶段与后续授权只维护在[实施方案](implementation-plan.md)。

**当前存在准入阻塞：零 retry / fallback 配置仍跟随 Provider 307/308，再次发送生成 POST；原生 Anthropic 还将 x-api-key 传给跨 hostname、端口及 HTTPS downgrade 的目标。正式 OpenAI session 注入只修复 OpenAI，普通 forward proxy / CONNECT 均无效。本文的“最多发送一次”要求尚未被当前 Gateway 配置满足，不能据此进入正式部署。证据见 [No-Redirect 专项](../experiments/litellm-l2-1/README.md)。**

## 调用与发送约束

一次 invocation 只绑定一个已明确选择的 Provider Instance、Model Configuration、插件精确版本与 capability。Worker 在既有授权边界解密后，按请求向 Gateway 交付凭证；平台认证与 Provider 认证独立。保持 DramaFlow 的配置与 Secret 所有权，不复制用户凭证到网关 DB，不通过模型 alias、fallback 或默认环境 key 替换用户选择。

Plugin 必须从已校验的领域参数重新构造请求对象；禁止展开任意 `settings`、转发任意 headers 或接受用户传入 `user_config`。首批文本请求允许的字段为明确构造的 `model`、`messages`、`api_key`、`api_base`、`temperature`、`max_tokens`，以及平台独占的 timeout / 重试策略字段。地域 / API version 等以后按已验收接入档案另行开放。

平台独占并固定 `stream=false`、`num_retries=0`、`max_retries=0`、`disable_fallbacks=true`、`drop_params=false`、`modify_params=false`。Gateway Router 同时配置零重试、零 fallback 上限与空的普通 / 默认 / context / content-policy fallback 列表。测试使用 `disable_cooldowns=true` 以免前一个故障让后续测试被冷却状态挡住；它不是生产重试控制器。

Worker / SDK / HTTP client / 中间代理不能自动重发生成 POST，不能因调用结果未知重新生成。Gateway → Provider 也必须禁止自动跟随重定向；Worker 端的 `redirect: error` 只控制 Worker → Gateway，无法约束 Gateway 的内部 HTTP client。

实测 `1.104.5` 的 OpenAI HTTP client 设有 `follow_redirects=True`，原生 Anthropic 路径也会跟随 307。输入 `api_base` 的正则验证不能阻止随后的 redirect 目标，原允许范围之外的路径实际收到了第二个 POST。Gateway 最终返回 200，客户端看不到完整跳转历史，因此 Plugin 无法靠最终响应投影补救这一副作用。

真实调用链确认第二跳由 HTTPX 的 redirect loop 执行；其下层 aiohttp transport 已设 `allow_redirects=False`。301/302/303 也必须拒绝，虽然实测改为 GET，仍越过 endpoint 边界并可能转发 x-api-key。HTTPS CONNECT 不能观察加密响应，普通代理把 Location 原样交回 client 也不能阻止第二跳；L7 过滤若另行采用，必须同时验收 TLS、动态 endpoint、防绕过与零重试，不从文档推导 GO。过滤后失败仍按 outcome_unknown 处理，不能声称第一跳未生成。

当前不能宣称“零 retry 等于一次上游请求”。恢复准入前，须验证一种受支持且覆盖两个协议的 no-redirect 出站约束，或明确增加可阻止 3xx 跳转的出口策略。不能把未验证的 private monkey patch 或换厂商直连作为生产兜底，也不重新维护逐厂商 Adapter。

## Secret 与 client cache

选择**接受受信任 Gateway 进程内的凭证驻留并保留连接复用**。不使用私有缓存字段修改来获得形式上的零缓存，也不把“不写数据库”表述为“不保留 Secret”。

固定版本的实际观察如下：

- `LLMClientCache.default_ttl` 是 600 秒，但 OpenAI SDK client 写入时显式使用 `_DEFAULT_TTL_FOR_HTTPX_CLIENTS=3600`。实际条目约 3600 秒；设置正式 Router 参数 `client_ttl=1` 后仍如此，两者是不同缓存。
- 同 key / endpoint / 初始化参数复用 SDK client，实际 HTTP/1.1 连接也被复用；不同 key 产生独立 client。模型名本身不要求独立 client，认证与 endpoint 等初始化参数决定 client 复用。
- cache key 同时包含 credential hash 与明文 key。不能输出 cache key、client repr 或缓存快照到运维系统。L1 的 600 秒读数仅指缓存容器默认值。
- TTL 是惰性有效期。没有后续访问 / 插入时，过期条目仍可留在内存。移除 client 条目后，`expiration_heap` 的旧 cache key 仍可能持有明文 key，直到后续清理或进程退出。
- client eviction 也不立即擦除 Secret。官方 closer 默认有 900 秒 grace，并检查 in-flight 连接；关闭连接后的 SDK 对象仍保留 api_key，资源引用环还可能等待 GC。实验使用时间推进和临时关闭自动 GC 来观察这些行为，没有修改生产镜像。
- 固定代码中没有发现可通过受支持 Gateway YAML / env 设置改变这条 SDK 路径显式 3600 秒 TTL 或关闭该单例缓存的控制项。`client_ttl` 不能冒充此控制；`cache=false` 仅关闭响应缓存。直接把 private capacity 设成零虽然能阻止插入，但会为相同 key 重建 client，也不会清除已有 Secret 引用。

生产安全边界是整个受信任 Gateway 进程，不能承诺 TTL 后物理清除。需要硬隔离或更短驻留上限时，应独立设计进程生命周期 / 隔离或验证官方支持能力，不把任意修改全局 cache 当配置。凭证强制撤销应依赖厂商撤销 / 轮换；停用 DramaFlow 配置只阻止后续平台调用，不能撤回已受理请求。

关闭 client cache 会丢失已观察到的 client / 连接复用，并增加对象与连接建立开销；本轮没有生产负载基准，不给出性能损耗百分比。所有讨论都不构成 Python 内存可靠清零保证。

源码定位见固定 tag 的 [SDK cache key](https://github.com/BerriAI/litellm/blob/v1.104.5/litellm/llms/openai/common_utils.py)、[缓存生命周期](https://github.com/BerriAI/litellm/blob/v1.104.5/litellm/caching/in_memory_cache.py)、[延迟关闭](https://github.com/BerriAI/litellm/blob/v1.104.5/litellm/caching/evicted_client_closer.py)。实际镜像内源码 SHA-256 和 SDK 版本记录在实验结果中。

## Gateway 输出的 allowlist 投影

Gateway 的 JSON、HTTP status、headers、错误文本和内部 metadata 均先视为外部输入。JSON 解析、结构验证及领域投影完成前，不进入业务对象、日志或 tracing。

| 通道                     | 唯一允许的最小字段                                                               | 值的约束                                                                                         |
| ------------------------ | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| 文本 capability 成功输出 | `text`                                                                           | 单一、非空文本输出；拒绝 refusal、tool calls、截断 / 过滤及不完整响应，其他 Gateway 字段全部丢弃 |
| Plugin 安全失败摘要      | 平台 `code`、平台固定 `message`、已分类 `outcome`、可选 `httpStatus`             | code / outcome 使用平台枚举，message 来自本地字典，status 只能是有效整数                         |
| 用户可见 NodeRun error   | 既有 `stage`、受控 `code`、固定 `message`                                        | 不拷贝原始 error / cause / stack；细分 outcome 可由受控 code 表达                                |
| 平台 invocation 运维事件 | 自建 invocation ID、固定 event、elapsedMs、success、受控 code / outcome / status | 身份来自平台、数值有界，不能来自原始 Provider metadata                                           |
| Gateway 原生日志         | time、枚举 severity、固定 component / event                                      | formatter 不读取 message、args、exc_info 或 stack_info                                           |

原始 response headers，包括 `x-litellm-model-api-base`、Provider 自定义 headers、traceback、request body、messages / prompt、内部地址与 metadata，均不在上述允许字段中。也不把原始 `error.type` 或 `error.code` 原样作为平台字段，只允许匹配已验收的有限字面值来做分类。

成功 text 仍是外部内容，不能只因字段名允许就信任其值。实验中 Provider 在 200 文本中回显其收到的 credential，Gateway 原样返回；验证投影会因命中本次已知 credential 的完整字面值而拒绝输出，记为结果未知，不修改成伪成功文本。字面值检测是额外保护，不能声称可以识别任意编码 / 混淆的 Secret。

此限制适用于 Gateway 诊断与返回值投影。现有 NodeRun.inputs 按业务数据协议保存节点 prompt，与把 Gateway 错误中的 request body 写进日志 / error 是两条不同通道；本次没有修改该既有业务输入持久化行为。

## Outcome 与证据

`failed` 表示这次节点没有交付合格输出；它不证明外部模型从未生成或计费。分类不能读取测试 oracle，也不能通过错误文本猜测厂商内部阶段。

| 分类                  | 可以成立的证据                                                                                    | 不能据此归类的情形                                              |
| --------------------- | ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `definitely_rejected` | 本地校验 / 已验收 Gateway 前置认证拒绝；固定渠道中认证、权限或配额拒绝的状态与归一化类型同时匹配  | 任意 4xx、原始自由文本、自定义渠道未确认的错误                  |
| `definitely_failed`   | 已知未 dispatch；直达 Gateway 的 DNS / ECONNREFUSED 等可证连接建立前失败，且未收到响应头          | 已发出后的 timeout / reset、Gateway 转述的笼统 connection error |
| `outcome_unknown`     | 请求可能发出后未得到可验证完整结果；上游 5xx、408、断连、部分响应、坏 JSON / Schema、输出被拒绝等 | 不能解释为未生成，也不能触发自动重试                            |

固定渠道实测的 Provider 401/403/429 类型分别为 `authentication_error`、`permission_error`、`throttling_error`，可结合该渠道拒绝契约归入 rejected；未知类型降为 unknown。Provider 429 的测试 oracle 显示未生成，但该 oracle 不向正式 Plugin 开放。其他 Provider 需单独验收其语义。

**400 与 422 默认 unknown。** 实验中 OpenAI 的普通 Provider 400 与上游已产生结果后的空 choices 错误都变成 Gateway `400 / invalid_request_error / code=400`，客户端无法仅靠结构化类型区分。不要对原始 message 做字符串匹配以提升“确定性”。500 也同时覆盖真正的上游 500、上游连接拒绝和已受理后断连。

超时不是单一结果：发送前预算耗尽可以确认没有 dispatch；发送后 Worker deadline 或 Gateway 408 均是 unknown。测试在 Gateway timeout 返回时分别观察到“尚未生成”和“已经生成”，稍后前者也完成了生成；相同 HTTP 408 无法告诉 Worker 这些差异。

## 与现有运行模型对齐

正常存活的 Worker 收到 capability 失败后，仍使用 NodeRun failed → WorkflowRun failed；模型结果未知不新增 Run 状态，也不自动转 `recovery_required`。如果进程死亡或运行 / checkpoint / Outbox 确认失败，继续沿既有执行基础设施边界处理。

现有 `CapabilityError.outcome` 只有 `rejected | outcome_unknown`，可以保守表达“确认未受理 / 无生成”与“未知”两类安全结论；三分类的发送前失败细节由受控错误 code 表达，不强制增加第三个领域枚举。不能直接复用现有 `externalCapabilityError` 对全部 4xx 的 rejected 判断来处理 Gateway。

当前 `toNodeRunError` 只输出固定阶段摘要，会丢失 capability outcome。正式接入时需让安全投影读取平台确认的失败信息，并使用既有 error.code 保存如 `NODE_MODEL_NOT_ACCEPTED`、`NODE_MODEL_OUTCOME_UNKNOWN` 这类受控编码；WorkflowRun 可继续保留整图执行失败摘要，细节由关联 NodeRun 查看。现有 code 字段允许平台字符串，不需要新增字段、运行状态或数据库迁移。本轮只评估此实现要求，没有修改生产投影。

如果将来产品要求独立 outcome 字段或自动核查 / 恢复入口，应另行授权契约设计；本协议不依赖它们。即使明确 rejected，首期也不自动重试生成；新的执行必须是用户明确操作。

## Timeout ownership

设 `B_remaining` 是调用时剩余的 Node / Workflow 预算，`T_plugin` 是本次 Worker 调用总 deadline，`T_provider` 是 Gateway 上游预算，`Δ` 是连接、序列化和错误返回余量：

```text
T_plugin <= min(所选模型调用预算, B_remaining)
T_provider + Δ <= T_plugin
```

当前若没有上层 Node / Workflow deadline，Plugin 的有界预算仍必须独立生效；不提前新增上层超时状态机。发送前已无足够预算就停止，不能发出一个已过期调用。

Worker 的 signal 必须持续覆盖连接、响应头及完整响应体，不在收到 headers 后撤销。Gateway 的 timeout 负责尽早结束其上游等待，但不能替代 Worker 总 deadline，取消等待也不保证厂商停止生成。BullMQ lock / stalled detection 只保证队列消费者存活与交付，不作为正常模型超时控制器。

实验普通调用用 1.2 秒上游预算和 4 秒 Worker deadline；200 毫秒场景是故意注入的预算反转，用于证明 Worker 会独立结束等待。收到 Gateway-like 200 headers 后 body 停滞的独立注入端点也被总 deadline 截断。数值仅用于快速测试，生产应按上述关系和实测余量配置。

## 日志、观测与准入

debug / verbose 关闭，callbacks / success / failure / service callbacks 为空或经过独立审核的 allowlist，响应缓存、spend payload 日志关闭，默认不记录 prompt / request / response body。

`turn_off_message_logging=true` 不能单独满足这一要求：实测默认错误日志仍包含 endpoint、请求片段、traceback 和内部 metadata。实验通过正式 `--log_config` 接入只生成允许字段的 formatter，才消除了这些字段；不能把同一原始 error object 同时交给运维系统和用户错误。

运维诊断依靠平台自建 invocation ID、阶段、耗时、受控错误类别及聚合成功 / 失败计数。需要更多原生 Gateway 诊断时必须单独审批其字段与保留方式，不能临时开启全量日志或把 cache dump 接入日志平台。

普通 SDK / Router 故障重试在已测场景为 0 / 1 次；但两协议的 307/308 均重复 POST，Anthropic 还存在跨 origin 凭证转发。**当前固定 Gateway 的直接出站路线 NO-GO，最终响应不足以识别或补救。** Secret 所有权与现有运行状态继续保留；专项实验的替代路线比较不构成自动更换架构的授权，不能直接进入 L3。
