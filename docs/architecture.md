# 系统架构

DramaFlow 采用模块化单体 API 和独立执行 Worker。产品现状与方向见[产品文档](product.md)；协议事实以源码和边界 Schema 为准。

## 应用与包

| 位置                 | 长期职责                                                                               |
| -------------------- | -------------------------------------------------------------------------------------- |
| `apps/web`           | Next.js 产品界面；React Flow 编辑，TanStack Query 管理请求状态                         |
| `apps/api`           | NestJS HTTP、认证授权、项目与视频作品、草稿发布、运行受理和模型管理                    |
| `apps/worker`        | 消费持久化执行命令，构造 Runtime 并运行图                                              |
| `packages/contracts` | 共享 JSON 协议及边界校验；不依赖 React Flow、NestJS、Prisma 或 LangGraph               |
| `packages/workflow`  | 定义语义、Registry、Compiler、Binding、Codec、Submission 与 Runner；通过端口访问持久化 |
| `packages/server`    | API / Worker 共用的授权仓储、队列、Checkpointer、对象存储、凭证与模型装配              |
| `packages/plugins`   | 构建时注册的受信任能力实现、Provider / Model Catalog                                   |
| `packages/database`  | canonical Prisma schema、migration 与数据库客户端                                      |
| `packages/context`   | 空包入口；没有上下文构建或聊天能力                                                     |

API 受理运行并持久化 Outbox，Dispatcher 投递 BullMQ，Worker claim 后执行。Worker 和 API 使用相同数据库、队列前缀、存储配置与加密密钥。节点业务不依赖 HTTP 或 Prisma。

## 业务解耦

Workflow / Compiler / Runtime / Execution / Binding 只理解 Graph、Node、Port、Binding、Scope、Run 和 Artifact 等通用概念。角色、剧集、商品、广告等业务语义属于产品对象、业务节点、插件与模板。

具体业务优先通过 Node + Plugin + Contract 扩展；宏观流程由 Node + Edge + Binding + Control Node 组合。纯业务计算不强制调用外部插件。只有新的通用控制语义才需要独立编译策略，Executor 不按业务名称增加分支。

数据基数不等于执行基数。数组输出只代表数据；显式控制节点才改变执行次数。同一局部 Definition 可以拥有多个执行实例，两者不能混为一体。

Composite 共享 ChildExecution、NodeRun、权限和运行树机制；元素选择、聚合与失败策略留在各自 Strategy。不得为不同 Composite 复制互斥归属字段、调度器或运行详情体系。

## 技术责任

React Flow 负责编辑，LangGraph 负责调度、State 通道、Send、checkpoint 和 interrupt / resume。平台保存自己的定义并编译适配，不自建第二套 scheduler、ready 计数或暂停恢复状态机。LangChain 或 SDK 是内部实现，不成为用户选择的 Provider。

- Catalog Entry 是产品创建描述，Runtime NodeType 是精确类型版本，NodeDefinition 是持久实例。
- Draft 可以编辑；WorkflowVersion 是不可变完整快照；运行始终绑定指定版本。
- State 保存当前有效值，NodeRun 保存尝试记录，ChildExecution 保存嵌套调用，Artifact 保存内容，Checkpoint 保存恢复状态。
- 服务端在所有读写边界验证权限与外部输入；密钥不进入前端、定义、模型上下文或运行日志。
- 收费请求受理不明时不盲目重发，不承诺远端 exactly-once 或取消副作用。

## Project Workspace

Web 的 Project 是视频创作工作空间。`/projects/[id]` 重定向至 `/projects/[id]/overview`，共享 Project Layout 在顶部展示项目名称、返回项目列表和账号菜单，主体采用左侧纵向菜单、右侧页面内容的布局；窄屏收窄侧栏并保留文字入口。五个子路由可以直接访问及刷新恢复，不依赖页面内临时 Tab 状态。

| 子路由      | 职责                                            |
| ----------- | ----------------------------------------------- |
| `overview`  | 项目概览与视频、素材、工作流入口                |
| `videos`    | 项目内视频作品列表、创建与独立作品详情入口      |
| `assets`    | 正式素材页面入口；目前只显示功能未开放的空状态  |
| `workflows` | 复用现有 Canvas、Draft、Publish、Run 与运行查看 |
| `settings`  | 复用现有项目改名、修订冲突处理与删除            |

项目身份与权限加载由共享布局负责，工作流页加载 Canvas，视频详情按需只读查询项目 Workflow 与已发布版本；页面进入不会自动初始化、保存、发布或运行工作流。共享导航、返回项目列表和账号操作接入当前页面的离开保护；Canvas 与项目设置仍使用标准 beforeunload 保护，取消离开保留本地编辑。后台项目读取临时失败保留当前页面，明确拒绝访问则隐藏内容。

数据库仍是一个 Project 至多一个逻辑 Workflow（`Workflow.projectId` 唯一）；新建项目原子创建默认 Workflow，缺失时工作流页保留明确初始化操作。Project 名称、根视口与修订仍独立于 Workflow Draft 保存。这个关系足以支撑当前 Workspace；若后续需要项目内多个 Workflow，才需要调整基数与按 Project 定位 Workflow 的接口。没有 Asset 持久领域模型，也没有把通用 Artifact 当作产品素材库。

前端实现按职责放在 `features/projects/workspace/`：共享布局与导航在入口，页面在 `pages/`；Canvas 继续位于 `features/workflow/editor/`，通用 Workflow Foundation 语义保持独立。

## Video 基础身份

Video 是 Project 内持久的视频作品身份，可以先于 WorkflowRun、生成结果或最终文件存在。一个 Project 可以有多个 Video；Video 只保存 UUID、Project 归属、名称（1—80 字符）、生命周期、创建 / 更新时间和用于乐观并发控制的 revision。不包含剧本、分镜、镜头、prompt、Workflow 绑定或最终文件字段；创建作品本身不创建运行。

生命周期为 `draft`（草稿）、`active`（进行中）、`completed`（已完成），新建固定为 draft。名称与生命周期在作品详情页手动保存，状态表示用户维护的作品整体生命周期，不证明生成完成或已有视频文件；不承载具体生产阶段，也不从 Run 自动推导。

| API                                             | 行为                                                               |
| ----------------------------------------------- | ------------------------------------------------------------------ |
| `GET /api/v1/projects/:projectId/videos`        | 当前项目的视频列表；按创建时间与 ID 倒序，每页 30 个，游标加载更多 |
| `POST /api/v1/projects/:projectId/videos`       | 只接受名称，创建作品身份                                           |
| `GET /api/v1/projects/:projectId/videos/:id`    | 读取指定项目下的作品                                               |
| `PUT /api/v1/projects/:projectId/videos/:id`    | 按 revision 原子保存名称与生命周期，旧修订返回 409                 |
| `DELETE /api/v1/projects/:projectId/videos/:id` | 删除作品身份，成功返回 204                                         |

Contract 位于 `packages/contracts/src/video.ts`，应用服务和路由位于 `apps/api/src/videos/`，沿用 Project Service 直接使用 Prisma 的分层方式。API 复用全局 AuthGuard 与写入 Origin 检查；所有读取、更新和删除同时约束路径 Project、Video ID 与 Project.ownerId，其他账号或同账号的其他 Project 都不能仅凭 Video ID 操作。创建在已授权 Project 行锁事务内完成，防止与项目删除交错。

持久化表为 `video`，Project 外键为 `ON DELETE CASCADE`，数据库 CHECK 限定状态、正修订和非空名称。追加迁移为 `20261030032909_video_identity`，不重写 Foundation baseline。移除行为沿用 Project 的明确确认后永久删除，没有归档 / 恢复或软删除系统。

Web 的列表为 `/projects/[id]/videos`，详情为 `/projects/[id]/videos/[videoId]`，刷新详情直接按项目与作品身份读取；左侧视频菜单在详情页保持选中。空列表提供创建入口，查询失败显示错误而非空成功。详情提供基础身份、手动编辑、删除与下述显式工作流调用，保存冲突保留本地修改，确认重读才替换。列表创建会话和详情编辑复用 Workspace 离开保护；后台临时读取失败保留编辑，明确拒绝访问则隐藏内容。前端实现位于 `features/videos/`，按 `api/`、`list/`、`detail/`、`presentation/` 与 `workflow-invocations/` 分工。

## 产品工作流调用来源

`ProductWorkflowInvocation` 是产品侧的受理来源记录。当前支持 Video，保存自身 UUID、projectId、不可变的 sourceVideoId / sourceVideoName 快照、唯一 workflowRunId、invocationKey 和 createdAt。没有运行状态、输入输出或错误副本，也不定义生产流程。运行事实仍以 WorkflowRun 为准，Artifact 经 Run 追溯来源；Canvas 直接运行可以没有产品调用记录。Workflow Foundation 和 Artifact 不包含 videoId。

| API（均以 `/api/v1` 为前缀）                                     | 行为                                                                                 |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `POST /projects/:projectId/videos/:videoId/workflow-invocations` | 显式提交 workflowVersionId、inputs、invocationKey；202 返回 invocation 与 run        |
| `GET /projects/:projectId/videos/:videoId/workflow-invocations`  | 来源历史，按 createdAt / ID 倒序，每页 20 个，游标分页；Video 删除后仍可查询已有历史 |
| `GET /projects/:projectId/workflow-invocations/by-key/:key`      | 只读恢复；返回 invocation 或 null，不重新创建或投递                                  |
| `GET /projects/:projectId/workflow-invocations/:id`              | 读取来源记录及当前正式 Run 响应；来源作品删除后仍有效                                |

Contract 在 `packages/contracts/src/product/`，产品应用服务在 `apps/api/src/product-workflow-invocations/`。提交与查询复用 Project owner 权限；提交再次确认 Video、Workflow 和固定 WorkflowVersion 属于同一 Project。`WorkflowRunSubmissionFactory.inProjectStartTransaction` 在现有 Repository 边界提供组合事务，事务内复用同一个 DefaultWorkflowRunSubmissionService 的版本 / 输入校验、等价性判断及 Run + start Outbox 创建；产品记录同事务写入，整体提交后才调用现有 Dispatcher。关联写入失败或提交前异常会全部回滚。投递确认不明返回 503 / WORKFLOW_QUEUE_UNAVAILABLE，包含 productWorkflowInvocationId、workflowRunId、invocationKey，产品查询可恢复已受理身份。

数据库表为 `product_workflow_invocation`，追加迁移 `20261030062304_product_workflow_invocations`。`(projectId, invocationKey)` 唯一，产品 key 比 Foundation 的 `(workflowId, invocationKey)` 范围更严格；来源不从 key 解析。同一来源 / key 必须由 Submission 确认 workflow、version、完整 RuntimeValues 等价才返回原调用。不同 Video 使用同 key，或试图认领已有 Canvas Run，返回 PRODUCT_WORKFLOW_INVOCATION_CONFLICT。Product key 与 Foundation start key 分别使用事务 advisory lock，避免并发唯一冲突破坏外层组合事务。

Run 复合外键保证 Project 一致；插入 guard 验证当前 Video 属于 Project、Run 的 key 与产品 key 一致。来源 ID 没有 Video 外键，避免永久删除作品抹除来源；数据库禁止更新来源记录或在 Project 存在时单独删除历史。Video 改名不改写受理时名称，删除 Video 不删除调用、Run、Artifact 或执行树；Project 整体删除按既有生命周期级联清理。这不是 Video 软删除或归档系统。

视频详情复用现有版本选择、Workflow Inputs 表单、运行身份恢复、状态 / 取消 / 审核和 ExecutionTreeBrowser。调用列表按需加载，选择后在抽屉读取真实 Run 状态和执行树；不复制状态表或搭建 Production History。恢复标识按用户、Project、Workflow 及产品来源 namespace 隔离；重进只查询，未确认请求接入作品离开保护。当前项目仍至多一个逻辑 Workflow，因此入口选择它的已发布版本，没有新增多 Workflow 模型或模板系统。

## Provider 与能力装配

调用链是 Node → Capability → ModelConfiguration → Provider Instance → Plugin → Provider API。节点只保存模型配置 ID；调用时重新校验 Run、项目权限、配置及 Provider 的 Owner / enabled，并解密当前凭证。

官方 Provider / Model Catalog 随部署提供 OpenAI、Anthropic 及预设文本模型。`text_generation@1` 使用 Vercel AI SDK 适配两种文本协议；`openai_compatible@1` 提供高级 Custom OpenAI-Compatible。配置目录不等于用户已经创建的模型绑定。

两个插件关闭自动重试、拒绝 redirect，隔离日志 / tracing，并拒绝空白、截断、过滤、工具调用及回显本次凭证的无效文本。节点、插件和供应商之间没有隐藏默认选择或静默替换。

## 阅读与代码入口

| 主题                          | 文档 / 实现                                                            |
| ----------------------------- | ---------------------------------------------------------------------- |
| 定义、节点、编译与局部调用    | [Workflow](workflow.md)、[workflow 包](../packages/workflow/README.md) |
| 运行身份、审核、取消和执行树  | [Execution](execution.md)、[server 包](../packages/server/README.md)   |
| 类型、值、Artifact 与对象存储 | [数据](data.md)                                                        |
| Canvas、Inspector、运行工作区 | [前端](frontend.md)                                                    |
| 身份、会话与凭证              | [安全](security.md)                                                    |
| 环境、测试与编码规范          | [开发](development.md)                                                 |
| 基础设施、迁移与运维          | [部署](deployment.md)                                                  |
