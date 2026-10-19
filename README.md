# DramaFlow

DramaFlow 定位为**面向 AI 视频内容生产的可编排工作流平台，以漫剧生产为核心场景，同时支持广告、产品宣传、口播等视频生产流程**，面向团队自部署。

当前保留用户登录、平台鉴权、账户中心、项目管理与 React Flow 空白画布。每个项目一张画布，可保存项目名称、视口及 revision；项目按所有者隔离，列表支持分页。节点、连线、工作流编排和模型插件业务尚未实现。

基础库已实现 Workflow 契约、版本快照，以及 Node 定义、绑定、Preset、NodeRun 和单节点调用校验；尚未接入应用接口、数据库或图调度。具体范围见 [当前架构](docs/architecture.md#workflow-基础库)。

[平台核心模型](docs/platform-model.md) 定义顶层职责：Workflow 与 Node 构成编排骨架，Tool、Plugin、Middleware、Asset 和 Agent 围绕它们服务，领域节点与模板承载漫剧等生产语义。当前阶段与下一步统一见 [分步设计与实施方案](docs/implementation-plan.md)；规划不代表功能已经交付。

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
| packages/contracts | 身份、用户资料、项目及 Workflow / Node 基础 Schema         |
| packages/workflow  | Workflow 契约、快照、Node 配置与 Preset 校验及调用边界     |
| packages/plugins   | 插件包空入口，保留模型 SDK 依赖                            |
| packages/context   | 上下文包空入口，待逐步定义                                 |

上述目录是当前工程结构，不为每个一级概念预建独立包。未来职责的承载边界见 [架构与目录职责](docs/architecture.md)。

## 检查与部署

```sh
pnpm check
pnpm test:storage
pnpm test:integration
pnpm stack:up
```

`test` 运行现有单元测试，包含 Workflow 基础库的契约与快照测试；`test:storage` 使用真实 RustFS 随机测试桶；`test:integration` 使用独立 dramaflow_test 数据库验证认证、会话、角色、来源校验、项目隔离、分页与版本冲突和基础设施，不清空业务库。检查的适用范围见 [开发指南](docs/development.md)。工作流执行和模型调用尚未实现。

`stack:up` 构建镜像，启动基础设施、初始化存储桶、迁移和初始管理员，再启动 API、worker 和前端。已有数据卷不会因更新代码而自动删除。

数据库迁移、部署与数据操作边界见 [部署与数据库](docs/deployment.md)。文档随实施更新，过时内容及时合并或删除，维护约定见 [开发指南](docs/development.md#文档维护)。

## 参与开发

- [协作规范](AGENTS.md)
- [平台核心模型](docs/platform-model.md)
- [Workflow 模型](docs/workflow-model.md)
- [Node 模型](docs/node-model.md)
- [分步设计与实施方案](docs/implementation-plan.md)
- [当前架构与目录职责](docs/architecture.md)
- [认证实施与用户字段](docs/authentication.md)
- [开发指南](docs/development.md)
- [部署与数据库](docs/deployment.md)
- [RustFS 存储](docs/object-storage.md)
- [前端基础](docs/frontend-ui.md)
