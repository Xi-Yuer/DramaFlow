# DramaFlow

以漫剧创作为主要场景的团队工作流平台。用户组合平台注册节点，在生成节点明确选择模型插件、模型与凭证；人工确认、分支和批量执行由运行时处理。节点对话与工作流全局对话帮助理解和调整流程，所有修改先形成建议，再由用户确认。

## 开始开发

需要 Node.js **24 LTS**、pnpm **10.7**、Docker Compose。可先执行 `nvm use`。PostgreSQL/pgvector 与 Redis 保持默认端口 **5432 / 6379**，RustFS 使用 **9000 / 9001**，请先关闭占用这些端口的其他服务。

```sh
pnpm install
pnpm env:init
pnpm infra:up
pnpm db:generate
pnpm db:migrate
pnpm bootstrap-admin
pnpm dev
```

访问 http://localhost:3000 。`env:init` 在 `.env` 不存在时生成随机密钥和管理员密码，已有文件只补齐缺少的 RustFS 配置；邮箱默认 `admin@dramaflow.local`，密码查看本机 `.env` 的 `ADMIN_PASSWORD`。公开注册关闭。请保管该文件，不要提交到 Git。

根任务会加载根目录 `.env`。API 默认 3001，前端通过同源 `/api/v1` 和 `/api/auth` 代理访问。不要把模型密钥写入 `NEXT_PUBLIC_*`。

## 一键部署

```sh
pnpm env:init
pnpm stack:up
```

此命令构建应用镜像，启动数据库、Redis 和 RustFS，创建素材桶，执行迁移和管理员初始化，再依次启动 API、worker、前端。数据库包含 pgvector；向量能力不依赖单独的数据库。首次构建需要下载镜像和依赖。

部署到其他域名前，修改 `.env` 中 `BETTER_AUTH_URL` 和 `WEB_ORIGIN`，通过反向代理配置 HTTPS。详细说明见 [部署与备份](docs/deployment.md)。

## 第一条真实工作流

1. 登录，在插件面板启用所需插件，创建带凭证的模型连接。
2. 创建工作流，添加文本生成节点；手动选择插件、连接和模型，填写需求。
3. 用执行端口连接输入、文本生成、人工确认、结果收集；用数据绑定指定各节点的输入来源。
4. 保存、校验、发布，填写本次输入并运行；在人工任务中查看或修改结果，再批准继续。
5. 查看节点执行记录、收集结果和素材。图片节点与文本节点采用同样的插件选择机制。

平台不内置供应商密钥，也不会自动选择厂商。参考插件包含 OpenAI 文本/图片和兼容文本服务；不推断兼容服务具有图片或视频能力。视频节点在没有相应插件时明确不可用。真实供应商联调需要你自己的有效服务配置。

## 工程结构

| 模块                 | 职责                                                        |
| -------------------- | ----------------------------------------------------------- |
| `apps/web`           | Next.js 中文工作台、React Flow 编辑器、双会话               |
| `apps/api`           | NestJS HTTP API、权限、领域服务和可被 worker 复用的执行宿主 |
| `apps/worker`        | 独立 NestJS 进程，消费唤醒任务并驱动 LangGraph              |
| `packages/contracts` | 与第三方框架无关的平台协议和边界校验                        |
| `packages/workflow`  | 节点目录、图验证、运行语义与 LangGraph 适配                 |
| `packages/plugins`   | 安全 manifest、受信任插件注册和供应商实现                   |
| `packages/context`   | 上下文构建、预算、来源清单和安全建议操作                    |
| `packages/database`  | Prisma、迁移、数据库工厂和管理员初始化                      |

## 参与开发

先读 [AGENTS.md](AGENTS.md)，再按 [开发参与指南](docs/development.md) 走完一次调用。这里的文档解释领域边界和运行语义，帮助你参与设计与实现。

- [架构与关键决策](docs/architecture.md)
- [工作流数据流与执行语义](docs/workflow-runtime.md)
- [上下文构建与双会话](docs/context-engineering.md)
- [新增节点与模型插件](docs/extensions.md)
- [API 与权限边界](docs/api.md)
- [部署、迁移与备份](docs/deployment.md)
- [RustFS 对象存储与历史素材迁移](docs/object-storage.md)
- [验证方式与限制](docs/verification.md)

```sh
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

`pnpm check` 顺序执行以上检查。模型测试使用本地 HTTP 契约服务，不会读取真实供应商密钥或产生付费调用；不能据此声称外部模型联调已通过。
