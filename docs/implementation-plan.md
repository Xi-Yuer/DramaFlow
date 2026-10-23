# 实施方案

仅维护当前工作和待决策项；能力、接口与限制以[当前架构](architecture.md)为准。规划不构成实施授权。

## 当前阶段

当前保持 If branch successor、分支内 parallel / ALL join 与 conditional Workflow Output 能力，implicit cross-branch convergence 仍由 Publish / Compiler 拒绝。下一任务才研究并实施基于静态分析的直接 convergence，不新增领域汇聚节点，本轮不开放执行。已实现能力见[当前架构](architecture.md)与 [Runtime](runtime-architecture.md#简单-if-的条件路由与预算)。

## 待决策与后续边界

- Runtime 运维：recovery_required 人工处理、业务记录 / checkpoint 对账、运行删除与保留策略；maxConcurrency=1 的已知宽并行异常需独立调查。
- Human Review、Iteration、Batch、SubWorkflow 及简单 If 之外的条件拓扑各自定义执行语义，不能直接沿用当前技术预算公式。
- Artifact 内容 HTTP、Asset / Promote、媒体能力、Tool / Agent 和上下文构建均待独立任务；声明或测试夹具不代表产品已交付。
