# DramaFlow 基础工程

当前仅保留可运行的工程底座。工作流、节点、插件、模型调用、会话、权限及素材业务实现已移除，后续由用户逐步指导设计和开发。

## 启动

需要 Node.js **24 LTS**、pnpm **10.7**、Docker Compose。

```sh
pnpm install
pnpm env:init
pnpm infra:up
pnpm db:generate
pnpm db:migrate
pnpm dev
```

前端 http://localhost:3000 显示基础入口；API http://localhost:3001/api/v1/health 检查真实 PostgreSQL、Redis 和 RustFS；独立 worker 启动并连接基础设施，当前不消费业务任务。

基础设施默认端口保持 **5432 / 6379 / 9000 / 9001**，仅绑定宿主 127.0.0.1。RustFS 控制台为 http://localhost:9001/rustfs/console/，凭证位于本机 `.env` 的 `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY`，不要提交该文件。

## 保留的结构

| 目录               | 当前内容                                                                              |
| ------------------ | ------------------------------------------------------------------------------------- |
| apps/web           | Next.js App Router、Ant Design 主题、Query Provider、基础 UI 适配及预留 features 目录 |
| apps/api           | NestJS、健康检查、数据库/Redis/S3/加密基础服务及预留业务目录                          |
| apps/worker        | 独立 NestJS 应用上下文，尚未注册业务任务                                              |
| packages/database  | Prisma 客户端、空业务 schema 和 pgvector 扩展迁移                                     |
| packages/contracts | 协议包空入口，待逐步定义                                                              |
| packages/workflow  | 工作流包空入口，保留 LangGraph 依赖                                                   |
| packages/plugins   | 插件包空入口，保留模型 SDK 依赖                                                       |
| packages/context   | 上下文包空入口，待逐步定义                                                            |

## 检查与部署

```sh
pnpm check
pnpm test:storage
pnpm test:integration
pnpm stack:up
```

`test` 只运行现有基础工具单元测试；`test:storage` 使用真实 RustFS 随机测试桶；`test:integration` 构建后验证 API 健康和旧业务路由已移除，不写业务数据。业务测试已删除，不代表未来功能已验收。

`stack:up` 构建镜像，启动基础设施、初始化存储桶和迁移，再启动 API、worker 和前端。已有数据卷不会因代码清理而自动删除；旧应用镜像需要重新构建后才包含当前代码。

## 参与开发

- [协作规范](AGENTS.md)
- [基础架构](docs/architecture.md)
- [开发指南](docs/development.md)
- [部署与数据库](docs/deployment.md)
- [RustFS 存储](docs/object-storage.md)
- [前端基础](docs/frontend-ui.md)
- [当前验证范围](docs/verification.md)
