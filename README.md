# DramaFlow

团队自部署的 AI 视频生产工作流平台，漫剧优先。当前交付的是通用工作流：每个项目一张画布、一个 Workflow，发布后按不可变版本执行。

已接入文本生成、简单条件、人工审核、Iteration 和版本内嵌的 SubWorkflow。图片、视频、配音、素材库和自动建议尚未作为产品能力交付。

## 技术栈

TypeScript。React Flow 负责编辑，LangGraph 负责图执行，NestJS API 与独立 Worker 负责受理和运行。数据使用 PostgreSQL / pgvector、Redis 和 RustFS。协议在 `packages/contracts`，编译与执行适配在 `packages/workflow`，业务通过 Node 和受信任插件扩展，不改 Workflow Engine。

## 启动

需要 Node.js 24、pnpm 10.7 和 Docker Compose。

```sh
pnpm install
pnpm env:init
pnpm infra:up
pnpm db:generate
pnpm db:migrate
pnpm auth:bootstrap
pnpm dev
```

Web：http://localhost:3000。API 健康检查：http://localhost:3001/api/v1/health。管理员来自本机 `.env` 的 `ADMIN_EMAIL` / `ADMIN_PASSWORD`。公开注册关闭。不要提交 `.env` 或真实凭证。

PostgreSQL、Redis、RustFS 使用默认端口。完整容器环境用 `pnpm stack:up`。

## 验证

```sh
pnpm check
pnpm test:integration
```

`pnpm check` 是 lint、typecheck、单元测试和 build。`pnpm test:integration` 使用独立测试库、随机队列前缀和独立对象存储桶，不调用真实 AI。浏览器和收费模型不在默认检查里。

## 文档

先读 [AGENTS.md](AGENTS.md) 的任务入口，再按需要打开下面的文档。接口和字段以代码为准。

| 文档                                    | 职责                                      |
| --------------------------------------- | ----------------------------------------- |
| [当前架构](docs/architecture.md)        | 已经实现的能力和入口                      |
| [平台边界](docs/platform-model.md)      | 产品范围，以及 Workflow 与业务解耦        |
| [Workflow](docs/workflow-model.md)      | 定义、版本、运行和调用身份                |
| [Node](docs/node-model.md)              | 节点、Catalog、Iteration、SubWorkflow、If |
| [数据模型](docs/data-model.md)          | DataType、RuntimeValue、Binding、Artifact |
| [Runtime](docs/runtime-architecture.md) | 编译、执行、State 和 Checkpointer         |
| [认证](docs/authentication.md)          | 登录、权限和凭证                          |
| [部署](docs/deployment.md)              | 数据库、队列、迁移和开发数据              |
| [对象存储](docs/object-storage.md)      | RustFS 与 Artifact 写入                   |
| [前端规范](docs/frontend-ui.md)         | 画布与交互约束                            |
| [开发指南](docs/development.md)         | 检查命令、隔离规则和代码目录              |
