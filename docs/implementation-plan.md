# 实施方案

仅维护当前工作和待决策项；能力、接口与限制以[当前架构](architecture.md)为准。规划不构成实施授权。

## 当前阶段

Iteration Composite Contract / Publish Validation 进入架构评审；范围见[当前架构](architecture.md#iteration-contract-与-publish)。下一步 Compiler / Send / body invocation 与聚合须独立授权，本轮不实现 Iteration Runtime。

Human Review 第五阶段已接入现有 Run 面板的单个文本审批闭环，等待人工 Canvas / Run 验收。能力与限制见[当前架构](architecture.md#web-human-review)。本轮不运行 Browser E2E 或 Provider。

Canvas 小范围视觉优化待人工验收：运行焦点、人工等待、失败辨识、多个完成节点的安静程度，以及大量 DataEdge 的方向流动强度、ControlEdge 静态表现和投影标识。实现范围见[当前架构](architecture.md#canvas-运行态与连线表现)，不扩展 Editor 功能或执行语义。

## 待决策与后续边界

- Workflow Web 数据依赖可视化仍待人工 Canvas 验收；Template variable candidate、Switch / N-way 和 Nested If 不在当前授权范围。

- Runtime 运维：recovery_required 人工处理、业务记录 / checkpoint 对账、运行删除与保留策略；[独立实验](../experiments/langgraph-iteration-runtime/README.md)已复现 LangGraph 1.5.0 maxConcurrency=1 异常，依赖处理方案待独立评审，本轮不升级或绕过。
- Human Review 分支区域内审核、并行 pending、子 scope 的定义 / 版本 / 权限绑定及 Iteration 编译待独立设计；Iteration、Batch、SubWorkflow 及简单 If 之外的条件拓扑不能直接沿用当前技术预算公式。
- Artifact 内容 HTTP、Asset / Promote、媒体能力、Tool / Agent 和上下文构建均待独立任务；声明或测试夹具不代表产品已交付。
