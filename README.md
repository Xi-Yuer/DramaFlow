# DramaFlow

当前保留用户登录、平台鉴权、账户中心、项目管理与 React Flow 空白画布，供后续重新规划实施方案。每个项目一张画布，可保存项目名称、视口及 revision；项目按所有者隔离，列表支持分页。节点、连线、工作流编排和模型插件业务已清除，后续按用户指导逐步新增。

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

| 目录               | 当前内容                                                   |
| ------------------ | ---------------------------------------------------------- |
| apps/web           | Next.js App Router、深色主题、登录、账户中心及空白项目画布 |
| apps/api           | NestJS、Better Auth、默认鉴权、用户资料、项目与基础服务    |
| apps/worker        | 独立 NestJS 应用上下文，尚未注册业务任务                   |
| packages/database  | Prisma、身份/资料/凭证/会话及基础项目模型、pgvector        |
| packages/contracts | 身份、用户资料及基础项目协议，不依赖第三方框架类型         |
| packages/workflow  | 工作流包空入口，保留 LangChain / LangGraph 依赖            |
| packages/plugins   | 插件包空入口，保留模型 SDK 依赖                            |
| packages/context   | 上下文包空入口，待逐步定义                                 |

## 检查与部署

```sh
pnpm check
pnpm test:storage
pnpm test:integration
pnpm stack:up
```

`test` 运行现有单元测试；`test:storage` 使用真实 RustFS 随机测试桶；`test:integration` 使用独立 dramaflow_test 数据库验证认证、会话、角色、来源校验、项目隔离、分页与版本冲突和基础设施，不清空业务库。当前验证结果见 [验证范围](docs/verification.md)。工作流和模型功能尚未实现。

`stack:up` 构建镜像，启动基础设施、初始化存储桶、迁移和初始管理员，再启动 API、worker 和前端。已有数据卷不会因代码清理而自动删除；旧应用镜像需要重新构建后才包含当前代码。

本轮数据库迁移删除旧工作流定义、节点计数及插件安装表；保留项目记录、名称、视口、revision 和全部身份数据，不清空 Redis 或 RustFS。迁移范围及应用方式见 [部署与数据库](docs/deployment.md)。

## 参与开发

- [协作规范](AGENTS.md)
- [基础架构](docs/architecture.md)
- [认证实施与用户字段](docs/authentication.md)
- [开发指南](docs/development.md)
- [部署与数据库](docs/deployment.md)
- [RustFS 存储](docs/object-storage.md)
- [前端基础](docs/frontend-ui.md)
- [当前验证范围](docs/verification.md)
