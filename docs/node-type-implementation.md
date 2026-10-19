# 节点类型实施说明

NodeType 负责业务 execute，平台负责统一编译包装。节点元数据、数据值与运行服务的完整边界分别见 [Node 模型](node-model.md)、[数据模型](data-model.md) 与 [Runtime](runtime-architecture.md)。

## 共享说明书

NodeTypeManifest 保存 type、version、必填 executionKind、metadata、输入输出端口、config 字段数组，以及可选 capabilities / ui。executionKind 区分 action / control / composite / interaction，不等于 UI category。

端口使用 primitive / named / array / object / union / any 描述。输入可声明 required；集合用 array.itemType，没有 multiple。FieldUI 只描述编辑方式，数值范围和配置默认值以对应字段声明为准。输入 UI 必须引用现有端口。

Manifest 与 DataTypeManifest 都可以 JSON 往返，不携带 Zod、execute 或 Schema 实例。媒体类型使用 media.image 等名字，不再给每种领域类型添加核心 kind。

## 服务端实现

NodeType.execute(input, config, context) 只处理业务。NodeRegistry 按 manifest.type / manifest.version 精确注册与查找，保留实现的 this 依赖并固定 Manifest。getAction 拒绝控制、交互或复合声明；这些声明由独立编译策略处理，不伪装成普通操作。

createOperationNodeType 仅组合 Manifest、三组 Zod 与业务 operation，返回 execute 实现，不生成 LangGraph 节点。invokeNodeOperation 仍是独立真实值校验工具；它不是另一套节点扩展接口或调度器。定义和 Preset 保留原始 JSON 配置，不把 transform / 默认值回写后再次累积转换。

NodeCompilationStrategy 接收节点、说明书、统一 Executor、执行上下文工厂及 addNode 边界。action 策略只添加一个调用 Executor 的函数，不接管边、暂停、并发或资产写入；结构、交互等策略及完整 WorkflowCompiler 待下一步设计。

## 目录 API 与前端

GET /api/v1/workflow/node-types 默认认证，no-store。生产 Registry 仍为空，没有占位 LLM 或视频类型。目录查询与连线共用唯一性校验，不按数组顺序选择冲突的 type / version。

GenericWorkflowNode 按精确 Manifest 生成数据 Handle，其 ID 必须等于对应端口 key，显示正式 DataType 的中文摘要，并提供 `control:source` / `control:target` 普通控制出入口；缺少匹配版本显示不可用。控制 Handle 命名空间与数据端口 key 隔离，默认 UI 控制 Handle 不写入领域 portKey。Control Edge 可选命名端口支持结构与转换，不代表已有命名控制端口 Manifest、路由交互或 Branch。React Flow renderer 与两类边的连线、重连、删除事件已接入画布；生产目录仍为空，没有节点添加与 Workflow 持久化，项目仍只保存名称、视口和 revision，没有运行按钮。

## 实施边界

数据类型校验与共享兼容算法已实现；RuntimeValue、版本化引用、Artifact / Asset、State 及 Codec / Resolver / Executor / Store / Recorder 已有类型或协议。具体 Runtime、内容持久化、大小预算、权限解析与审计投影尚未接入，不使用测试替身提供生产降级。

Data Edge 表达值来源，Control Edge 表达显式执行先后；两类边的联合无环检查不实现实际依赖编译或 Join。后续议题统一见 [实施方案](implementation-plan.md)，不先跳入 Plugin、Batch 或完整生成流程。
