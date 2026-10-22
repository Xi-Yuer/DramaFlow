# DramaFlow

团队自部署的 AI 视频生产工作流平台，漫剧优先。React Flow 编辑、LangGraph 执行、受信任插件接入生成能力。

开始任务先读 [AGENTS.md](AGENTS.md) 的按任务入口，不默认通读 docs。当前能力见[架构](docs/architecture.md)，当前工作见[实施方案](docs/implementation-plan.md)，检查见[开发指南](docs/development.md)。

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

Web：http://localhost:3000；API 健康检查：http://localhost:3001/api/v1/health。管理员读取本机 `.env` 的 ADMIN_EMAIL / ADMIN_PASSWORD；公开注册关闭，禁止提交环境文件或凭证。

PostgreSQL / Redis / RustFS 保持默认端口；完整容器启动用 `pnpm stack:up`，环境与数据操作见[部署](docs/deployment.md)。`pnpm check` 执行 lint、typecheck、单元测试和 build；真实基础设施、浏览器及收费模型验收须按开发指南选择。

`experiments/` 仅保留隔离验证结论与复现入口，不进入生产镜像或日常默认上下文；历史细节通过 Git 查询。
