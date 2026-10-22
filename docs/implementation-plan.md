# 实施方案

本文件只维护当前阶段和待决策项。已实现能力集中在 [当前架构](architecture.md)。规划不构成整批实施授权。

## 当前阶段

截至 2026-10-22，已完成项目画布与模型管理基础（A3 / A4），以及 C2.1 文本能力接入、C2.2 生产残留清理。文本能力沿用现有 ProviderCapability / Provider Instance / ModelConfiguration，通过 Vercel AI SDK 支持 OpenAI 与 Anthropic。历史实验不进入生产镜像。

默认文档只保留现状和仍有效的约束。下一步等待明确任务，不自动推进 A6、Provider Catalog UI、其他厂商或新生成能力。

## 待决策与后续边界

- 编辑器后续入口：节点添加、配置、模型选择、发布与运行交互。实施前需明确本轮页面和操作边界。
- Runtime：recovery_required 的核查与人工处理、业务记录与 checkpoint 的对账、运行删除及 checkpoint 保留策略。
- Human Review：interaction 节点的 waiting / resume，以及复用 NodeRun 与 attempt 的关联。继续采用 LangGraph 原生机制。
- Tool / Agent、Asset / Promote、控制结构、Batch / SubWorkflow、媒体节点与漫剧模板按各自任务设计。协议或测试节点不是已交付功能。

总体顺序仍是定义与数据、执行底座、外部能力与资料、人工交互及组合、领域模板。每步只落地可验证需求，不预建完整框架。

## 技术路线结论

| 路线 | 结论与证据 |
| --- | --- |
| Vercel AI SDK | C1 为 GO；C2.1 已正式接入。原始证据见 [C1](../experiments/ai-sdk-c1/README.md) |
| LiteLLM | REJECTED / NO-GO。证据见 [L1](../experiments/litellm-l1/README.md)、[L2](../experiments/litellm-l2/README.md)、[L2.1](../experiments/litellm-l2-1/README.md)，评估全文在 experiments，停止后续集成 |
| Bifrost | REJECTED / NO-GO。证据见 [B1](../experiments/bifrost-b1/README.md)、[B1.1](../experiments/bifrost-b1-1/README.md) |

不恢复独立 Gateway 路线，不迁移或删除 `openai_compatible@1`。历史评估只用于解释决策，需要复核时才读取。
