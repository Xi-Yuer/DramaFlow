# @dramaflow/contracts

共享的纯 JSON 业务协议及边界校验。沿用当前目录，不依赖 React Flow、NestJS、Prisma 或 LangGraph；Zod 校验器本身不进入 Manifest、工作流定义或 API 数据。

- NodeTypeManifest：type、version、metadata、输入输出端口、config 字段数组、可选 capabilities / ui。category 固定八类；配置字段为 string / number / boolean / select，校验默认值、数值范围、选项及 key 唯一性，不导出 Zod 或 JSON Schema。
- DataType：any、string、number、boolean、json、image、video、audio、file、domain 与递归 array，只描述静态类型，不校验真实媒体或读取资产。
- NodeDefinition：固定 type / typeVersion，inputs 为安全端口键到四类 Binding 的 record，config 仅 JSON，ui.position 必填。可选 preset 仅为配置模板元数据。
- InputBinding：connection、constant、workflow_input、asset；常量只接受 JSON，资产只保存 assetId，没有读取或版本解析。
- ControlEdgeDefinition：id、sourceNodeId、targetNodeId。Workflow.edges 只保存节点级控制关系，数据边从 Node.inputs 派生，不存两份数据真相。条件路由端口尚未进入控制边。
- WorkflowRun 元数据：必填独立 threadId，可与运行 id 不同，不在解析时推断默认值。
- NodeRun：必填正整数 attempt，可选 inputSnapshot / outputSnapshot（JSON 记录）、ISO 时间、明确状态和结构化错误；尚未取得值时不要求伪造空快照。契约不分配 attempt、不提供数据库 Store 或第二套图调度器。

createWorkflowSchemas({ dataType, node, edge }) 继续显式接受具体 Schema，保留通用组合能力。正式 workflowDefinitionSchema 使用当前 DataType、Node 和 ControlEdge 组合，保留顶层 inputs / nodes / edges / outputs，并检查节点与输入引用、控制边 ID 唯一、自连接及联合 DAG。

静态校验不判断 Manifest 端口或 outputKey 是否存在，不检查类型兼容、资源权限，不解析 Binding 或查询资产。React Flow 连线辅助函数另外接收目录并检查端口与静态类型。Node.inputs 是唯一数据绑定来源，一个端口一条绑定，表达式等其他来源没有开放。

项目保存协议仍仅含名称、视口及 revision，未接入 WorkflowDefinition。类型版本、工作流不可变版本和项目并发修订分别承担不同职责。

JSON 校验不限制 base64 字符串或大型文本，也不承担脱敏；RuntimeValue、版本化 Reference、最终 WorkflowState 与运行持久化尚未实现，边界见 [WorkflowState](../../docs/workflow-state.md)。

领域规则见 [Workflow](../../docs/workflow-model.md)、[Node](../../docs/node-model.md) 和 [Manifest](../../docs/node-type-implementation.md)，实际能力见 [当前架构](../../docs/architecture.md)，下一步见 [实施方案](../../docs/implementation-plan.md)。
