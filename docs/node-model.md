# Node 模型

NodeDefinition 是流程实例，NodeTypeManifest 是可传输说明书，服务端 NodeType 是业务执行实现。React Flow 视图、平台定义、LangGraph 执行与 NodeRun 记录各有边界，数据语义见 [数据模型](data-model.md)。

## 实例与编辑视图

NodeDefinition 固定 id、type、typeVersion、name、config、inputs 及 ui.position；preset 仅是配置模板元数据。Node.inputs record 只保存 StaticInputBinding：constant / workflow_input / asset。上游节点输入只由 WorkflowDefinition.edges 中的 DataEdgeDefinition 表达，不在 inputs 重复保存。asset 明确 assetId + versionId，不选择最新版本。

React Flow type 选择 workflowNode renderer，实际运行类型在 data.nodeType / data.typeVersion。selected、dragging、measured 等临时字段不进入定义。Data / Control Edge 的种类、ID、节点与可选端口可往返 React Flow Edge；显式数据连接对照唯一目录检查精确版本、端口与共享类型兼容规则，控制连接使用独立 Handle。断连和重连检查种类及完整旧边快照，防止过期事件误改现有连接。

Data Edge 声明输入值来源，Control Edge 声明显式执行先后，两者都只保存在 WorkflowDefinition.edges，不自动相互补齐。Control Edge 不占用 Node.inputs；当前两类边均产生确定性执行依赖，相同节点对去重。Dependency Compiler 只读两端 nodeId，数据端口与取值保留给 BindingResolver / NodeExecutor。普通节点对已确定的多个执行上游固定采用 ALL Join，不增加 NodeDefinition.joinMode；ANY / N_OF_M 留给专门控制节点，边界见 [Runtime](runtime-architecture.md#普通确定性依赖的-all-join)。

## Manifest 与端口

Manifest 的 type / version 固定节点类型身份，executionKind 必填，支持 action、control、composite、interaction。metadata 分类仍是 input / ai / image / video / audio / flow / data / output。说明书只含 JSON，不包含 Zod、execute、编译器或私有服务依赖。

数据端口使用正式 DataType，数据 Handle.id 必须等于对应端口 key，同方向唯一。required 表示是否可以不提供输入；null 由 union 描述。一个数据输入端口至多一条 Data Edge，且不能同时保留静态 Binding。集合用 array.itemType；数组值不隐含多连接聚合，不声明 multiple。

普通控制 Handle 使用 `control:source` / `control:target`，与数据端口 key 隔离，默认控制 Handle 不进入领域 portKey。Control Edge 的可选 portKey 支持命名端口往返，但当前 Manifest 不声明命名控制端口，通用节点只提供普通控制出入口，不渲染分支路由。

config 为 string / number / boolean / select 字段数组；默认值按字段类型、范围与选项校验。配置控件提示在 config[].ui，输入提示在 ui.inputs；Zod 与 UI 编辑提示不混用，默认值不自动注入定义或 State。

## 服务端执行与编译

NodeType 持 manifest、inputSchema、configSchema、outputSchema 和 execute(input, config, context)，不再提供 compile。NodeRegistry 按 type / version 精确查找，拒绝重复或缺失版本，listManifests 只返回副本；普通 action 必须提供 execute，其他 executionKind 仅声明契约，由独立结构策略处理。

assertNodeSchemas 核对公开输入、输出、配置字段集合和默认值，不声称已经证明 Manifest 与任意 Zod Schema 完全等价。真实运行须经过数据类型 Registry 与节点完整 Zod 校验。

ActionNodeCompilationStrategy 只包装统一 NodeExecutor，传入当前 State 并将结果映射为当前 nodeId 的 outputs 增量，不展开旧 State；合并与冲突检查由 LangGraph 通道负责。编译不执行业务、不解析 Binding、不自行 addEdge，拒绝不匹配版本或非 action。整图 Compiler 与结构策略保持独立，不为每个业务类型复制编译策略，详见 [State 边界](workflow-state.md#并行与历史)。

普通 Action NodeExecutor 串联精确 Registry、绑定、decode、输入 / 配置校验、业务调用、输出校验和逐端口编码，返回 RuntimeValue map，不按 node.type 分支。NodeExecutionContext 包含领域 workflow / state 与项目运行定位，不含 React Flow 对象；普通节点接收已校验的业务输入和配置，不自行调度或解析绑定。输出存储策略由 Runtime 统一处理，Artifact 写入与内容 / 审计使用独立服务端口，能力见 [架构](architecture.md#数据与-node-基础库)，错误规则见 [Runtime](runtime-architecture.md#action-执行错误阶段)。

## Preset 与 NodeRun

Preset 是所属 type / typeVersion 的配置模板，不是 Runtime 身份。applyNodePreset 检查归属、合并模板与实例覆盖，不执行节点。剧本、广告、口播等可复用机制，不按业务名称复制 Executor。

NodeRun 契约包含 attempt、可选输入输出快照、八种状态、结构化错误和时间。它是业务历史，不驱动调度；运行服务、持久化及投影一致性尚未接入。State 只保存当前有效 RuntimeValue 输出，详细分工见 [WorkflowState](workflow-state.md)。

## 视频领域能力与厂商边界

视频领域类型可以专业化，外部能力通过用户明确选择的受信任插件接入，不将节点与单一供应商绑定。当前没有生产模型节点、插件选择或真实生成能力。
