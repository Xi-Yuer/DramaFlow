# 实施方案

仅维护当前工作和待决策项；能力、接口与限制以[当前架构](architecture.md)为准。规划不构成实施授权。

## 当前阶段

当前授权的用户级模型作用域改造已完成迁移与自动验证，待人工验收跨项目界面。下一步需明确授权；不自动开始 Artifact 内容读取、Run History 或其他功能。

## 待决策与后续边界

- Runtime 运维：recovery_required 人工处理、业务记录 / checkpoint 对账、运行删除与保留策略；maxConcurrency=1 的已知宽并行异常需独立调查。
- Human Review、Iteration、Batch、SubWorkflow、conditional 各自定义执行语义，不能沿用普通 Action DAG 的技术预算公式。
- Artifact 内容 HTTP、Asset / Promote、媒体能力、Tool / Agent 和上下文构建均待独立任务；声明或测试夹具不代表产品已交付。
