# 实施方案

本文件只维护当前阶段和待决策项。已实现能力集中在 [当前架构](architecture.md)。规划不构成整批实施授权。

## 当前阶段

截至 2026-10-22，已完成项目画布与模型管理基础（A3 / A4）、C2.1 文本能力接入、C2.2 生产残留清理、C2.3 架构文档校正，以及后端 Provider Catalog。正式文本链由 `text_generation@1` 在内部通过 Vercel AI SDK 调用 OpenAI 与 Anthropic。OpenAI / Anthropic 的 Provider Definition 在代码目录中，实例复用 ModelProvider。Web 模型供应商页按该目录配置凭证。Model Catalog 用代码声明 OpenAI `gpt-4o` 与 Anthropic `claude-sonnet-4-20250514`，均可按 `text.generate` 查询。调用厂商 API 的模型发现、其他厂商和新媒体能力尚未实现。

下一步等待明确任务，不自动推进 A6、节点模型选择器、其他厂商或新生成能力。

## 待决策与后续边界

- 编辑器后续入口：节点添加、配置、模型选择、发布与运行交互。实施前需明确本轮页面和操作边界。
- Runtime：recovery_required 的核查与人工处理、业务记录与 checkpoint 的对账、运行删除及 checkpoint 保留策略。
- Human Review：interaction 节点的 waiting / resume，以及复用 NodeRun 与 attempt 的关联。继续采用 LangGraph 原生机制。
- Tool / Agent、Asset / Promote、控制结构、Batch / SubWorkflow、媒体节点与漫剧模板按各自任务设计。协议或测试节点不是已交付功能。

总体顺序仍是定义与数据、执行底座、外部能力与资料、人工交互及组合、领域模板。每步只落地可验证需求，不预建完整框架。

## 技术路线结论

| 路线          | 结论与证据                                                                                                                                                           |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Vercel AI SDK | C1 为 GO。C2.1 起由 `text_generation@1` 在内部使用，覆盖 OpenAI / Anthropic 文本。其他能力各自选择插件。证据见 [C1](../experiments/ai-sdk-c1/README.md)              |
| LiteLLM       | 已评估，REJECTED / NO-GO。证据见 [L1](../experiments/litellm-l1/README.md)、[L2](../experiments/litellm-l2/README.md)、[L2.1](../experiments/litellm-l2-1/README.md) |
| Bifrost       | 已评估，REJECTED / NO-GO。证据见 [B1](../experiments/bifrost-b1/README.md)、[B1.1](../experiments/bifrost-b1-1/README.md)                                            |

LiteLLM 与 Bifrost 不是当前或计划中的生产依赖。保留 `openai_compatible@1` 作为高级 Custom OpenAI-Compatible。历史评估只在复核决策时读取。
