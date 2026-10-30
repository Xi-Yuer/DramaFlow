# 系统架构

DramaFlow 采用模块化单体 API 和独立执行 Worker。产品现状与方向见[产品文档](product.md)；协议事实以源码和边界 Schema 为准。

## 应用与包

| 位置                 | 长期职责                                                                               |
| -------------------- | -------------------------------------------------------------------------------------- |
| `apps/web`           | Next.js 产品界面；React Flow 编辑，TanStack Query 管理请求状态                         |
| `apps/api`           | NestJS HTTP、认证授权、项目、草稿发布、运行受理和模型管理                              |
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

Web 的 Project 是视频创作工作空间。`/projects/[id]` 重定向至 `/projects/[id]/overview`，共享 Project Layout 提供项目名称、返回项目列表、账号菜单和五个入口；各子路由可以直接访问及刷新恢复，不依赖页面内临时 Tab 状态。

| 子路由      | 职责                                            |
| ----------- | ----------------------------------------------- |
| `overview`  | 项目概览与视频、素材、工作流入口                |
| `videos`    | 正式视频页面入口；目前只显示功能未开放的空状态  |
| `assets`    | 正式素材页面入口；目前只显示功能未开放的空状态  |
| `workflows` | 复用现有 Canvas、Draft、Publish、Run 与运行查看 |
| `settings`  | 复用现有项目改名、修订冲突处理与删除            |

项目身份与权限加载由共享布局负责，只有工作流页读取 Workflow；进入其他页面不会初始化、保存、发布或运行工作流。共享导航、返回项目列表和账号操作接入当前页面的离开保护；Canvas 与项目设置仍使用标准 beforeunload 保护，取消离开保留本地编辑。后台项目读取临时失败保留当前页面，明确拒绝访问则隐藏内容。

数据库仍是一个 Project 至多一个逻辑 Workflow（`Workflow.projectId` 唯一）；新建项目原子创建默认 Workflow，缺失时工作流页保留明确初始化操作。Project 名称、根视口与修订仍独立于 Workflow Draft 保存。这个关系足以支撑当前 Workspace 骨架；若后续需要项目内多个 Workflow，才需要调整基数与按 Project 定位 Workflow 的接口。没有 Video / Asset 领域模型，也没有把通用 Artifact 当作产品素材库。

前端实现按职责放在 `features/projects/workspace/`：共享布局与导航在入口，页面在 `pages/`；Canvas 继续位于 `features/workflow/editor/`，通用 Workflow Foundation 语义保持独立。

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
