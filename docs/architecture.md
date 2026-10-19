# 当前架构与目录职责

DramaFlow 是面向 AI 视频内容生产、以漫剧为核心场景的可编排工作流平台，面向团队自部署。已确定的一级概念与边界见 [平台核心模型](platform-model.md)，静态定义、版本及运行关系见 [Workflow 模型](workflow-model.md)，设计推进顺序见 [分步设计与实施方案](implementation-plan.md)。

## 已实现的基础工程

当前应用保留用户登录、平台鉴权、账户中心、项目管理及 React Flow 空白画布，没有节点编辑、生成、运行和业务对话能力。共享包已开始实现 Workflow 契约及纯函数基础能力，尚未接入应用接口或数据库。

Next.js 使用 App Router、Ant Design 深色主题和 TanStack Query。认证请求同源代理到 NestJS 的 Better Auth HTTP 白名单入口；业务 API 默认受全局 Guard 保护，只有显式 Public 端点可匿名访问。

PostgreSQL/Prisma 保存身份、资料、凭证、会话、认证限流及基础项目；Redis 与 RustFS 保留基础服务。会话 Cookie 不使用 localStorage，服务端每次重新校验用户是否停用及其平台角色。详细身份结构、接口与安全边界见 [认证实施](authentication.md)。

一个项目恰好一张画布，项目记录保存所有者、名称、视口、revision 及时间字段，不保存节点或工作流定义。项目列表、读取与保存均按所有者隔离；列表使用游标分页，保存将所有者与 revision 一并约束原子更新，版本过期返回 409，其他用户的项目不可读写。前端只把中立视口协议转换为 React Flow 类型，contracts 不依赖 React Flow、NestJS、Prisma 或 LangGraph。

项目接口为 `GET /api/v1/projects`、`POST /api/v1/projects`、`GET /api/v1/projects/:id` 和 `PUT /api/v1/projects/:id`；写入在边界校验字段及请求来源。节点目录与模型插件接口已移除，旧工作流或插件字段不再属于项目保存协议。

worker 为独立 NestJS 应用上下文，只复用 infrastructure 模块，不引入 HTTP 认证模块，也不消费业务队列。plugins、context 保留空入口；LangChain、LangGraph 及模型 SDK 的存在不代表已有适配器、编排器或模型调用能力。

将来工作空间成员关系与平台角色分离，领域模块通过服务与契约协作；长期领域约束保留在 AGENTS.md，不表示相关功能已经交付。

## Workflow 基础库

`packages/contracts/src/workflow.ts` 提供 Workflow、版本和运行元数据 Schema、六种运行状态、输出来源及契约名称校验。`createWorkflowSchemas` 要求调用方显式传入 DataType、Node、Edge Schema，再组合静态定义、草稿及版本 Schema；已校验顶层字段、输入输出名称与节点标识唯一、输出引用的节点存在。没有宽松的默认节点或类型协议，具体边关系、输出键存在性、类型兼容及联合依赖无环校验仍待相关模型接入。

`packages/workflow` 已提供：

- `parseWorkflowInputs`：依据已编译的具体 Zod 值契约校验运行输入，拒绝未声明字段，返回经过 JSON 校验的独立值。
- `collectWorkflowOutputs`：按声明的节点和输出键收集并校验最终结果，拒绝缺失来源、继承属性或类型不符，只暴露声明的输出。
- `createWorkflowVersionSnapshot`：要求完整版本 Schema，校验后复制并递归冻结 JSON 快照，避免后续草稿或调用方修改影响该对象。
- `assertWorkflowRunVersion`：检查运行绑定的版本身份及 Workflow 身份一致。

这些是可调用的基础库函数，不创建运行、调用插件或执行图。快照只保证内存对象隔离与只读，不替代发布权限、持久化不可变性或并发控制。运行元数据校验不等于完整状态机，输入资产权限仍需由应用服务校验。具体 Node / Edge / DataType 协议、HTTP 发布和运行接口、数据库模型、LangGraph 适配尚未实现。

现有单元测试覆盖契约组合、边界校验、显式多结果收集、快照隔离及版本绑定；测试中的具体节点和类型 Schema 只用于测试，不作为生产适配器。

## 现有目录如何承载后续模型

继续采用模块化单体与独立 worker。下表的后续职责是边界约束，具体接口与目录拆分随相应设计步骤确定；不表示已存在这些业务实现。

| 目录                 | 当前实现                                      | 后续承载边界                                                                      |
| -------------------- | --------------------------------------------- | --------------------------------------------------------------------------------- |
| `apps/web`           | 登录、账户中心、项目列表、React Flow 空白画布 | 创作交互、编辑视图与前端适配；不加载服务端插件适配器或密钥                        |
| `apps/api`           | 认证、用户资料、项目 API 与基础设施服务       | 模块化业务入口、权限、定义与运行管理、资产等应用服务；模块通过服务及契约协作      |
| `apps/worker`        | NestJS 应用上下文，仅接入基础设施             | 承载独立执行进程，调用运行时；不另建一套工作流调度语义                            |
| `packages/contracts` | 身份、资料、项目协议及 Workflow 基础 Schema   | 经逐步设计确定的平台中立协议与边界校验，不依赖框架或数据库模型                    |
| `packages/database`  | Prisma 与身份、基础项目持久化                 | 数据访问及迁移；数据库结构随真实领域模型设计，不以概念表直接生成数据表            |
| `packages/workflow`  | Workflow 值契约、输出收集、快照和运行版本检查 | 工作流核心及执行适配的承载包；保持 Runtime 的领域无关边界，具体拆分待设计         |
| `packages/plugins`   | 空入口，保留模型 SDK 依赖                     | 受信任的外部能力适配；不承担工作流调度或隐式供应商选择                            |
| `packages/context`   | 空入口                                        | 独立上下文构建职责；只使用明确选择或绑定的数据，不把整个 State 自动变成模型上下文 |

`apps/api/src/workflows`、`runtime`、`runs`、`plugins`、`assets` 等目前只有 `.gitkeep` 的目录只是预留位置。Tool、Middleware、Agent、领域节点与模板暂不新增独立包或空壳类；等职责和真实依赖明确后再决定承载位置。

## 依赖与适配边界

前端通过平台协议调用 API，React Flow 编辑类型在前端转换。API 和 worker 在服务端协调业务、运行与基础设施；LangGraph、供应商 SDK 和 Prisma 类型在各自适配层转换，不进入 contracts。

领域节点与模板组合工作流底座。Runtime 依据通用契约协调节点、State 与产物引用，不包含“如果是漫剧 / 广告 / 口播”的业务调度分支；Middleware 也不承担领域流程或替代 LangGraph 调度。Tool、Capability 与 Plugin 的协作不是强制逐级调用链，详细职责见 [平台核心模型](platform-model.md)。

一个项目仍恰好一张画布，未来对应一个逻辑 Workflow；多个版本与多次运行不意味着多个独立工作流。组合调用的设计引用另一个项目的固定 WorkflowVersion，并检查其权限，不增加同项目多工作流层级。当前项目协议与数据库尚未加入 Workflow，现有 `revision` 仅作并发保存检查，不能作为不可变工作流版本使用。
