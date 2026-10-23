# 实施方案

仅维护当前工作和待决策项；能力、接口与限制以[当前架构](architecture.md)为准。规划不构成实施授权。

## 当前阶段

Human Review 第二阶段已接入专用策略与原生 interrupt/resume，已完成相关回归、typecheck、lint 与 build 验证。NodeRun 重入审计、待审批查询 / targeted resume HTTP 与 Web 闭环待后续独立授权。已实现能力及 gate 见[当前架构](architecture.md#human-review-声明与纯业务边界)。本轮不运行 Browser E2E 或 Provider。

## 待决策与后续边界

- Workflow Web 数据依赖可视化仍待人工 Canvas 验收；Template variable candidate、Switch / N-way 和 Nested If 不在当前授权范围。

- Runtime 运维：recovery_required 人工处理、业务记录 / checkpoint 对账、运行删除与保留策略；maxConcurrency=1 的已知宽并行异常需独立调查。
- Human Review 分支区域内审核、并行 pending 与 interaction NodeRun 审计待独立设计；Iteration、Batch、SubWorkflow 及简单 If 之外的条件拓扑不能直接沿用当前技术预算公式。
- Artifact 内容 HTTP、Asset / Promote、媒体能力、Tool / Agent 和上下文构建均待独立任务；声明或测试夹具不代表产品已交付。
