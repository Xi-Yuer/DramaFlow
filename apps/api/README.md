# api

NestJS API 应用，提供认证、用户资料、项目管理、默认 Workflow 编辑和节点目录。新建项目原子创建空草稿 Workflow；workflow/workflows 提供项目默认 Workflow 的显式幂等初始化、读取与按 Workflow ID 保存草稿 HTTP，保存使用独立 expectedRevision。WorkflowService 提供正式发布、版本列表与完整版本读取 HTTP；发布按正式 Registry / Node Schema / DataType 及本地模型配置严格校验，同修订只产生一个完整版本，失败不写版本，不执行外部模型。packages/server/workflow 提供有权限作用域的运行 Repository 工厂与只读版本 Repository，读取完整快照并重新检查所有者 / 项目权限，不读取 draft / latest。已有受鉴权保护的 Run start / get / resume HTTP。数据库、Redis、对象存储与凭证加密来自 `@dramaflow/server`。接口及边界见 [Workflow 编辑 HTTP](../../docs/architecture.md#workflow-编辑-http-api)与[发布 / 版本 HTTP](../../docs/architecture.md#workflow-发布与版本-http-api)。

InfrastructureModule 在应用启动期间初始化官方 PostgreSQL Checkpointer，健康接口检查其真实读取路径。workflow/runtime 仅引入提交与 Queue 模块，不装配 Runner / ExecutionService。Controller 委托 startVersion / getRun / resumeRun；Service 校验所有者、派生身份、事务写 Run / Outbox 后确认 enqueue，start / resume 成功返回 202，GET 查询状态。队列不可用返回安全 503，Outbox 保留等待 Worker 重投；此时请求结果仍可能执行，不应盲目创建新 Run。Run DTO 不公开 threadId / executionId；API 不执行 Graph。

启动与检查见 [根 README](../../README.md) 和 [开发指南](../../docs/development.md)，当前阶段与后续实施范围见 [分步设计与实施方案](../../docs/implementation-plan.md)。

`models/` 提供受鉴权的插件安全目录与项目级 Provider / Model Configuration 管理，创建体的项目身份来自路径。支持安全列表 / 详情、创建、独立启停和凭证完整轮换；不提供删除或覆盖不可变绑定。协议、路径及错误 / Secret 边界见[管理 HTTP](../../docs/architecture.md#plugin--provider--模型配置管理-http)。没有模型配置 Web 或新节点配置 UI。
