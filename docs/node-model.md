# Node 模型

NodeDefinition 是实例，NodeTypeManifest 是可传输说明书，NodeType 是服务端业务实现。数据承载见[数据模型](data-model.md)，执行与记录见[Runtime](runtime-architecture.md)。

## 实例与编辑视图

实例固定 id、type、typeVersion、name、config、inputs 和 ui.position。inputs 保存 constant、workflow_input、asset、template 和 candidate；asset 固定 assetId + versionId。普通整段上游连接保存在 Workflow.edges，一个目标端口一条数据边。template / candidate 各自是该端口的唯一来源；template 正文用 `{{名称}}` 引用 node_output 或 workflow_input，candidate 保存候选节点输出来源。

React Flow 的 type 选择通用 renderer，真实节点身份保存在 data.nodeType / typeVersion；selected、dragging、measured 不持久化。两类边保留 ID、种类、节点及可选端口；断连 / 重连必须核对完整旧边快照，防止过期事件修改现有连接。

Data Edge 提供输入值来源，Control Edge 提供先后关系，不自动相互创建。数据输入单连接，且不能与静态绑定并存；编辑器在替换已有绑定前要求确认。数组不隐含多连接聚合。template 的 node_output 和 candidate 都是显式数据依赖，Web 从绑定投影连线，不另存为 Data Edge；展示与编辑行为见[当前架构](architecture.md#react-flow-数据适配)。控制边不占输入，边与模板引用按节点对去重，普通 fan-in 采用 [ALL Join](runtime-architecture.md#普通确定性依赖的-all-join)。

## Manifest 与端口

Manifest 固定 type / version 与 executionKind（action / control / composite / interaction）。category 是独立的 UI 分类，固定八类；图标和 component 使用受控映射。只公开 JSON，不携带 Zod、execute、编译器或服务实例。

数据端口使用正式 DataType，Handle.id 等于端口 key，同方向唯一。required 表示可省略，null 用 union 表达；集合用 array.itemType，没有 multiple。输出 storagePolicy 为 inline / reference / auto，缺省 auto，不改变端口类型。

普通控制 Handle 为 `control:source` / `control:target`，与数据 key 隔离，默认 Handle 不写入领域 portKey。Manifest 可选 `controlOutputs: [{ key, name, description? }]` 声明控制出口，不携带 DataType，不属于数据 outputs；同组 key 唯一。ControlEdge.source.portKey 只能引用该精确 Manifest 的已声明出口，target 命名控制输入仍不支持。Web 依 Manifest 渲染命名控制 Handle；If 只能从 true / false 出口连线，不使用默认控制出口。

config 用 string / number / boolean / select 字段数组；condition 字段只声明条件配置，不开放通用对象表单或默认表达式。默认值按类型、范围与选项校验。配置编辑提示在 config[].ui，输入提示在 ui.inputs，必须引用现有输入。Zod transform / 默认值不回写定义或 State。

## 内嵌 SubWorkflow Definition

`composite` 按 kind 区分 Iteration 与 SubWorkflow，分别保留 body 与 graph 槽位。`flow.subworkflow@1` 已有正式 composite Manifest / Definition 身份，没有 execute，也没有 Compiler Strategy。实例仅包含 `composite: { kind: "subworkflow", graph: GraphDefinition }`，表示当前不可变版本内固定调用一次内嵌图；不引用其他 Workflow，不新增 Run / Job，不包含映射、并发、重试或执行身份。

父节点输入直接由 graph.inputs 推导名称、类型与 required，继续使用 NodeDefinition.inputs 的 constant / workflow_input / template / candidate 及 DataEdge 语义；未来调用时按同名输入建立局部图边界。输出直接来自 graph.outputs，保持原类型，数组不再次提升。不存在单独 inputMapping / outputMapping 协议。

[nestedGraphSlots / walkGraphDefinitions](../packages/contracts/src/graph/traversal.ts)统一访问 root、Iteration.body 与 SubWorkflow.graph，返回 nodeId / graphKey 静态路径；不解析 scope、执行序号或 checkpoint namespace。Definition schema 与静态语义递归检查局部引用、DAG、输入输出类型、节点版本和配置；发布事务对返回的全部后代执行现有 capability / 模型权限检查。

Draft 允许保存尚不可执行的 SubWorkflow，配置字段边界仍递归生效。完整 Definition 静态校验不代表执行准入：生产 Publish 在资源授权后执行能力门禁，根 SubWorkflow 报 NODE_EXECUTION_KIND_UNSUPPORTED；Iteration body 内仍报 ITERATION_BODY_CAPABILITY_UNSUPPORTED。现有 Iteration Runtime、嵌套编辑、checkpoint 与 Execution Tree 未接入 SubWorkflow。

## Iteration Composite Contract

正式 `flow.iteration@1` 为 composite，不提供 execute。实例使用受 Schema 校验的 `composite` 字段，协议见[Iteration definition](../packages/contracts/src/node/iteration.ts)，不把 body 存入 config。固定 collection 端口为 items；itemType 明确声明 T，端口类型为 Array<T>，不从常量内容推断，空数组同样保留 T。invariantInputs 复用 GraphInputDefinition 声明额外端口，不得重复或覆盖 items。

body 使用同一 GraphDefinition / NodeDefinition / DataEdge / ControlEdge / 输出协议。bodyInputMapping 的 current_item 对应 T，current_index 对应 number，iteration_input 对应实例已声明端口（包括 items）；target 必须属于 body inputs、唯一、类型可赋值，并覆盖必填 body input。可选 invariant 不得供应必填 body input；optional → optional 可缺失，未来调用适配需省略缺失值，不补 null。body 内 workflow_input 仍指局部输入，Template / Candidate / 边和输出只能引用局部定义。

[resolveNodePorts](../packages/contracts/src/node/ports.ts)是静态语义端口入口：普通节点复用 Manifest；Iteration 按实例 itemType / invariantInputs 推导输入，并将每个 body declared output U 提升为同名 Array<U>，数组 U 保持嵌套，不 flatten。Manifest 的 portDerivation=iteration 标识需结合实例解析，静态 outputs=[] 不能解释为没有有效输出，也不接受手工固定 outputs。

Draft 可保存缺少 composite、空 body、未完成映射及既有 sources=[] 输出编辑态；结构、局部引用与联合 DAG 仍遵循原 Graph Draft 校验。Publish 检查完整映射、已知元素类型（不接受顶层 any）、必填来源、有效非空 Action body、类型及输出。body 可不声明输出，遵循既有 Graph outputs=[] 语义。

v1 Publish 仅允许 body 内普通 Action；拒绝 nested Iteration、其他 composite、If、Human Review、其他 control / interaction，以及带命名控制出口的特殊 Action。Contract 的递归表达能力不代表 Publish 或 Runtime 放行。Candidate 等表达继续受既有互斥来源证明约束，不因为进入 body 放松。

空 items 合法，不调用 body，并为每个声明输出产生对应类型的空集合；当前由独立 Iteration Strategy 执行，空集合完成父 NodeRun，不创建 ItemRun，详见[当前架构](architecture.md#iteration-item-run)。current_index 是固定 snapshot 的从零位置，不是业务 itemKey；Definition 不含 occurrence、scope 或 LangGraph 身份。

## 服务端执行与编译

业务节点可以拥有小说拆集、分镜生成、视频生成等领域 contract，并通过受信任 Plugin 执行所需能力；引擎遵循[业务解耦原则](platform-model.md#workflow-通用性与业务解耦)。新增业务优先新增或组合 Node / Plugin；只有新的通用控制语义才需要独立 Strategy / 编译适配，不能把业务名的判断加进 Executor、Binding 或通用 Execution 归属。

普通 Action NodeType 持 manifest、三组 Zod Schema 和 execute(input, config, context)，不取得 Graph builder、BindingResolver、内容 Store 或 Checkpoint。普通业务只接收已校验输入与配置并返回结果，不自行调度、解析绑定或持久化输出。非 Action 使用不带 execute 的 NodeDeclaration，由独立策略决定是否可执行；正式目录注册不等于获准 Publish / Compile。

NodeRegistry 按 type / version 精确注册，拒绝重复 / 缺失版本，固定 Manifest 并保留实现的 this；getAction 拒绝非 action。assertNodeSchemas 检查公开字段及默认值，不承诺证明任意 Zod 与 Manifest 完全等价。

Action 编译策略只调用统一 Executor，返回当前 nodeId 的 outputs 增量；不展开旧 State、不接管边或存储。其他 executionKind 使用独立结构策略，不能在 Executor 内按业务 type 写分支。详细管线与失败规则见 Runtime。

## 节点类型开发

1. 声明纯 JSON Manifest、三组严格 Zod 和业务 execute；可使用 createOperationNodeType 组合。invokeNodeOperation 只是独立值校验工具，不是另一套 Runtime。
2. 在受信任 Registry 注册精确版本；GET /api/v1/workflow/node-types 默认认证、no-store，只返回 Manifest。缺少版本时界面显示不可用，不按目录顺序猜测。
3. 通过静态发布校验和运行时三组 Schema 验证真实行为。能力 / 资源绑定须补齐相应发布授权检查，不能仅靠 UI 控件推断。

## Preset 与 NodeRun

Preset 只是所属 type / typeVersion 的配置模板，applyNodePreset 验证归属并合并实例覆盖，不构成新的运行身份或执行器。

NodeRun 保存 running / completed / failed 业务历史，inputs / outputs 为 RuntimeValue map，error 为安全 stage / 可选 code / message。Action Repository 先按 workflowRunId / scopeKey / nodeId 定位 NodeOccurrence，再在该 occurrence 内原子分配正整数 attempt，新执行新建记录，终态不可覆盖。共享协议的 stage 可扩展，不要求使用 Runtime 的固定枚举。

State 只保留当前有效值，Artifact 保存内容，Checkpoint 负责恢复，NodeRun 不驱动调度。普通 Action 不主动 interrupt；Human Review 在当前单次逻辑审核边界下复用 attempt 1 running，恢复不算新 attempt。完整审计、输入漂移检测和未来 occurrence 限制见[当前架构](architecture.md#human-review-声明与纯业务边界)。

## 正式文本节点

`ai.text_generate@1` 为普通 Action：必填 prompt、可选 system，输出 text，均为 string。config 只有必填 UUID modelConfigurationId，不保存插件、endpoint、模型名或 key。Web 的 model-selector 按 `text.generate` 读取 Model Catalog，选择结果仍只写 modelConfigurationId。已选模型展示该配置的最大输出和随机度，不在节点上另存参数。prompt 与 system 可分别插入当前节点可用的上游文本输出，写入该端口自己的 template；编辑时展示当前节点显示名和端口显示名，保存值仍是 `{{名称}}` 对应 nodeId 与 portKey。没有变量时仍是 constant。选择变量不创建 Data Edge。

execute 通过 CapabilityInvoker 调用 text.generate。节点只保存 modelConfigurationId，不保存插件、厂商或 SDK。正式执行由 `text_generation@1` 完成；新增文本厂商不因此新增 NodeType、Compiler 或 Executor。保存草稿允许未完成选择，但拒绝额外配置字段；发布要求完整严格 Schema 及同 Owner 可用模型绑定，执行时重新授权并解密，见[架构](architecture.md#文本-ai-与-provider-plugin)。

## Human Review

Human Review 使用 interaction 声明，审批决策是数据输出，后续流程控制由 Control Node 决定；不把 reject 记为执行失败，也不增加 approve / reject 控制出口。V1 为文本审核，instruction 是静态配置，节点名称来自 NodeDefinition.name。领域协议与当前接入边界见[当前架构](architecture.md#human-review-声明与纯业务边界)。

## If 条件节点与编译能力边界

`flow.if@1` 为 control 声明，不提供 Action execute；必填 string 输入 value，配置仅为 condition，控制出口 true / false，数据 outputs 为空，不声明 matched。旧 operator / expected 临时配置不再接受。condition 使用共享 ConditionExpression 协议，例如 `{"===":[{"var":"value"},"approved"]}`。

第一版只接受四种形式：`{"===":[变量,字符串]}`、`{"!==":[变量,字符串]}`、`{"in":[字符串,变量]}`、`{"!":{"in":[字符串,变量]}}`；变量固定 `{"var":"value"}`，不允许路径、默认值、未知字段、自由嵌套 !、AND / OR、数值或 boolean 条件。比较区分大小写、不 trim、不转换类型；空字符串合法。contains / not_contains 沿用 JSON Logic 的 in 语义：被查字符串为空时 in 返回 false，取反返回 true。

协议解析前检查纯 JSON 结构，拒绝循环、accessor、隐藏或 symbol 属性、稀疏数组、自定义原型及非 JSON 值；最大深度 8，最大节点数 32（对象、数组和标量均计数）。这些是条件表达式的静态防护，不是 Workflow 容量或执行预算。

Workflow 的 `runtime/condition-evaluator.ts` 封装精确版本 json-logic-engine@5.0.7，只调用同步 run，关闭解释优化与 inline 优化，不暴露引擎实例、build 或注册入口。调用方提供 condition 与独立 `{ value }`；evaluator 重校验表达式，并要求 value 是自身可枚举数据属性且为 string，不接受缺失、继承值、getter 或额外上下文。引擎只获得新建 `{ value }`，返回值必须为 boolean；异常使用安全摘要，不附原始异常、条件或值。第三方不接触 WorkflowState、凭证或任何服务。

`validateWorkflowDefinitionSemantics` 复用相同 condition Schema 和现有 Binding / DataType 规则，只静态校验、不求值；要求 true、false 各有分支，拒绝未知或无名称出口，仅识别精确 flow.if@1。生产 Publish 与 Compiler 共用简单 If 能力分析：每个出口恰好一个不同的 Action entry，分支后继可形成普通 Action DAG / ALL join；来源须属于本 region 或 If 已完成的祖先。多个独立 If 的分支区域不能交叉。

If CompilationStrategy 不经 Action NodeExecutor，不提供 matched Data Output；内部条件结果按 nodeId 写入 execution.controlResults，LangGraph 原生 conditional edges 读取结果后只激活一支。分支输入依赖不再编译成无条件触发，原始 Binding 数据来源保持不变。执行预算、START / END、checkpoint / resume 和阶段性拓扑限制见 [Runtime](runtime-architecture.md#简单-if-的条件路由与预算)。

生产执行支持静态证明安全的直接汇聚：同一 If 的唯一共同目标完整覆盖两侧末端，目标之后恢复普通 DAG；不新增汇聚领域节点。仍拒绝不安全汇聚、nested If、不同 If region 交叉与跨支依赖；这些属于 Compiler 能力限制，不是永久 Workflow Contract。条件最终输出仅允许同一 If 的两个 region 中保证执行的节点以 sources 声明，详见 [Workflow](workflow-model.md#输入与输出)，不引入 optional output；汇聚后保证执行的节点可以声明单来源输出。汇聚目标通过候选输入读取实际执行分支的业务值；普通 DataEdge / template 仍不能直接读取互斥分支。候选证明、完成组与共同上游处理见 [Runtime](runtime-architecture.md#if-的直接汇聚)。Web 在 Generic Node 内复用 string Binding 编辑 value，通过等于 / 不等于 / 包含 / 不包含表单读写 condition；控制连线保存对应 source.portKey。未配置完整的 If 可以保存 Draft，Publish 仍以服务端校验为准；未知条件表达式保留，需用户明确替换后才能转为可编辑条件。

## 视频领域能力与厂商边界

领域类型可以专业化。用户选择 Provider，对应的受信任插件执行能力。图片、视频、语音可以使用各自插件，文本插件和 Vercel AI SDK 只负责当前的 `text.generate`。这些媒体能力、Asset、简单 If 之外的控制 / 交互执行与通用节点配置 UI 尚未交付，范围见[实施方案](implementation-plan.md)。
