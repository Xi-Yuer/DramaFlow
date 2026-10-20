# worker

独立 NestJS 应用上下文，通过 `@dramaflow/server` 接入基础设施，启动期间初始化应用级官方 PostgreSQL Checkpointer，并验证数据库、checkpoint、Redis 与对象存储可用；关闭时释放连接。与 API 使用相同 DATABASE_URL 的 langgraph schema，workflow/runtime 的应用 Service 接收 WorkflowExecutionJob，委托共享 WorkflowExecutionService 按已有 Run ID 执行。executeStart 不创建 Run，executeResume 在实际执行端原子 claim；项目、所有者、固定版本和原 thread 均从数据库读取。API 提交与 Worker 执行同一 pending Run 已经正式 Nest 集成验证；仍未注册或消费业务任务。执行进程的职责边界见 [当前架构](../../docs/architecture.md)。

启动与检查见 [根 README](../../README.md) 和 [开发指南](../../docs/development.md)，当前阶段与后续实施范围见 [分步设计与实施方案](../../docs/implementation-plan.md)。
