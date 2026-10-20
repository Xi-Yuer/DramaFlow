# api

NestJS API 应用，提供认证、用户资料、项目管理和节点目录。workflow/workflows 的 WorkflowService 提供绑定 expectedRevision 的草稿更新与并发安全发布，同修订只产生一个完整版本。packages/server/workflow 提供有权限作用域的运行 Repository 工厂与只读版本 Repository，读取完整快照并重新检查所有者 / 项目权限，不读取 draft / latest。已有受鉴权保护的 Run start / get / resume HTTP；没有发布或草稿编辑 HTTP。数据库、Redis、对象存储与凭证加密来自 `@dramaflow/server`。已实现能力和模块职责见 [当前架构](../../docs/architecture.md)。

InfrastructureModule 在应用启动期间初始化官方 PostgreSQL Checkpointer，健康接口检查其真实读取路径。workflow/runtime 仅引入提交与 Queue 模块，不装配 Runner / ExecutionService。Controller 委托 startVersion / getRun / resumeRun；Service 校验所有者、派生身份、事务写 Run / Outbox 后确认 enqueue，start / resume 成功返回 202，GET 查询状态。队列不可用返回安全 503，Outbox 保留等待 Worker 重投；此时请求结果仍可能执行，不应盲目创建新 Run。Run DTO 不公开 threadId / executionId；API 不执行 Graph。

启动与检查见 [根 README](../../README.md) 和 [开发指南](../../docs/development.md)，当前阶段与后续实施范围见 [分步设计与实施方案](../../docs/implementation-plan.md)。
