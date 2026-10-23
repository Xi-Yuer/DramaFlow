# 实施方案

仅维护当前工作和待决策项；能力、接口与限制以[当前架构](architecture.md)为准。规划不构成实施授权。

## 当前阶段

If direct convergence 已进入自动验证：当前范围为同一 If 的唯一完整汇聚边界，不包含 candidate input binding 或 Web 改造，也未创建人工测试 Workflow。本轮不运行浏览器 E2E 或真实 Provider；人工交互验收待后续独立任务。已实现能力见[当前架构](architecture.md)与 [Runtime](runtime-architecture.md#if-的直接汇聚)。

## 待决策与后续边界

- Runtime 运维：recovery_required 人工处理、业务记录 / checkpoint 对账、运行删除与保留策略；maxConcurrency=1 的已知宽并行异常需独立调查。
- Human Review、Iteration、Batch、SubWorkflow 及简单 If 之外的条件拓扑各自定义执行语义，不能直接沿用当前技术预算公式。
- Artifact 内容 HTTP、Asset / Promote、媒体能力、Tool / Agent 和上下文构建均待独立任务；声明或测试夹具不代表产品已交付。
