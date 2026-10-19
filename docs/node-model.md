# Node 模型

NodeDefinition 是流程实例，NodeTypeManifest 是可传输说明书，服务端 NodeType 是业务执行实现。React Flow 视图、平台定义、LangGraph 执行与 NodeRun 记录各有边界，数据语义见 [数据模型](data-model.md)。

## 实例与编辑视图

NodeDefinition 固定 id、type、typeVersion、name、config、inputs 及 ui.position；preset 仅是配置模板元数据。Node.inputs record 是数据绑定唯一来源，每个输入对应一条 connection / constant / workflow_input / asset。asset 明确 assetId + versionId，不选择最新版本。

React Flow type 选择 workflowNode renderer，实际运行类型在 data.nodeType / data.typeVersion。selected、dragging、measured 等临时字段不进入定义。数据边从 connection 派生；显式连接对照唯一目录检查精确版本、端口与共享类型兼容规则，断连检查完整旧快照以防误删新绑定。

ControlEdge 当前保留最小节点级关系，与数据绑定分离。该形状仍是待下一步 Graph Model 核定的草案，不视为已发布的最终条件路由协议，不提前增加分支、Join 或执行语义。

## Manifest 与端口

Manifest 的 type / version 固定节点类型身份，executionKind 必填，支持 action、control、composite、interaction。metadata 分类仍是 input / ai / image / video / audio / flow / data / output。说明书只含 JSON，不包含 Zod、execute、编译器或私有服务依赖。

端口使用正式 DataType，key 与 Handle.id 对应，同方向唯一。required 表示是否可以不提供输入；null 由 union 描述。一个端口一条绑定，集合用 array.itemType，不声明 multiple。

config 为 string / number / boolean / select 字段数组；默认值按字段类型、范围与选项校验。配置控件提示在 config[].ui，输入提示在 ui.inputs；Zod 与 UI 编辑提示不混用，默认值不自动注入定义或 State。

## 服务端执行与编译

NodeType 持 manifest、inputSchema、configSchema、outputSchema 和 execute(input, config, context)，不再提供 compile。NodeRegistry 按 type / version 精确查找，拒绝重复或缺失版本，listManifests 只返回副本；普通 action 必须提供 execute，其他 executionKind 仅声明契约，由独立结构策略处理。

assertNodeSchemas 核对公开输入、输出、配置字段集合和默认值，不声称已经证明 Manifest 与任意 Zod Schema 完全等价。真实运行须经过数据类型 Registry 与节点完整 Zod 校验。

ActionNodeCompilationStrategy 只生成调用统一 NodeExecutor 的 LangGraph 包装，不执行业务、不解析 Binding、不自行 addEdge。它拒绝不匹配的版本及非 action 类型。WorkflowCompiler / 其他结构策略待 Graph Model 明确后实施，不为每个 LLM、TTS 或图生视频类型创建独立编译策略。

NodeExecutor 的职责与 Codec、Resolver、内容服务和 NodeRunRecorder 端口见 [数据模型](data-model.md)。这些执行服务当前只有接口；普通节点只知道业务输入、配置和调用上下文，不知道上下游、存储实现或 Checkpoint。

## Preset 与 NodeRun

Preset 是所属 type / typeVersion 的配置模板，不是 Runtime 身份。applyNodePreset 检查归属、合并模板与实例覆盖，不执行节点。剧本、广告、口播等可复用机制，不按业务名称复制 Executor。

NodeRun 契约包含 attempt、可选输入输出快照、八种状态、结构化错误和时间。它是业务历史，不驱动调度；运行服务、持久化及投影一致性尚未接入。State 只保存当前有效 RuntimeValue 输出，详细分工见 [WorkflowState](workflow-state.md)。

## 视频领域能力与厂商边界

视频领域类型可以专业化，外部能力通过用户明确选择的受信任插件接入，不将节点与单一供应商绑定。当前没有生产模型节点、插件选择或真实生成能力。
