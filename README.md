# DramaFlow

DramaFlow 定位为**面向 AI 视频内容生产的可编排工作流平台，以漫剧生产为核心场景，同时支持广告、产品宣传、口播等视频生产流程**，面向团队自部署。

当前已有登录、平台鉴权、账户中心、项目管理与 React Flow 画布。每项目一张画布，保存名称、视口及 revision，按所有者隔离。画布已查询节点目录、注册通用 renderer，并接入 Data / Control Edge 连线、重连与删除事件；生产目录为空，没有添加节点、Workflow 持久化、工作流运行或模型调用。

基础库包含正式 DataType 与共享兼容规则、RuntimeValue、版本化引用、Artifact / Asset 协议、数据与节点 Registry，以及编译、输入解析、Decode 与普通 Action 业务主干。引用解析、输出编码和内容 / 审计仍是接口，尚无完整生产管线，见 [数据模型](docs/data-model.md) 与 [当前架构](docs/architecture.md)。

[平台核心模型](docs/platform-model.md) 定义顶层职责：Workflow 与 Node 构成编排骨架，Tool、Plugin、Middleware、Asset 和 Agent 围绕它们服务，领域节点与模板承载漫剧等生产语义。当前阶段与下一步统一见 [分步设计与实施方案](docs/implementation-plan.md)；规划不代表功能已经交付。

可视化编辑器使用 React Flow，平台 WorkflowDefinition 经 Compiler 转换为 LangGraph StateGraph。LangGraph 是核心 Graph Runtime，LangChain 负责模型、Tool 和 Agent 抽象，平台实现领域协议与编译适配；技术分工见 [Runtime 架构](docs/runtime-architecture.md)。

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
| apps/web           | 身份与项目画布、目录查询、通用节点 renderer 和协议适配   |
| apps/api           | NestJS、Better Auth、资料、项目与受保护节点目录 API      |
| apps/worker        | 独立 NestJS 应用上下文，尚未注册业务任务                 |
| packages/database  | Prisma、身份/资料/凭证/会话及基础项目模型、pgvector      |
| packages/server    | API 与 worker 共用的数据库、Redis、对象存储和凭证加密    |
| packages/contracts | 身份、项目、Workflow / Node、DataType 及静态类型声明     |
| packages/workflow  | 值契约、类型 / 节点 Registry、运行接口和 action 编译包装 |
| packages/plugins   | 插件包空入口，保留模型 SDK 依赖                          |
| packages/context   | 上下文包空入口，待逐步定义                               |

上述目录是当前工程结构，不为每个一级概念预建独立包。contracts 按 identity / project 协议与 workflow / node 分组，workflow 按 definition / data / node / runtime / compiler / run 分组；server 只承载服务端基础设施。具体职责见 [架构与目录职责](docs/architecture.md)。

## 检查与部署

```sh
pnpm check
pnpm test:storage
pnpm test:integration
pnpm stack:up
```

`test` 运行现有单元测试，包括 Workflow / Node 契约、manifest、React Flow 转换与真实 LangGraph 编译适配；`test:storage` 使用真实 RustFS 随机测试桶；`test:integration` 使用独立 dramaflow_test 数据库验证认证、会话、角色、来源校验、项目隔离、分页与修订冲突和基础设施，不清空业务库。检查的适用范围见 [开发指南](docs/development.md)。测试中的图执行不代表完整工作流产品可运行；生产 checkpointer、运行接口和真实模型调用尚未接入。

`stack:up` 构建镜像，启动基础设施、初始化存储桶、迁移和初始管理员，再启动 API、worker 和前端。已有数据卷不会因更新代码而自动删除。

数据库迁移、部署与数据操作边界见 [部署与数据库](docs/deployment.md)。文档随实施更新，过时内容及时合并或删除，维护约定见 [开发指南](docs/development.md#文档维护)。

## 参与开发

- [协作规范](AGENTS.md)
- [平台核心模型](docs/platform-model.md)
- [Workflow 模型](docs/workflow-model.md)
- [数据类型与运行值](docs/data-model.md)
- [WorkflowState 边界](docs/workflow-state.md)
- [Node 模型](docs/node-model.md)
- [节点类型实施拆解](docs/node-type-implementation.md)
- [Runtime 架构与技术分工](docs/runtime-architecture.md)
- [分步设计与实施方案](docs/implementation-plan.md)
- [当前架构与目录职责](docs/architecture.md)
- [认证实施与用户字段](docs/authentication.md)
- [开发指南](docs/development.md)
- [部署与数据库](docs/deployment.md)
- [RustFS 存储](docs/object-storage.md)
- [前端基础](docs/frontend-ui.md)
