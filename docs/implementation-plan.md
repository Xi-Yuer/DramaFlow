# 实施方案

仅维护当前工作和待决策项；能力、接口与限制以[当前架构](architecture.md)为准。规划不构成实施授权。

## 当前阶段

If Branch successor 已完成人工验证。Merge 当前仅交付领域声明与静态边界分析，生产 Publish / Compile gate 保持关闭。下一步须单独实现并验证 LangGraph 汇聚编译、选中分支完成 barrier、START / END 与预算后才能开放执行；Web Merge 编辑与候选输入绑定分别独立推进，未获本轮实施授权。已实现能力见[当前架构](architecture.md)与 [Runtime](runtime-architecture.md#merge-静态边界尚不可执行)。

## 待决策与后续边界

- Runtime 运维：recovery_required 人工处理、业务记录 / checkpoint 对账、运行删除与保留策略；maxConcurrency=1 的已知宽并行异常需独立调查。
- Human Review、Iteration、Batch、SubWorkflow 及简单 If 之外的条件拓扑各自定义执行语义，不能直接沿用当前技术预算公式。
- Artifact 内容 HTTP、Asset / Promote、媒体能力、Tool / Agent 和上下文构建均待独立任务；声明或测试夹具不代表产品已交付。
