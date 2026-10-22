# LiteLLM 初始隔离验证

最终路线结论：NO-GO，后续[redirect 专项](../litellm-l2-1/README.md)确认阻塞；本目录只是初始验证证据，不是集成计划。

[result.json](result.json) 保存本机协议结果，[image.lock.json](image.lock.json) 固定 Gateway 镜像。凭证缓存生命周期以后续[故障验证](../litellm-l2/README.md)为准，不能把缓存默认 TTL 当作密钥擦除保证。

需要 Node 24、Docker 和锁定镜像，从仓库根目录执行 `node experiments/litellm-l1/run.mjs`。仅用合成凭证 / 本机替身，不加载项目 `.env`，不连接数据库 / Redis / Worker，不调用收费模型；新结果写 `.local`。

生产链路见[架构](../../docs/architecture.md#文本-ai-与-provider-plugin)。旧接入设计与报告过程由 Git 保留。
