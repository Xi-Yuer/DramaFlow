# 分步设计与实施方案

本文管理从平台边界到领域生产能力的设计顺序。顶层结论见 [平台核心模型](platform-model.md)，Workflow 层见 [Workflow 模型](workflow-model.md)，Node 层见 [Node 模型](node-model.md)，已实现能力见 [当前架构](architecture.md)。设计记录不代表功能交付。

## 当前阶段

2026-10-20：完成 PostgreSQL Transactional Outbox、BullMQ Redis 队列与独立 Worker Consumer 接入。API 在事务保存 Run / 恢复意图后确认入队，返回 202；Graph 仅在 Worker 执行。实现与验证边界见 [当前架构](architecture.md#workflow-execution-queue)。

数据语义与承载见 [数据模型](data-model.md)。两类确定性边的依赖、绑定及 ALL Join 规则保持不变；本轮不引入 Human Review、Artifact 内容实现、Plugin、SubWorkflow 或 Batch。

**下一步：明确 recovery_required 执行的运行观测、核查和人工处置流程，再确定首批真实节点接入范围。** 本轮不自动恢复结果不明的 Graph，不把 Queue 重投扩展成业务 Retry；未授权继续扩展 Workflow CRUD 或编辑 / 发布 HTTP。

本文件是当前阶段、下一步与待决策项的唯一维护入口；推进时原地修订，不堆叠旧计划或逐轮交付流水。文档维护方式见 [开发指南](development.md#文档维护)。

## 设计顺序

| 顺序 | 议题                                      | 本步需要回答的问题                               | 状态                                               |
| ---- | ----------------------------------------- | ------------------------------------------------ | -------------------------------------------------- |
| ①    | 平台是什么                                | 平台定位、一级概念、领域层与执行底座             | 已记录顶层决策                                     |
| ②    | Workflow 工作流模型                       | 静态定义、版本、输入输出及 WorkflowRun           | 已确定边界并实施基础库                             |
| ③    | Node 节点模型                             | Manifest、服务端实现、实例、端口、版本与编译边界 | 已实施基础设施与目录接入                           |
| ④    | State / 数据流模型                        | 单次状态、绑定求值、结果传递与并行隔离           | 普通 Action 增量与 outputs reducer 已明确          |
| ⑤    | Runtime 执行模型                          | LangGraph 编译与服务接入、持久化、恢复及事件投影 | Outbox / Queue / Worker 已接入，结果不明处置待确定 |
| ⑥    | Tool 工具体系                             | 可调用操作、调用契约、权限及 Node / Agent 关系   | 待逐步设计                                         |
| ⑦    | Plugin 外部能力体系                       | 能力声明、模型、凭证、版本与供应商适配           | 待逐步设计                                         |
| ⑧    | Middleware 中间件体系                     | 日志、权限、成本、重试的介入边界                 | 待逐步设计                                         |
| ⑨    | Human Review / Interrupt 人工介入         | 暂停、确认、恢复与生成副作用边界                 | 待逐步设计                                         |
| ⑩    | Asset 资产体系                            | 生产资料、媒体引用、版本、归属与生命周期         | 待逐步设计                                         |
| ⑪    | Batch / Parallel / SubWorkflow 长任务体系 | 显式批量、并行、结果收集及子流程生命周期         | 待逐步设计                                         |
| ⑫    | Agent 智能体体系                          | 模型、工具、上下文与人工确认边界                 | 待逐步设计                                         |
| ⑬    | 漫剧领域节点与模板                        | 在已确定底座上表达漫剧生产与领域资料             | 待逐步设计                                         |
| ⑭    | 广告 / 产品 / 口播等扩展                  | 复用底座并补充领域节点和模板                     | 待逐步设计                                         |

这是设计顺序，不要求逐个建设相互脱离的子系统；已经明确且能独立验证的内容同步落到代码。外部生成涉及的 Plugin、Asset、凭证和安全策略不能用占位实现跨过。后续路线不构成一次性实施授权。

Workflow 的可组合性与固定被调用版本原则已在 [Workflow 模型](workflow-model.md#workflow-组合与-subworkflow-边界) 确定。第 ⑪ 步继续细化父子运行与批量生命周期，不授权任意循环、递归调用或项目下多个独立画布 / 工作流。

## 待确定：恢复与生产运行接入

WorkflowRun 记录整次运行，NodeRun 记录节点历史，Checkpoint 负责原生图恢复。以下议题留待单独明确，不构成本轮实施范围：

1. 如何观测与核查 recovery_required，以及如何处理记录状态与 Checkpoint 不一致的基础设施故障？
2. 运行删除与 checkpoint 的保留 / 清理策略如何定义？
3. interaction 节点如何定义 waiting 并在 resume 时复用同一 NodeRun、不增加 attempt？

不提前实现 Retry、Human Review、Control Node、真实模型或完整生成流程。普通 Action 禁止主动 interrupt；原生控制异常保持穿透，已有 NodeRun 保持 running。Human Review 阶段再引入 NodeRun.waiting，明确 resume 复用同一 NodeRun、不增加 attempt；本步不恢复关联，不靠 reducer 静默覆盖已有有效输出。

## 从设计进入代码

每一步记录职责、关系、失败边界、已决策项与待决策项；明确且能独立验证的部分随设计实施，不等待用户再次要求。未确定部分保留边界，不用占位实现冒充可用能力。

1. 对照现有代码和官方资料核实技术事实，明确当轮改变的行为与验收条件。
2. 在现有应用与包中实现必要契约和适配，不为概念清单预建框架或提前拆包。
3. 接口、执行语义或数据库改变时同步更新文档和必要行为测试；数据变更遵守 [协作规范](../AGENTS.md)，只在必要时重置本项目开发数据。
4. 执行相关检查，交付时区分已实现、已验证、未验证和待设计。缺少真实模型凭证时如实记录，不用测试适配器替代生产能力。

启动与检查入口见 [开发指南](development.md)。后续每步以真实新增能力更新架构和阶段，不把整张路线图当作开发授权。
