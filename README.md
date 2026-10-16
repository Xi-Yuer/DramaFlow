# DramaFlow

当前基于工程底座实现了用户登录、平台鉴权、个人资料和账户安全。其他工作流、节点、插件、模型调用及素材业务等待用户逐步指导，不恢复旧实现。

## 启动

需要 Node.js **24 LTS**、pnpm **10.7**、Docker Compose。

```sh
pnpm install
pnpm env:init
pnpm infra:up
pnpm db:generate
pnpm db:migrate
pnpm auth:bootstrap
pnpm dev
```

前端 http://localhost:3000 未登录时进入登录页。初始管理员邮箱与密码查看本机 .env 的 ADMIN_EMAIL / ADMIN_PASSWORD，公开注册关闭。API http://localhost:3001/api/v1/health 检查真实基础设施；独立 worker 尚不消费业务任务。账号资料、密码和会话操作见 [认证实施说明](docs/authentication.md)。

基础设施默认端口保持 **5432 / 6379 / 9000 / 9001**，仅绑定宿主 127.0.0.1。RustFS 控制台为 http://localhost:9001/rustfs/console/，凭证位于本机 `.env` 的 `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY`，不要提交该文件。

## 保留的结构

| 目录               | 当前内容                                                 |
| ------------------ | -------------------------------------------------------- |
| apps/web           | Next.js App Router、深色 Ant Design 主题、登录与账户中心 |
| apps/api           | NestJS、Better Auth、默认鉴权、用户资料与基础服务        |
| apps/worker        | 独立 NestJS 应用上下文，尚未注册业务任务                 |
| packages/database  | Prisma、身份/资料/凭证/会话模型及 pgvector               |
| packages/contracts | 用户资料 DTO 与字段白名单，后续协议逐步定义              |
| packages/workflow  | 工作流包空入口，保留 LangGraph 依赖                      |
| packages/plugins   | 插件包空入口，保留模型 SDK 依赖                          |
| packages/context   | 上下文包空入口，待逐步定义                               |

## 检查与部署

```sh
pnpm check
pnpm test:storage
pnpm test:integration
pnpm stack:up
```

`test` 运行现有单元测试；`test:storage` 使用真实 RustFS 随机测试桶；`test:integration` 使用独立 dramaflow_test 数据库验证认证、会话、角色、来源校验和基础设施，不清空业务库。工作流和模型功能尚未实现。

`stack:up` 构建镜像，启动基础设施、初始化存储桶、迁移和初始管理员，再启动 API、worker 和前端。已有数据卷不会因代码清理而自动删除；旧应用镜像需要重新构建后才包含当前代码。

## 参与开发

- [协作规范](AGENTS.md)
- [基础架构](docs/architecture.md)
- [认证实施与用户字段](docs/authentication.md)
- [开发指南](docs/development.md)
- [部署与数据库](docs/deployment.md)
- [RustFS 存储](docs/object-storage.md)
- [前端基础](docs/frontend-ui.md)
- [当前验证范围](docs/verification.md)
