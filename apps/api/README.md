# api

NestJS API 应用，提供认证、用户资料、项目管理和节点目录。workflow/workflows 的 WorkflowService 提供绑定 expectedRevision 的草稿更新与并发安全发布，同修订只产生一个完整版本。packages/server/workflow 提供有权限作用域的运行 Repository 工厂与只读版本 Repository，读取完整快照并重新检查所有者 / 项目权限，不读取 draft / latest。已有受鉴权保护的 Run start / get / resume HTTP；没有发布或草稿编辑 HTTP。数据库、Redis、对象存储与凭证加密来自 `@dramaflow/server`。已实现能力和模块职责见 [当前架构](../../docs/architecture.md)。

InfrastructureModule 在应用启动期间初始化官方 PostgreSQL Checkpointer，健康接口检查其真实读取路径；workflow/runtime 的应用 Service 通过共享 factory 装配生产 Runner，按显式所有者 / 项目限定权限；Run Controller 仅委托 startVersion / getRun / resumeRun，由 Service 派生身份、先检查资源权限，先调用独立提交服务、再显式把 Job 交给 ExecutionService；Run DTO 不公开 threadId。submitStart 仅创建 pending，submitResume 仅返回恢复意图且不 claim；当前 HTTP 临时同步桥接 ExecutionService，仍 await Graph，后续 Worker / Queue 接入保持同一 HTTP contract。持久化恢复已有独立进程集成测试，不代表人工审核产品已实现。

启动与检查见 [根 README](../../README.md) 和 [开发指南](../../docs/development.md)，当前阶段与后续实施范围见 [分步设计与实施方案](../../docs/implementation-plan.md)。
