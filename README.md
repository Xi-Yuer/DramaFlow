# DramaFlow

面向团队自部署的 AI 视频生产工作流平台，漫剧优先。React Flow 提供编辑器，LangGraph 执行图，受信任插件接入外部能力。

当前能力与限制见[当前架构](docs/architecture.md)，阶段与待决策项见[实施方案](docs/implementation-plan.md)。开始任务先读 [AGENTS.md](AGENTS.md)，再按问题选读专题，无需通读 docs。

## 启动

需要 Node.js 24 LTS、pnpm 10.7、Docker Compose。

```sh
pnpm install
pnpm env:init
pnpm infra:up
pnpm db:generate
pnpm db:migrate
pnpm auth:bootstrap
pnpm dev
```

前端为 http://localhost:3000，API 健康检查为 http://localhost:3001/api/v1/health。初始管理员读取本机 `.env` 的 ADMIN_EMAIL / ADMIN_PASSWORD；公开注册关闭。PostgreSQL、Redis、RustFS 使用默认端口 5432 / 6379 / 9000 / 9001。禁止提交本地环境文件或真实凭证。

## 常用入口

| 任务                     | 入口                                                                                           |
| ------------------------ | ---------------------------------------------------------------------------------------------- |
| 了解产品边界             | [平台模型](docs/platform-model.md)                                                             |
| 查当前能力、接口和目录   | [当前架构](docs/architecture.md)                                                               |
| 修改工作流、节点或数据   | [Workflow](docs/workflow-model.md)、[Node](docs/node-model.md)、[数据模型](docs/data-model.md) |
| 修改执行和恢复           | [Runtime](docs/runtime-architecture.md)                                                        |
| 开发检查与文档维护       | [开发指南](docs/development.md)                                                                |
| 部署、模型配置与数据操作 | [部署](docs/deployment.md)、[认证](docs/authentication.md)、[对象存储](docs/object-storage.md) |
| 界面实现                 | [前端规范](docs/frontend-ui.md)                                                                |

`pnpm check` 执行 lint、typecheck、单元测试和 build；真实基础设施测试使用 `pnpm test:integration` / `pnpm test:storage`。`pnpm stack:up` 构建并启动完整容器环境。验证范围与安全边界见开发指南。

`experiments/` 保存隔离技术证据，不进入生产镜像，也不作为日常任务的默认阅读材料。
