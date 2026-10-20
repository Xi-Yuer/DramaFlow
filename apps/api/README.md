# api

NestJS API 应用，提供认证、用户资料、项目管理和节点目录。workflow/node-runs 提供限定所有者、项目和运行的 NodeRunRepository 工厂，不增加运行 HTTP 入口。数据库、Redis、对象存储与凭证加密来自 `@dramaflow/server`。已实现能力和模块职责见 [当前架构](../../docs/architecture.md)。

启动与检查见 [根 README](../../README.md) 和 [开发指南](../../docs/development.md)，当前阶段与后续实施范围见 [分步设计与实施方案](../../docs/implementation-plan.md)。
