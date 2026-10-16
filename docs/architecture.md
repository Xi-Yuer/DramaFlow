# 当前架构

工程底座上新增了用户登录、平台鉴权和账户中心。工作流、节点、模型插件、生成与业务对话仍未实现。

Next.js 使用 App Router、Ant Design 深色主题和 TanStack Query。认证请求同源代理到 NestJS 的 Better Auth HTTP 白名单入口；业务 API 默认受全局 Guard 保护，只有显式 Public 端点可匿名访问。

PostgreSQL/Prisma 保存身份、资料、凭证、会话与认证限流；Redis 与 RustFS 保留基础服务。会话 Cookie 不使用 localStorage，服务端每次重新校验用户是否停用及其平台角色。详细数据结构、接口与安全边界见 [认证实施](authentication.md)。

worker 为独立 NestJS 应用上下文，只复用 infrastructure 模块，不引入 HTTP 认证模块，也不消费历史业务队列。workflow、plugins、context 保留空入口及选定依赖，contracts 目前仅实现用户资料协议。

将来工作空间成员关系与平台角色分离，领域模块通过服务与契约协作；本轮认证功能不授权恢复整个旧工作台。
