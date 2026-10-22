# LiteLLM 故障与缓存验证

历史结论：固定 1.104.5 的 redirect / dispatch 与凭证驻留行为不能满足当时准入要求；最终 NO-GO 见 [redirect 专项](../litellm-l2-1/README.md)。未接入生产 Plugin 或 Workflow。

[result.json](result.json) 保存脱敏结果；镜像沿用 [L1 锁文件](../litellm-l1/image.lock.json)。关闭响应缓存不代表关闭 SDK client cache；TTL 到期不保证所有明文引用已擦除。

需要 Node 24、Docker 和锁定镜像，从仓库根目录执行 `node experiments/litellm-l2/run.mjs`。仅用合成凭证 / 本机替身，不加载项目 `.env`，不连接业务库 / Redis，不调用收费模型；新结果写 `.local`。

旧调用协议与逐项分析由 Git 保留，当前生产边界见[架构](../../docs/architecture.md#文本-ai-与-provider-plugin)。
