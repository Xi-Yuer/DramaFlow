# 当前架构

当前保留用户登录、平台鉴权、账户中心、项目管理及 React Flow 空白画布。节点、连线、工作流定义、编排与模型插件实现已移除，等待后续重新规划；没有生成、运行和业务对话能力。

Next.js 使用 App Router、Ant Design 深色主题和 TanStack Query。认证请求同源代理到 NestJS 的 Better Auth HTTP 白名单入口；业务 API 默认受全局 Guard 保护，只有显式 Public 端点可匿名访问。

PostgreSQL/Prisma 保存身份、资料、凭证、会话、认证限流及基础项目；Redis 与 RustFS 保留基础服务。会话 Cookie 不使用 localStorage，服务端每次重新校验用户是否停用及其平台角色。详细身份结构、接口与安全边界见 [认证实施](authentication.md)。

一个项目恰好一张画布，项目记录保存所有者、名称、视口、revision 及时间字段，不保存节点或工作流定义。项目列表、读取与保存均按所有者隔离；列表使用游标分页，保存将所有者与 revision 一并约束原子更新，版本过期返回 409，其他用户的项目不可读写。前端只把中立视口协议转换为 React Flow 类型，contracts 不依赖 React Flow、NestJS、Prisma 或 LangGraph。

项目接口为 `GET /api/v1/projects`、`POST /api/v1/projects`、`GET /api/v1/projects/:id` 和 `PUT /api/v1/projects/:id`；写入在边界校验字段及请求来源。节点目录与模型插件接口已移除，旧工作流或插件字段不再属于项目保存协议。

worker 为独立 NestJS 应用上下文，只复用 infrastructure 模块，不引入 HTTP 认证模块，也不消费业务队列。workflow、plugins、context 保留空入口及选定依赖；LangChain、LangGraph 及模型 SDK 的存在不代表已有适配器、编排器或模型调用能力。contracts 仅提供身份、用户资料及基础项目协议。

将来工作空间成员关系与平台角色分离，领域模块通过服务与契约协作；长期领域约束保留在 AGENTS.md，不表示相关功能已经交付。
