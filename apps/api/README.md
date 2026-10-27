# api

NestJS HTTP：认证、资料、项目、Workflow 草稿 / 发布 / 版本、Run 提交和模型管理。API 提交运行，不执行图。

`workflow/workflows/workflow.service.ts` 保留草稿和发布事务入口；版本读取在 `versions/`，发布时的图语义、能力绑定及错误映射在 `publish/`。发布校验使用当前事务检查资源，HTTP 路由与服务构造协议保持一致。

API 与 Worker 的格式化统一继承仓库根配置，不再各自覆盖行宽。

接口见 [当前架构](../../docs/architecture.md)。启动与检查见 [根 README](../../README.md) 和 [开发指南](../../docs/development.md)。
