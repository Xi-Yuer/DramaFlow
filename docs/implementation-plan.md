# 实施方案

仅维护当前工作和待决策项；能力、接口与限制以[当前架构](architecture.md)为准。规划不构成实施授权。

## 当前阶段

If Task 2 已完成自动验证：专用编译策略、原生条件路由、内部 State、简单拓扑准入与执行预算；仅支持终端 Action 分支。Task 3 Web 编辑尚未授权，不自动开始。

## 待决策与后续边界

- Runtime 运维：recovery_required 人工处理、业务记录 / checkpoint 对账、运行删除与保留策略；maxConcurrency=1 的已知宽并行异常需独立调查。
- Human Review、Iteration、Batch、SubWorkflow 及简单 If 之外的条件拓扑各自定义执行语义，不能直接沿用当前技术预算公式。
- Artifact 内容 HTTP、Asset / Promote、媒体能力、Tool / Agent 和上下文构建均待独立任务；声明或测试夹具不代表产品已交付。
