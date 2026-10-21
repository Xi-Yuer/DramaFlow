# @dramaflow/contracts

共享 JSON 协议与边界校验，不依赖 React Flow、NestJS、Prisma 或 LangGraph。

- identity / project：身份与基础项目协议，列表游标和保存 revision 不等于工作流发布版本。
- workflow / node：显式定义、不可变版本、运行记录与最小 WorkflowExecutionJob 契约；workflow-api 提供默认 Workflow 初始化空请求、含独立 revision 的读取响应，以及 expectedRevision / definition 草稿保存请求；发布仅接受 expectedRevision，版本响应包含来源修订与完整快照，列表返回有界分页摘要。edges 是节点间连接唯一来源，Data Edge 表达值来源，Control Edge 表达显式执行先后。实例 inputs 只保存 constant / workflow_input / asset 三类 StaticInputBinding。Manifest 含 executionKind，资产绑定固定 assetId / versionId。
- data：正式 DataType、共享 isTypeAssignable、builtin 常量、DataTypeManifest、RuntimeValue 和 DataReference。
- content：Artifact、版本化 Asset、来源与内容位置协议；不实现数据库、上传、Promote 或授权读取。

DataType 使用 primitive / named / array.itemType / object / union / any；RuntimeValue 只区分 inline / reference。共享 Schema 只校验结构与 JSON，不代替实际 Zod、大小预算、权限或存储策略。

Manifest 不携带可执行 Zod、execute 或服务端实例。WorkflowEdge 是 DataEdgeDefinition | ControlEdgeDefinition；正式 Schema 检查两类边全局 ID、节点引用、自连接与联合 DAG，只对数据边检查目标单连接和静态 Binding 冲突，不查询 Manifest。控制端口可省略，不占用输入值，也不预设多上游 Join。项目保存仍只有名称、视口和 revision。

规则见 [数据模型](../../docs/data-model.md)、[Node](../../docs/node-model.md)、[Workflow](../../docs/workflow-model.md)，现状与下一步见 [架构](../../docs/architecture.md) 和 [实施方案](../../docs/implementation-plan.md)。
