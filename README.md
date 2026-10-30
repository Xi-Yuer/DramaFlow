# DramaFlow

团队自部署的 AI 视频创作平台，漫剧优先，当前 AI 生成能力以文本为主。Project 提供视频创作工作空间，用户在其中通过工作流组合节点，发布不可变版本，再运行、审核和查看结果。

已提供文本生成、受限条件分支、人工审核、Iteration、版本内嵌 SubWorkflow、运行历史、执行树和协作式取消。长期方向是 Workflow 驱动的 AI 内容生产平台；素材库、图片 / 配音 / 视频生产、Timeline、全局 Agent 和作品交付尚未形成产品能力。

## 快速开始

需要 Node.js 24、pnpm 10.7、Docker Compose。

```sh
pnpm install
pnpm env:init
pnpm infra:up
pnpm db:generate
pnpm db:migrate
pnpm auth:bootstrap
pnpm dev
```

Web：http://localhost:3000。健康检查：http://localhost:3001/api/v1/health。使用 `.env` 的 ADMIN_EMAIL / ADMIN_PASSWORD 登录；公开注册关闭，不要提交环境文件或真实凭证。

完整容器部署使用 `pnpm stack:up`。数据库从 Foundation v1 baseline 初始化，正式部署后的变化采用 append-only migration。配置、备份和迁移见[部署](docs/deployment.md)，本机重置规则见[开发](docs/development.md#数据库开发)。

## 验证

```sh
pnpm check
pnpm test:integration
```

check 运行 lint、typecheck、默认测试和 build。integration 使用隔离数据库、随机队列前缀、独立存储桶、HTTP 和独立 Worker，不调用真实 AI。专项迁移、存储、浏览器和真实模型测试见[开发指南](docs/development.md#测试策略)。

## 文档导航

| 文档                           | 职责                                              |
| ------------------------------ | ------------------------------------------------- |
| [产品](docs/product.md)        | 当前用户路径、产品边界与设计方向                  |
| [架构](docs/architecture.md)   | 应用 / 包分层、技术责任和业务解耦                 |
| [Workflow](docs/workflow.md)   | 定义、版本、节点、Catalog、编译和组合准入         |
| [Execution](docs/execution.md) | 运行身份、checkpoint、审核、取消和运行观测        |
| [数据](docs/data.md)           | 类型、运行值、Artifact / Asset 边界及内容生命周期 |
| [前端](docs/frontend.md)       | Canvas、Inspector、下钻、运行工作区与交互规范     |
| [安全](docs/security.md)       | 登录、会话、权限、凭证和账号开通                  |
| [开发](docs/development.md)    | 编码规范、命令、测试策略和数据库开发              |
| [部署](docs/deployment.md)     | 基础设施、环境、迁移部署、备份与排障              |

开发协作约束见 [AGENTS.md](AGENTS.md)。接口字段以 `packages/contracts`、Prisma schema 和 Controller 为准。
