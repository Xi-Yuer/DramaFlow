# LiteLLM redirect 准入核查

历史结论：NO-GO。固定 1.104.5 即使关闭 retry / fallback，307/308 仍可能重复生成 POST；Anthropic 凭证可被带到跨 origin / HTTPS downgrade 目标。OpenAI session 注入不能覆盖所有协议，普通 forward proxy / CONNECT 不解决此问题。未引入补丁、代理或生产 Gateway。

[result.json](result.json) 保存脱敏证据，镜像沿用 [L1 锁文件](../litellm-l1/image.lock.json)；控制点以本目录 runner 和 source audit 为准，不把当时结论外推到所有新版本。

需要 Node 24、Docker 和锁定镜像，从仓库根目录执行 `node experiments/litellm-l2-1/run.mjs`。仅用合成凭证 / 本机替身，不加载项目 `.env`，不连接业务库，不调用真实 Provider；新结果写 `.local`。

LiteLLM 不属于当前架构或待实施方向；历史接入计划由 Git 保留。当前文本链见[架构](../../docs/architecture.md#文本-ai-与-provider-plugin)。
