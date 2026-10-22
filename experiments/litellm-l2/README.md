# LiteLLM Secret 与故障协议验证

真实 Gateway 固定为 `1.104.5`，复用 [L1 镜像 digest](../litellm-l1/image.lock.json)，本次实际运行 `linux/arm64`。实验不加载项目 `.env`，不连接数据库 / Redis，不调用收费模型，不装配正式 Worker、Plugin 或 Workflow。当时的调用协议见[调用协议](../litellm-call-protocol.md)，实际案例见[脱敏结果](result.json)。

**结论 NO-GO。** 已执行 61 个 invocation 案例；除 HTTP 307 外，上游均收到 0 或 1 次请求。OpenAI 和原生 Anthropic 的 307 场景各收到两次 POST，第二跳位于原始 endpoint allowlist 之外的路径，Gateway 最终仍返回 200。配置中的零 retry / fallback 没有阻止这种 HTTP client 跳转。

## 复现

```sh
docker pull ghcr.io/berriai/litellm@sha256:a0649f3d460eaa431dd4c38cf2fb698fb969e417e4a6c4f1d411408815a75d07
node experiments/litellm-l2/run.mjs
```

此固定版本当前应返回退出码 1，并输出 NO-GO；这是生成次数准入断言检测到了重复请求，不是把失败当作通过。若行为发生变化，须检查案例、镜像及协议证据，不能直接修改断言。L1 已验证导入镜像的本地 config digest 兼容路径仍可使用；不能接受任意同名 tag。

脚本创建随机 Compose project、合成网关 / Provider key、只读测试挂载和独立 internal 网络；仅透明 TCP relay 连接 loopback 入口网络。relay 不解析 HTTP、不缓冲完整响应、不重试，因此不会把 Gateway 的断连变成自制 502。结束后清理容器、网络和临时凭证文件，不影响既有 DramaFlow 基础设施。

结果与脱敏日志写入 `.local/litellm-l2/<批次>/`。可提交结果只保存合成凭证的 hash / 布尔观察及已替换完整 key 的响应预览；其中仍包含用于展示风险的合成 prompt、内部地址、headers / metadata 标记，不能把此证据文件作为产品 API 的输出模板。

## 故障矩阵

下表次数是每一次 invocation 的实际上游 POST 次数；`OpenAI / Anthropic` 两列分别来自同一统一 Chat Completions 入口。oracle 的 accepted / generated 状态只用于核对，正式分类器只读取传输阶段与可见协议，不能使用 oracle。

| 场景                               | OpenAI 返回                | Anthropic 返回 | 每协议上游次数 | 正式安全分类                                   |
| ---------------------------------- | -------------------------- | -------------- | -------------- | ---------------------------------------------- |
| 正常对照                           | 200                        | 200            | 1              | success                                        |
| Provider 400                       | 400                        | 400            | 1              | unknown，不能与生成后的 Gateway 400 区分       |
| Provider 401                       | 401 / authentication_error | 同左           | 1              | rejected，限已验收渠道的认证语义               |
| Provider 403                       | 403 / permission_error     | 同左           | 1              | rejected，限已验收渠道                         |
| Provider 429                       | 429 / throttling_error     | 同左           | 1              | rejected；未生成，不重试                       |
| Provider 500                       | 500                        | 500            | 1              | unknown                                        |
| Provider 503                       | 503                        | 503            | 1              | unknown                                        |
| 已生成后返回 500                   | 500                        | 500            | 1              | unknown，与普通 500 不可区分                   |
| 生成前等待超时                     | 408                        | 408            | 1              | unknown；Gateway 返回后上游仍可能继续生成      |
| 已生成后等待超时                   | 408                        | 408            | 1              | unknown                                        |
| Gateway 无法连接 Provider          | 500                        | 500            | 0              | unknown，客户端不能从笼统 500 证明未受理       |
| Provider 接收后断开                | 500                        | 500            | 1              | unknown                                        |
| 已生成，响应途中断开               | 500                        | 500            | 1              | unknown                                        |
| 部分 body 写入后停滞               | 408                        | 408            | 1              | unknown                                        |
| 非法 JSON                          | 500                        | 500            | 1              | unknown                                        |
| 非法响应 Schema                    | 400                        | 500            | 1              | unknown；不能把 OpenAI 400 判成未生成          |
| 200 文本回显 credential            | 200，投影拒绝              | 同左           | 1              | unknown，完整已知 key 不能进入 text 输出       |
| context limit / content policy     | 400                        | 400            | 各 1           | unknown；无 context / policy fallback          |
| 422 unsupported parameter          | 422                        | 422            | 1              | unknown；drop_params=false，不重发修补后的请求 |
| Worker deadline，Provider 后续完成 | TimeoutError               | TimeoutError   | 1              | unknown                                        |
| 307 跳转到新生成路径               | 200                        | 200            | **2**          | **准入阻塞：最终响应掩盖了第二次 POST**        |

以下只注入一次，均单独记录在结果中：

| 场景                              | 客户端观察               | 上游次数 | 分类                                                       |
| --------------------------------- | ------------------------ | -------- | ---------------------------------------------------------- |
| Gateway authentication failure    | 400 / no_db_connection   | 0        | rejected                                                   |
| Gateway 端口不可达                | ECONNREFUSED             | 0        | definitely_failed                                          |
| 发送前 deadline 已耗尽            | DeadlineBeforeDispatch   | 0        | definitely_failed                                          |
| Gateway 接收上游结果前被 SIGKILL  | 连接中断                 | 1        | unknown                                                    |
| Gateway-like headers 后 body 停滞 | 收到 200 后 TimeoutError | 0        | unknown；单独的 Worker transport 注入，未冒充 LiteLLM 行为 |

基础矩阵为 44 个双协议案例，加 5 个独立场景和 12 个安全日志容器复验，共 61 个 invocation；另有 3 个缓存观察成功请求，共记录 60 次上游 POST。Provider 429 的 `Retry-After: 2` 在这条 Gateway 响应中没有被保留；协议不能依赖它一定存在，也不自动跟随其建议重发。

## Secret 与日志结果

- 实际 SDK 插入 TTL 为 3600 秒，缓存容器默认值为 600；Router `client_ttl=1` 不影响 SDK 条目 TTL。cache key 同时包含明文 key 和 hash；相同 key 复用 client / 连接，不同 key 使用不同 client。
- cache TTL 惰性清理；过期条目访问后被移除，但 expiry heap 仍可能持有明文 key。eviction 后默认 900 秒 grace，关闭的 SDK 对象也不擦除 api_key；引用环在测试中直到显式 GC 才消失。时间推进 / 关闭自动 GC 仅用于独立生命周期探针，不是生产建议。
- 默认 Gateway 错误日志包含 endpoint、请求片段、traceback、内部 metadata，即使 debug off、turn_off_message_logging=true、callbacks=[]。固定 key 在错误中被遮盖，不构成所有输出安全保证。
- Provider 可在 200 文本里回显认证 key，Gateway 会原样返回。实验的安全投影拒绝该结果；不会对文本做部分删改后伪装成功。
- 安全 Gateway 通过正式 `--log_config` 与 allowlist formatter 只输出 time / severity / 固定 component / event。复验未检出完整凭证、endpoint、request content、traceback 或内部 metadata。Plugin 运维事件和用户错误另用新建的允许字段对象，不能复用原始异常。

## 实现与验证边界

[config.yaml](config.yaml) 定义零重试 / fallback、非流式与本地 endpoint 范围；1.2 秒上游 / 4 秒 Worker deadline 是测试数值。脚本还故意使用 200 毫秒 Worker deadline 验证上层强制结束等待，生产关系见协议，不照搬这些数值。

[protocol.mjs](protocol.mjs) 仅是实验中的协议验证代码，包含一次请求、完整 body deadline、安全投影和保守分类；生产 packages / apps 不引用它。[cache_probe.py](cache_probe.py) 在单独观察容器中读取实际 cache；[cache_lifecycle.py](cache_lifecycle.py) 在独立固定镜像进程中推进测试 clock、检查 eviction / 关闭 / GC，并验证 private capacity=0 的效果。这不说明 private 修改是可支持的 Gateway 配置。

[upstream.py](upstream.py) 为 oracle，不是生产兜底；307 场景明确模拟第一跳已生成后重定向，第二跳收到相同 POST 并再生成。实测证明请求次数上限失败，不声称真实厂商一定会按此场景计费。

普通故障的 SDK / Router 自动重试已关闭，运行中的 OpenAI SDK `max_retries=0`、Router `num_retries=0` 均有探针证据；**HTTP redirect 是另一个独立机制**。源码的 follow_redirects=True 与两次 POST 互相印证。没有证据表明现有 YAML 中某个正式选项可以覆盖两条已测路径来关闭它；本轮没有安装自定义 transport、修改镜像、增加出口代理或更换版本来绕过问题。

本次没有验证所有 Provider、复杂 IAM / OAuth、真实模型、生产负载或正式 WorkflowRun 集成。没有实施 L3～L9 或 A6。后续 [No-Redirect 专项](../litellm-l2-1/README.md)已记录正式控制点覆盖差异、跨 origin 凭证风险和普通代理失效证据；原 L2 源代码与结果保持不变，准入决定与下一步只维护在实施方案。
