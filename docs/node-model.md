# Node 模型

NodeDefinition 是实例，NodeTypeManifest 是可传输说明书，NodeType 是服务端业务实现。数据承载见[数据模型](data-model.md)，执行与记录见[Runtime](runtime-architecture.md)。

## 实例与编辑视图

实例固定 id、type、typeVersion、name、config、inputs 和 ui.position。inputs 只保存 constant / workflow_input / asset 三类静态绑定；asset 固定 assetId + versionId。上游连接只保存在 Workflow.edges，不重复放入 inputs。

React Flow 的 type 选择通用 renderer，真实节点身份保存在 data.nodeType / typeVersion；selected、dragging、measured 不持久化。两类边保留 ID、种类、节点及可选端口；断连 / 重连必须核对完整旧边快照，防止过期事件修改现有连接。

Data Edge 提供输入值来源，Control Edge 提供先后关系，不自动相互创建。数据输入单连接，且不能与静态绑定并存；数组不隐含多连接聚合。控制边不占输入，两类边的执行依赖按节点对去重，普通 fan-in 采用 [ALL Join](runtime-architecture.md#普通确定性依赖的-all-join)。

## Manifest 与端口

Manifest 固定 type / version 与 executionKind（action / control / composite / interaction）。category 是独立的 UI 分类，固定八类；图标和 component 使用受控映射。只公开 JSON，不携带 Zod、execute、编译器或服务实例。

数据端口使用正式 DataType，Handle.id 等于端口 key，同方向唯一。required 表示可省略，null 用 union 表达；集合用 array.itemType，没有 multiple。输出 storagePolicy 为 inline / reference / auto，缺省 auto，不改变端口类型。

普通控制 Handle 为 `control:source` / `control:target`，与数据 key 隔离，默认 Handle 不写入领域 portKey。命名控制端口仅有结构与转换支持，当前没有对应 Manifest / 路由交互。

config 用 string / number / boolean / select 字段数组；默认值按类型、范围与选项校验。配置编辑提示在 config[].ui，输入提示在 ui.inputs，必须引用现有输入。Zod transform / 默认值不回写定义或 State。

## 服务端执行与编译

NodeType 持 manifest、三组 Zod Schema 和 execute(input, config, context)，不取得 Graph builder、BindingResolver、内容 Store 或 Checkpoint。普通业务只接收已校验输入与配置并返回结果，不自行调度、解析绑定或持久化输出。

NodeRegistry 按 type / version 精确注册，拒绝重复 / 缺失版本，固定 Manifest 并保留实现的 this；getAction 拒绝非 action。assertNodeSchemas 检查公开字段及默认值，不承诺证明任意 Zod 与 Manifest 完全等价。

Action 编译策略只调用统一 Executor，返回当前 nodeId 的 outputs 增量；不展开旧 State、不接管边或存储。其他 executionKind 使用独立结构策略，不能在 Executor 内按业务 type 写分支。详细管线与失败规则见 Runtime。

## 节点类型开发

1. 声明纯 JSON Manifest、三组严格 Zod 和业务 execute；可使用 createOperationNodeType 组合。invokeNodeOperation 只是独立值校验工具，不是另一套 Runtime。
2. 在受信任 Registry 注册精确版本；GET /api/v1/workflow/node-types 默认认证、no-store，只返回 Manifest。缺少版本时界面显示不可用，不按目录顺序猜测。
3. 通过静态发布校验和运行时三组 Schema 验证真实行为。能力 / 资源绑定须补齐相应发布授权检查，不能仅靠 UI 控件推断。

## Preset 与 NodeRun

Preset 只是所属 type / typeVersion 的配置模板，applyNodePreset 验证归属并合并实例覆盖，不构成新的运行身份或执行器。

NodeRun 保存 running / completed / failed 业务历史，inputs / outputs 为 RuntimeValue map，error 为安全 stage / 可选 code / message。Repository 按 workflowRunId + nodeId 原子分配正整数 attempt，新执行新建记录，终态不可覆盖。共享协议的 stage 可扩展，不要求使用 Runtime 的固定枚举。

State 只保留当前有效值，Artifact 保存内容，Checkpoint 负责恢复，NodeRun 不驱动调度。普通 Action 不主动 interrupt；Human Review 的恢复复用与 attempt 关联仍需单独设计。

## 正式文本节点

`ai.text_generate@1` 为普通 Action：必填 prompt、可选 system，输出 text，均为 string。config 只有必填 UUID modelConfigurationId，不保存插件、endpoint、模型名或 key；model-selector 只是 UI 提示。

execute 通过 CapabilityInvoker 调用 text.generate。节点只保存 modelConfigurationId，不保存插件、厂商或 SDK。正式执行由 `text_generation@1` 完成；新增文本厂商不因此新增 NodeType、Compiler 或 Executor。保存草稿允许未完成选择，但拒绝额外配置字段；发布要求完整严格 Schema 及同项目可用模型绑定，执行时重新授权并解密，见[架构](architecture.md#文本-ai-与-provider-plugin)。

## 视频领域能力与厂商边界

领域类型可以专业化。用户选择 Provider，对应的受信任插件执行能力。图片、视频、语音可以使用各自插件，文本插件和 Vercel AI SDK 只负责当前的 `text.generate`。这些媒体能力、Asset、控制 / 交互结构与节点配置 UI 尚未交付，范围见[实施方案](implementation-plan.md)。
