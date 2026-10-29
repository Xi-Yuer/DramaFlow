# 实施方案

仅维护当前工作和待决策项；能力、接口与限制以[当前架构](architecture.md)为准。规划不构成实施授权。

## 当前阶段

Workflow Run Cancellation 阶段人工验收已通过，可以关闭本阶段；能力与边界见[当前架构](architecture.md#workflow-run-cancellation-foundation)。已通过的真实验收包括：

- Pending Run Cancel；
- Human Review waiting Cancel；
- Human Review 正常 Resume 回归；
- Complete vs Cancel race；
- Running Action / Provider in-flight cooperative Cancel；
- NodeRun cancelled lifecycle；
- Execution Tree cancelled projection；
- Web requested → cancelled。

产品承诺为 Level B + cooperative Level C，不承诺撤销已发送到远端 Provider 的请求、费用或副作用。`uncertain` 产品展示已有实现，但本轮未专门进行真实 lost-worker / recovery_required 场景的人工 UI 验收；不承诺失联自动收敛为 cancelled。uncertain 的处置入口仍属于 deferred operational debt，不阻塞本阶段关闭。

Workflow Run History 最小查询与只读版本查看进入交付验收，等待人工检查历史分页、版本切换、嵌套执行和返回草稿；当前能力见[运行历史](architecture.md#web-workflow-run-history)。不扩展 retry、搜索或 Observability。

Catalog Entry → Composite 的 AI 文本纵向验收等待用户在 Web 完成。测试样例只保留为 test fixture；本机专用项目只创建普通 Draft，人工步骤见[开发指南](development.md#ai-文本-composite-人工验收)。用户检查下钻 Zoom / Grow、选择已有模型、修改内部 prompt / config、返回保存并刷新，再显式 Publish / Run，核对真实输出和 Execution Tree。自动测试使用 fake Provider，不替代真实模型与视觉验收。

Canvas / Adapter / Node Inspector、通用 Input / Iteration 输入、模型设置与模型选择的职责拆分进入结构与交互验收；目录边界见[开发指南](development.md#前端职责目录)，实现入口见[当前架构](architecture.md#web-graph-input-编辑职责)。保持现有协议、提交与显式选择规则，只调整 Web 模块组织。Template 编辑器、Editor 项目元数据会话、后端模型服务与发布校验的集中职责留待后续分别处理，不与本轮通用输入和模型管理迁移混改。

Root Workflow Input → Boundary → Iteration.items 与 Run Form 数组提交等待人工验收；范围见[当前架构](architecture.md#web-workflow-run-inputs)。待人工检查文本 / 数字列表增删、实际提交、Body 映射与数组输出，以及草稿保存重开。Web 人工验收不创建验收 Workflow，不运行浏览器 E2E 或真实 Provider。

Human Review 第五阶段已接入现有 Run 面板的单个文本审批闭环，等待人工 Canvas / Run 验收。能力与限制见[当前架构](architecture.md#web-human-review)。本轮不运行 Browser E2E 或 Provider。

Canvas 小范围视觉优化待人工验收：运行焦点、人工等待、失败辨识、多个完成节点的安静程度，以及大量 DataEdge 的方向流动强度、ControlEdge 静态表现和投影标识。实现范围见[当前架构](architecture.md#canvas-运行态与连线表现)，不扩展 Editor 功能或执行语义。

通用 Child Execution 持久化迁移、通用 Execution Tree 只读查询与 Web 运行树只读浏览进入交付验收；能力与约束见[当前架构](architecture.md#execution-tree-只读查询)。单 item retry / resume、通用 scope 持久化及嵌套 Iteration 执行仍需独立任务。

## 待决策与后续边界

- Tree 条目跳转画布、多槽位关联、Item Retry / Resume 及更多 Iteration UI / Runtime 扩展继续留待独立授权；现有投影与选择边界见 [Graph Execution Projection](architecture.md#graph-execution-projection)。
- Workflow Web 数据依赖可视化仍待人工 Canvas 验收；Template variable candidate、Switch / N-way 和 Nested If 不在当前授权范围。

- Runtime 运维：recovery_required 人工处理、业务记录 / checkpoint 对账、运行删除与保留策略；[独立实验](../experiments/langgraph-iteration-runtime/README.md)已复现 LangGraph 1.5.0 maxConcurrency=1 异常，依赖处理方案待独立评审，本轮不升级或绕过。
- Human Review 分支区域内审核、并行 pending、子 scope 的定义 / 版本 / 权限绑定待独立设计；嵌套 Iteration、Batch 及简单 If 之外的条件拓扑不能直接沿用当前技术预算公式。SubWorkflow v1 已固定调用一次，子图仍不允许 If、Candidate、Human Review、Iteration 与嵌套 SubWorkflow；跨版本调用未授权。
- `data.format_text@1` 先保留，待本次真实 AI 人工验收后评估迁移为 test fixture。当前源码依赖是生产 Registry / internal Catalog 装配、contracts 与节点导出，以及确定性 Runtime、API 鉴权 / 装配、Catalog 和 Web 测试；没有发现其他生产业务调用方。本机开发库另有含该节点的草稿与不可变版本，不能直接移除 Registry 后宣称旧运行仍可执行。后续方案为抽取 `test.format_text` 与值契约到测试 helper，迁移测试及验收草稿，审查现存版本 / Run 的保留或开发数据清理范围，再单独删除生产注册、Catalog 条目及不再使用的生产实现 / 导出。本任务不删除该节点。
- Artifact 内容 HTTP、Asset / Promote、媒体能力、Tool / Agent 和上下文构建均待独立任务；声明或测试夹具不代表产品已交付。

## Execution Tree 演进设计

通用 ChildExecution 已替代专用 ItemRun 存储，当前归属、迁移和查询只维护在[当前架构](architecture.md#child-execution-持久化)。后续沿用[业务解耦原则](platform-model.md#workflow-通用性与业务解耦)，保留同一 Run Tree 协议，不为新 Composite 复制外键、授权、查询或调度器。

### 后续边界

- ChildExecution 是父 NodeRun attempt 的子图调用身份，不等于已建设覆盖 root / 所有 occurrence 的 ExecutionScope 表。是否需要独立 scope、关系型定义定位和 occurrence 直接归属，应在具体调用需求下决定，不叠加互斥归属字段。
- SubWorkflow v1 复用当前版本内的内嵌 Graph Contract 与通用 ChildExecution，不创建新的 WorkflowRun / Job，Iteration Body 仅额外准入 flow.subworkflow@1。子图 Candidate 与 If 仍不开放。
- Retry / Resume、子图 Human Review、跨版本或跨项目子图调用与权限解析均未开放；不能从 failed / running 记录自动重放执行。
- 升级部署先停止旧写入器，迁移与 API / Worker 同步上线。checkpoint 中保留的父 attempt、child ID 与 scope 应继续复用；没有这些真实身份的旧快照不靠 index 猜测回填。

### 下一步最小独立实施任务

Iteration → SubWorkflow v1 → Action DAG 正式准入与 Web 创建路径进入交付验收；[组合执行验证边界](architecture.md#scoped-graph-compilation)及自动测试不能替代真实产品浏览器验收。后续仅进行人工验收；现有组合执行和持久化验证边界见当前架构，其他 Composite 组合 gate 保持关闭。跨版本或跨项目调用、Batch、单 item Retry / Resume 继续另行授权。AI 文本样例验收后保留为 test fixture，不恢复 production development Entry；如需正式通用产品 Entry，另行确认产品需求。
