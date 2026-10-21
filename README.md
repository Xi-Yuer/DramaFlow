# DramaFlow

DramaFlow 定位为**面向 AI 视频内容生产的可编排工作流平台，以漫剧生产为核心场景，同时支持广告、产品宣传、口播等视频生产流程**，面向团队自部署。

当前已有登录、平台鉴权、账户中心、项目管理与 React Flow 画布。每项目一张画布，保存名称、视口及 revision，按所有者隔离。画布已查询节点目录、注册通用 renderer，并接入 Data / Control Edge 连线、重连与删除事件。生产目录提供正式文本生成节点 `ai.text_generate@1`；画布仍无添加节点、Workflow 保存 / 发布、模型配置或运行交互。

Workflow 草稿、完整不可变版本、WorkflowRun / NodeRun 均已持久化。新项目原子创建默认 Workflow，已有项目可通过受鉴权 HTTP 显式初始化、读取和保存草稿；Workflow revision 与 Project revision 独立，保存不发布、不执行，Web 尚未接入。已有正式发布、版本列表与完整版本读取 HTTP；发布绑定明确修订，严格校验当前 Action DAG 的节点、端口、输入输出和本地模型配置，不执行外部能力。受鉴权保护的 Run start / get / resume HTTP 经 PostgreSQL Outbox、BullMQ 和独立 Worker 执行，原 thread 通过官方 PostgreSQL Checkpointer 恢复；结果不明的执行停在 recovery_required，不自动重跑业务。Artifact metadata 保存 PostgreSQL，JSON / 二进制内容写入 RustFS，State 与历史只保存引用；Asset 内容仍未配置。

正式文本节点通过受信任的 PluginRegistry / Capability 调用模型，Workflow 只引用项目内的模型配置 ID。Provider 实例明确指定插件版本、endpoint 与加密凭证，ModelConfiguration 固定 capability、模型名及参数；已有 OpenAI-compatible 文本参考插件，没有默认厂商或模型。模型配置暂由服务端工具管理，无配置 HTTP / UI；独立 Worker 复用既有 Binding、Codec、NodeRun 与最终输出管线。测试与真实外部调用的验证范围见 [当前架构](docs/architecture.md#文本-ai-与-provider-plugin)。

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

前端 http://localhost:3000 未登录时进入登录页。初始管理员邮箱与密码查看本机 .env 的 ADMIN_EMAIL / ADMIN_PASSWORD，公开注册关闭。API http://localhost:3001/api/v1/health 检查真实基础设施；独立 worker 消费 Workflow 执行命令并重投待发布 Outbox。账号资料、密码和会话操作见 [认证实施说明](docs/authentication.md)。

基础设施默认端口保持 **5432 / 6379 / 9000 / 9001**，仅绑定宿主 127.0.0.1。RustFS 控制台为 http://localhost:9001/rustfs/console/，凭证位于本机 `.env` 的 `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY`，不要提交该文件。

## 保留的结构

| 目录               | 当前内容                                                                 |
| ------------------ | ------------------------------------------------------------------------ |
| apps/web           | 身份与项目画布、目录查询、通用节点 renderer 和协议适配                   |
| apps/api           | NestJS、身份 / 项目 / 节点目录 API 与 Runtime Service                    |
| apps/worker        | 独立 NestJS 应用、Outbox Pump、执行 Consumer 与正式文本 AI 执行          |
| packages/database  | Prisma、身份、项目、Workflow / Run、Artifact 与模型配置、pgvector        |
| packages/server    | API 与 worker 共用的数据库、持久 Checkpointer、Redis、对象存储和凭证加密 |
| packages/contracts | 身份、项目、Workflow / Node、DataType 及静态类型声明                     |
| packages/workflow  | 值契约、类型 / 节点 Registry、运行接口和 action 编译包装                 |
| packages/plugins   | 受信任 PluginRegistry、Capability 契约与 OpenAI-compatible 文本适配      |
| packages/context   | 上下文包空入口，待逐步定义                                               |

上述目录是当前工程结构，不为每个一级概念预建独立包。contracts 按 identity / project 协议与 workflow / node 分组，workflow 按 definition / data / node / runtime / compiler / run 分组；server 承载服务端基础设施与共享装配适配。具体职责见 [架构与目录职责](docs/architecture.md)。

## 检查与部署

```sh
pnpm check
pnpm test:storage
pnpm test:integration
pnpm stack:up
```

`test` 运行现有单元测试，包括 Workflow / Node 契约、manifest、React Flow 转换、真实 LangGraph 编译适配及文本插件协议；`test:storage` 使用真实 RustFS 随机测试桶；`test:integration` 使用独立 dramaflow_test 数据库验证业务持久化、跨进程恢复、执行队列、Artifact 与正式文本节点，不清空业务库。本机模型协议服务只验证适配和失败边界，不代表真实外部模型质量。持久化恢复测试的原生中断图不代表 Human Review 产品能力。实际验证结果与适用范围见 [当前架构](docs/architecture.md#文本-ai-与-provider-plugin)及[开发指南](docs/development.md)。

`model:configure` 从服务器配置文件和显式凭证环境变量创建模型配置，不调用模型。`test:ai:live` 在明确指定 endpoint、模型名和凭证变量后执行真实模型链验收；默认单元与集成测试不会启用它。用法见 [Provider 配置](docs/deployment.md#文本模型-provider-配置)和[开发指南](docs/development.md)。

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
