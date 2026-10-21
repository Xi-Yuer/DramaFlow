# web

提供登录、账户中心、分页项目列表与 React Flow 编辑器，项目按所有者隔离。每项目一张画布，从正式 HTTP 读取真实 Workflow Draft；旧项目缺失 Workflow 时明确初始化，不以本地空定义兜底。

WorkflowDefinition 是图内容的唯一来源，React Flow 负责展示和编辑。支持节点位置、Data / Control Edge 连线、重连与删除；完整草稿通过 expectedRevision 保存，刷新后恢复。项目信息（名称 / 视口）单独保存，两个 revision 和冲突处理互不覆盖。保存失败保留本地内容，409 后需明确重新读取对应资源，放弃未保存修改前会确认。

生产目录提供正式文本节点，尚无节点添加 / 配置、模型选择、发布或运行交互。架构与转换边界见 [当前架构](../../docs/architecture.md#web-workflow-draft-持久化)，后续进度见 [实施方案](../../docs/implementation-plan.md)。

启动与检查见 [根 README](../../README.md) 和 [开发指南](../../docs/development.md#web-workflow-浏览器验证)。
