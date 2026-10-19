# 当前架构与目录职责

DramaFlow 是面向 AI 视频内容生产、以漫剧为核心场景的可编排工作流平台，面向团队自部署。已确定的一级概念与边界见 [平台核心模型](platform-model.md)，设计推进顺序见 [分步设计与实施方案](implementation-plan.md)。

## 已实现的基础工程

当前保留用户登录、平台鉴权、账户中心、项目管理及 React Flow 空白画布。节点、连线、工作流定义、编排与模型插件实现已移除；没有生成、运行和业务对话能力。顶层模型已记录，后续按步骤重新设计业务。

Next.js 使用 App Router、Ant Design 深色主题和 TanStack Query。认证请求同源代理到 NestJS 的 Better Auth HTTP 白名单入口；业务 API 默认受全局 Guard 保护，只有显式 Public 端点可匿名访问。

PostgreSQL/Prisma 保存身份、资料、凭证、会话、认证限流及基础项目；Redis 与 RustFS 保留基础服务。会话 Cookie 不使用 localStorage，服务端每次重新校验用户是否停用及其平台角色。详细身份结构、接口与安全边界见 [认证实施](authentication.md)。

一个项目恰好一张画布，项目记录保存所有者、名称、视口、revision 及时间字段，不保存节点或工作流定义。项目列表、读取与保存均按所有者隔离；列表使用游标分页，保存将所有者与 revision 一并约束原子更新，版本过期返回 409，其他用户的项目不可读写。前端只把中立视口协议转换为 React Flow 类型，contracts 不依赖 React Flow、NestJS、Prisma 或 LangGraph。

项目接口为 `GET /api/v1/projects`、`POST /api/v1/projects`、`GET /api/v1/projects/:id` 和 `PUT /api/v1/projects/:id`；写入在边界校验字段及请求来源。节点目录与模型插件接口已移除，旧工作流或插件字段不再属于项目保存协议。

worker 为独立 NestJS 应用上下文，只复用 infrastructure 模块，不引入 HTTP 认证模块，也不消费业务队列。workflow、plugins、context 保留空入口及选定依赖；LangChain、LangGraph 及模型 SDK 的存在不代表已有适配器、编排器或模型调用能力。contracts 仅提供身份、用户资料及基础项目协议。

将来工作空间成员关系与平台角色分离，领域模块通过服务与契约协作；长期领域约束保留在 AGENTS.md，不表示相关功能已经交付。

## 现有目录如何承载后续模型

继续采用模块化单体与独立 worker。下表的后续职责是边界约束，具体接口与目录拆分随相应设计步骤确定；不表示已存在这些业务实现。

| 目录                 | 当前实现                                      | 后续承载边界                                                                      |
| -------------------- | --------------------------------------------- | --------------------------------------------------------------------------------- |
| `apps/web`           | 登录、账户中心、项目列表、React Flow 空白画布 | 创作交互、编辑视图与前端适配；不加载服务端插件适配器或密钥                        |
| `apps/api`           | 认证、用户资料、项目 API 与基础设施服务       | 模块化业务入口、权限、定义与运行管理、资产等应用服务；模块通过服务及契约协作      |
| `apps/worker`        | NestJS 应用上下文，仅接入基础设施             | 承载独立执行进程，调用运行时；不另建一套工作流调度语义                            |
| `packages/contracts` | 身份、资料、会话摘要及基础项目协议            | 经逐步设计确定的平台中立协议与边界校验，不依赖框架或数据库模型                    |
| `packages/database`  | Prisma 与身份、基础项目持久化                 | 数据访问及迁移；数据库结构随真实领域模型设计，不以概念表直接生成数据表            |
| `packages/workflow`  | 空入口，保留 LangChain / LangGraph 依赖       | 工作流核心及执行适配的候选承载包；保持 Runtime 的领域无关边界，具体拆分待设计     |
| `packages/plugins`   | 空入口，保留模型 SDK 依赖                     | 受信任的外部能力适配；不承担工作流调度或隐式供应商选择                            |
| `packages/context`   | 空入口                                        | 独立上下文构建职责；只使用明确选择或绑定的数据，不把整个 State 自动变成模型上下文 |

`apps/api/src/workflows`、`runtime`、`runs`、`plugins`、`assets` 等目前只有 `.gitkeep` 的目录只是预留位置。Tool、Middleware、Agent、领域节点与模板暂不新增独立包或空壳类；等职责和真实依赖明确后再决定承载位置。

## 依赖与适配边界

前端通过平台协议调用 API，React Flow 编辑类型在前端转换。API 和 worker 在服务端协调业务、运行与基础设施；LangGraph、供应商 SDK 和 Prisma 类型在各自适配层转换，不进入 contracts。

领域节点与模板组合工作流底座。Runtime 依据通用契约协调节点、State 与产物引用，不包含“如果是漫剧 / 广告 / 口播”的业务调度分支；Middleware 也不承担领域流程或替代 LangGraph 调度。Tool、Capability 与 Plugin 的协作不是强制逐级调用链，详细职责见 [平台核心模型](platform-model.md)。

一个项目仍恰好一张画布，未来对应一个逻辑 Workflow；多个版本与多次运行不意味着多个独立工作流。当前项目协议与数据库尚未加入 Workflow，现有 `revision` 仅作并发保存检查，不能作为不可变工作流版本使用。
