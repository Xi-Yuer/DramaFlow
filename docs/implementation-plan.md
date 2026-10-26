# 实施方案

仅维护当前工作和待决策项；能力、接口与限制以[当前架构](architecture.md)为准。规划不构成实施授权。

## 当前阶段

Canvas / Adapter / Node Inspector、通用 Input / Iteration 输入、模型设置与模型选择的职责拆分进入结构与交互验收；目录边界见[开发指南](development.md#前端职责目录)，实现入口见[当前架构](architecture.md#web-graph-input-编辑职责)。保持现有协议、提交与显式选择规则，只调整 Web 模块组织。Template 编辑器、Editor 项目元数据会话、后端模型服务与发布校验的集中职责留待后续分别处理，不与本轮通用输入和模型管理迁移混改。

Root Workflow Input → Boundary → Iteration.items 与 Run Form 数组提交等待人工验收；范围见[当前架构](architecture.md#web-workflow-run-inputs)。待人工检查文本 / 数字列表增删、实际提交、Body 映射与数组输出，以及草稿保存重开。Web 人工验收不创建验收 Workflow，不运行浏览器 E2E 或真实 Provider。

Human Review 第五阶段已接入现有 Run 面板的单个文本审批闭环，等待人工 Canvas / Run 验收。能力与限制见[当前架构](architecture.md#web-human-review)。本轮不运行 Browser E2E 或 Provider。

Canvas 小范围视觉优化待人工验收：运行焦点、人工等待、失败辨识、多个完成节点的安静程度，以及大量 DataEdge 的方向流动强度、ControlEdge 静态表现和投影标识。实现范围见[当前架构](architecture.md#canvas-运行态与连线表现)，不扩展 Editor 功能或执行语义。

通用 Child Execution 持久化迁移、通用 Execution Tree 只读查询与 Web 运行树只读浏览进入交付验收；能力与约束见[当前架构](architecture.md#execution-tree-只读查询)。单 item retry / resume、通用 scope 持久化及嵌套 Iteration 执行仍需独立任务。

## 待决策与后续边界

- Workflow Web 数据依赖可视化仍待人工 Canvas 验收；Template variable candidate、Switch / N-way 和 Nested If 不在当前授权范围。

- Runtime 运维：recovery_required 人工处理、业务记录 / checkpoint 对账、运行删除与保留策略；[独立实验](../experiments/langgraph-iteration-runtime/README.md)已复现 LangGraph 1.5.0 maxConcurrency=1 异常，依赖处理方案待独立评审，本轮不升级或绕过。
- Human Review 分支区域内审核、并行 pending、子 scope 的定义 / 版本 / 权限绑定待独立设计；嵌套 Iteration、Batch、SubWorkflow 及简单 If 之外的条件拓扑不能直接沿用当前技术预算公式。SubWorkflow 的执行接入仍需独立任务；当前 Definition / 静态校验基础不授权 Compiler Strategy、后续 Composite Runtime 或 Web 编辑扩展。
- Artifact 内容 HTTP、Asset / Promote、媒体能力、Tool / Agent 和上下文构建均待独立任务；声明或测试夹具不代表产品已交付。

## Execution Tree 演进设计

通用 ChildExecution 已替代专用 ItemRun 存储，当前归属、迁移和查询只维护在[当前架构](architecture.md#child-execution-持久化)。后续沿用[业务解耦原则](platform-model.md#workflow-通用性与业务解耦)，保留同一 Run Tree 协议，不为新 Composite 复制外键、授权、查询或调度器。

### 后续边界

- ChildExecution 是父 NodeRun attempt 的子图调用身份，不等于已建设覆盖 root / 所有 occurrence 的 ExecutionScope 表。是否需要独立 scope、关系型定义定位和 occurrence 直接归属，应在具体调用需求下决定，不叠加互斥归属字段。
- SubWorkflow 运行仍需独立任务，复用当前版本内的内嵌 Graph Contract 与通用持久化；不要创建新的 WorkflowRun / Job，也不因本次迁移解除 Iteration body capability gate。
- Retry / Resume、子图 Human Review、跨版本或跨项目子图调用与权限解析均未开放；不能从 failed / running 记录自动重放执行。
- 升级部署先停止旧写入器，迁移与 API / Worker 同步上线。checkpoint 中保留的父 attempt、child ID 与 scope 应继续复用；没有这些真实身份的旧快照不靠 index 猜测回填。

### 下一步最小独立实施任务

独立评审内嵌 SubWorkflow 的单次局部图编译接入及 checkpoint 验证，明确首期允许的子图节点集合。该方向不构成实施授权；通用 scope 扩展、Web 编辑、Batch、单 item Retry / Resume 继续另行授权。
