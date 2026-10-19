# @dramaflow/contracts

平台共享协议，提供身份、用户资料、会话摘要、基础项目及 Workflow / Node Schema。不依赖 React Flow、NestJS、Prisma 或 LangGraph，第三方类型在适配层转换。

Workflow 提供元数据、版本 / 运行元数据、六种运行状态、契约名称及输出来源校验。时间使用 ISO 字符串；运行元数据不包含输入输出值。Run / NodeRun 状态是未来的业务投影，不驱动另一套调度器。

NodeDefinition 与 Preset 使用命名空间 type 和必填正整数 typeVersion；实例布局在 ui.position，拒绝旧顶层 position。inputs 仍是 InputBinding 数组，来源为 nodeId / outputKey，同一目标端口禁止重复绑定。配置和运行值必须为 JSON，错误使用 code / message；NodeRun 只定义记录结构，不处理调度或权限。

`data-type.ts` 提供可序列化 DataType：string、number、boolean、image、video、audio、domain 与递归 array。它不等于 Zod，不定义媒体或领域资产的运行值结构。结构兼容判断由 workflow 包提供，不是完整图校验。

`node-type.ts` 提供 NodeTypeDeclaration：type、version、metadata、inputs、outputs、可选 capabilities 和 ui。端口 key 按方向唯一，capabilities 仅保存不重复的稳定能力类型。metadata 使用 name、可选 description、category、可选 icon；ui 分开声明 inputs / config 控件，不保留旧 displayName 或 ui.fields。

required / defaultValue / multiple 当前仅静态声明，默认值只检查 JSON 形状；不自动注入输入默认值，不开放多来源或多连接。InputValue、固定值、Workflow Input、Asset 和变量来源尚未定义。UI 输入键必须引用已声明端口，配置字段引用由服务端 configSchema 核对。

NodeTypeManifest 在静态声明上仅增加配置 JSON Schema，不携带输入输出 Zod、服务端 configSchema 实例、compile、模型或密钥。服务端 NodeTypeDefinition 与 manifest 转换在 workflow 包；此包不生成表单、不解析能力或调用节点。

createWorkflowSchemas({ dataType, node, edge }) 要求显式传入三个 Schema，可组合当前 dataTypeSchema、nodeDefinitionSchema、edgeDefinitionSchema。已检查额外字段、名称和节点 ID 重复、输出来源节点存在；边引用、输出键、映射一致性、类型兼容和联合无环仍待接入，不构成完整发布校验。

项目保存协议仍只有基础元数据与视口，不接收 WorkflowDefinition；revision 只用于并发保存，不等于 WorkflowVersion 或节点 typeVersion。

模型见 [Workflow 模型](../../docs/workflow-model.md)、[Node 模型](../../docs/node-model.md) 与 [NodeType 实施说明](../../docs/node-type-implementation.md)，实际范围见 [当前架构](../../docs/architecture.md)，下一步见 [实施方案](../../docs/implementation-plan.md)。Schema 复用 [Zod 官方实现](https://zod.dev/api)。
