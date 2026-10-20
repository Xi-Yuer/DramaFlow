# api

NestJS API 应用，提供认证、用户资料、项目管理和节点目录。workflow/workflows 的 WorkflowService 提供绑定 expectedRevision 的草稿更新与并发安全发布，同修订只产生一个完整版本。workflow/node-runs、workflow/workflow-runs 提供有权限作用域的运行 Repository 工厂；workflow/workflow-versions 提供只读版本 Repository，读取完整快照并重新检查所有者 / 项目权限，不读取 draft / latest。没有发布、草稿编辑或运行 HTTP 入口。数据库、Redis、对象存储与凭证加密来自 `@dramaflow/server`。已实现能力和模块职责见 [当前架构](../../docs/architecture.md)。

InfrastructureModule 在应用启动期间初始化官方 PostgreSQL Checkpointer，健康接口检查其真实读取路径；生产 Runner 的依赖装配与运行 HTTP 入口仍未建立。持久化恢复已有独立进程集成测试，不代表人工审核产品已实现。

启动与检查见 [根 README](../../README.md) 和 [开发指南](../../docs/development.md)，当前阶段与后续实施范围见 [分步设计与实施方案](../../docs/implementation-plan.md)。
