# web

保留登录、账户中心、分页项目列表与 React Flow 空白画布。每个项目一张画布，支持项目名称、缩放、平移与基于 revision 的保存。项目按所有者隔离。

画布以本地 WorkflowDefinition 派生视图，支持 Data / Control Edge 的转换与连线、重连、删除事件，两类 Handle 分开校验。生产节点目录仍为空，没有节点添加或 Workflow 持久化。项目协议仅含基础元数据与视口，不含节点、连线或插件配置。业务实施状态与目录职责见 [当前架构](../../docs/architecture.md)，后续进度见 [分步设计与实施方案](../../docs/implementation-plan.md)。

启动与检查见 [根 README](../../README.md) 和 [开发指南](../../docs/development.md)。
