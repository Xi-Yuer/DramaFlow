# 节点类型实施说明

NodeType 负责业务 execute，平台负责统一编译包装。节点元数据、数据值与运行服务的完整边界分别见 [Node 模型](node-model.md)、[数据模型](data-model.md) 与 [Runtime](runtime-architecture.md)。

## 共享说明书

NodeTypeManifest 保存 type、version、必填 executionKind、metadata、输入输出端口、config 字段数组，以及可选 capabilities / ui。executionKind 区分 action / control / composite / interaction，不等于 UI category。

端口使用 primitive / named / array / object / union / any 描述。输入可声明 required；输出可声明 storagePolicy（inline / reference / auto），省略时由 Runtime 采用 auto，不改变端口 dataType。集合用 array.itemType，没有 multiple。FieldUI 只描述编辑方式，数值范围和配置默认值以对应字段声明为准。输入 UI 必须引用现有端口。

Manifest 与 DataTypeManifest 都可以 JSON 往返，不携带 Zod、execute 或 Schema 实例。媒体类型使用 media.image 等名字，不再给每种领域类型添加核心 kind。

## 服务端实现

NodeType.execute(input, config, context) 只处理业务。NodeRegistry 按 manifest.type / manifest.version 精确注册与查找，保留实现的 this 依赖并固定 Manifest。getAction 拒绝控制、交互或复合声明；这些声明由独立编译策略处理，不伪装成普通操作。

createOperationNodeType 仅组合 Manifest、三组 Zod 与业务 operation，返回 execute 实现，不生成 LangGraph 节点。invokeNodeOperation 仍是独立真实值校验工具；它不是另一套节点扩展接口或调度器。定义和 Preset 保留原始 JSON 配置，不把 transform / 默认值回写后再次累积转换。

NodeCompilationStrategy 接收节点、说明书、统一 Executor、执行上下文工厂及 addNode 边界。action 策略只添加一个调用 Executor 并返回自身 outputs 增量的函数，不接管边、暂停、并发调度或资产写入；结构、交互等策略及完整 WorkflowCompiler 独立设计。

## 目录 API 与前端

GET /api/v1/workflow/node-types 默认认证，no-store。生产 Registry 注册正式 `ai.text_generate@1`，没有占位图像 / 视频类型。目录只返回 Manifest，查询与连线共用唯一性校验，不按数组顺序选择冲突的 type / version。

GenericWorkflowNode 按精确 Manifest 生成数据 Handle，其 ID 必须等于对应端口 key，显示正式 DataType 的中文摘要，并提供 `control:source` / `control:target` 普通控制出入口；缺少匹配版本显示不可用。控制 Handle 命名空间与数据端口 key 隔离，默认 UI 控制 Handle 不写入领域 portKey。Control Edge 可选命名端口支持结构与转换，不代表已有命名控制端口 Manifest、路由交互或 Branch。React Flow renderer、节点位置和两类边的连线、重连、删除事件已接入真实草稿，保存 / 刷新通过 Workflow HTTP 闭环；项目信息仍只保存名称、视口及独立 revision。尚无节点添加 / 配置、发布、模型选择或运行按钮，持久化边界见[当前架构](architecture.md#web-workflow-draft-持久化)。

## 正式文本节点

`ai.text_generate@1` 是普通 Action，输入为必填 prompt 与可选 system，输出为 text，三者均为 string。config 只声明必填 modelConfigurationId；它是项目内已配置模型能力的 UUID，不保存 pluginId、endpoint、模型名或 API Key。Manifest 的 model-selector 仅是编辑提示，当前没有对应完整前端配置体验。

execute 通过上下文中的 CapabilityInvoker 请求 text.generate，不依赖具体厂商 SDK。同一能力可以由明确注册的不同 Provider 插件提供；Provider / 模型配置由 Worker 作用域能力服务读取和授权。新增厂商不生成新的核心 NodeType，也不为其复制 Compiler 或 Executor。

WorkflowService 保存 Draft 时拒绝已注册 Action 的额外 config 字段，允许必填选择尚未完成；发布时按严格 configSchema 完整校验。发布还验证精确注册类型、端口、输入来源、共享类型兼容、常量及最终输出；文本节点模型配置须存在、归属同项目、enabled 且满足 text.generate，插件和参数由正式 Schema 校验。未实现的 Asset / 命名控制端口 / 非 Action 结构拒绝发布。文本节点不能夹带 apiKey、baseURL 等配置字段进入不可变版本，凭证解密和运行时资源 / 权限仍在执行边界检查。具体模型与凭证边界见 [架构](architecture.md#文本-ai-与-provider-plugin)。

## 实施边界

数据类型校验与共享兼容算法已实现；RuntimeValue、版本化引用、Artifact / Asset、State 及 Codec / Resolver / Executor / Store / Repository 已有类型或协议。完整 Runtime、内容持久化、大小预算、引用权限与审核投影保持独立；节点业务记录与实现范围见 [架构](architecture.md#数据与-node-基础库)，不使用测试替身提供生产降级。

Data Edge 表达值来源，Control Edge 表达显式执行先后；联合无环检查与执行依赖编译职责分离，普通确定性依赖按目标聚合为 ALL Join。Plugin 文本能力沿既有运行链接入，其他能力的阶段安排统一见 [实施方案](implementation-plan.md)。
