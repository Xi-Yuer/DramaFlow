# @dramaflow/contracts

共享 JSON 协议与边界校验，不依赖 React Flow、NestJS、Prisma 或 LangGraph。

- identity / project：身份与基础项目协议，列表游标和保存 revision 不等于工作流发布版本。
- workflow / node：显式定义、不可变版本与运行记录契约；Manifest 含 executionKind，实例 inputs 是数据绑定真相。资产绑定固定 assetId / versionId。
- data：正式 DataType、共享 isTypeAssignable、builtin 常量、DataTypeManifest、RuntimeValue 和 DataReference。
- content：Artifact、版本化 Asset、来源与内容位置协议；不实现数据库、上传、Promote 或授权读取。

DataType 使用 primitive / named / array.itemType / object / union / any；RuntimeValue 只区分 inline / reference。共享 Schema 只校验结构与 JSON，不代替实际 Zod、大小预算、权限或存储策略。

Manifest 不携带可执行 Zod、execute 或服务端实例。ControlEdge 仍为待下一步 Graph Model 核定的最小草案。项目保存仍只有名称、视口和 revision。

规则见 [数据模型](../../docs/data-model.md)、[Node](../../docs/node-model.md)、[Workflow](../../docs/workflow-model.md)，现状与下一步见 [架构](../../docs/architecture.md) 和 [实施方案](../../docs/implementation-plan.md)。
