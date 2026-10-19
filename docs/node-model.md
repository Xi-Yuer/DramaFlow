# Node 模型：③ 可调度执行单元

Node 是 Workflow 中最小的逻辑执行单元，由 LangGraph 调度。本模型区分公开类型声明、服务端实现和 React Flow 编辑视图；类型说明书见 [NodeType 实施说明](node-type-implementation.md)，技术分工见 [Runtime 架构](runtime-architecture.md)，当前能力见 [架构说明](architecture.md#node-基础库)。

## 三层边界

| 层次       | 对象                                                 | 职责                                                       |
| ---------- | ---------------------------------------------------- | ---------------------------------------------------------- |
| 共享定义   | NodeTypeManifest、NodeDefinition、WorkflowDefinition | 纯 JSON 协议，可传输和持久化，不包含 Zod 实例或执行代码    |
| 服务端实现 | NodeType、NodeRegistry、NodeCompiler                 | 持有 Manifest、Input / Output / Config 三组 Zod 与 compile |
| 编辑视图   | React Flow Node / Edge、GenericWorkflowNode          | 位置、选择、拖动、测量和受控组件，不成为运行状态           |

现有 contracts、workflow、web 目录继续承载这些职责。类型使用 ai.llm、video.image_to_video 等稳定命名空间 ID；实例 typeVersion 固定正整数版本，展示名称不改变身份。Registry 仅按 `(type, version)` 精确匹配，不寻找最新版或默认类型。

## NodeDefinition 与输入来源

```ts
interface NodeDefinition {
  id: string;
  type: string;
  typeVersion: number;
  name: string;
  config: Record<string, JSONValue>;
  inputs: Record<string, InputBinding>;
  preset?: string;
  ui: { position: { x: number; y: number } };
}
```

示例中的 JSONValue 表示 JSON 值，实际类型由 contracts Schema 导出。ui.position 必填且坐标有限；config 保存实际执行参数，inputs 以安全端口 key 为键，每个端口只有一个 Binding。可选 preset 是配置模板元数据，不参与 Runtime 类型查找。

| Binding.type   | 保存内容          | 当前边界                                             |
| -------------- | ----------------- | ---------------------------------------------------- |
| connection     | nodeId、outputKey | 引用上游节点输出，不嵌入实际结果                     |
| constant       | value             | 只接受 JSON，保留 false、0、空字符串和 null          |
| workflow_input | key               | 引用顶层 Workflow 输入                               |
| asset          | assetId           | 只保存资产标识，尚不读取资产、解析版本或检查资产权限 |

没有 Expression、Environment、Secret、State 或模板绑定。绑定结构已实现，运行求值尚未实现；不能把没有解析器的资产标识冒充可用媒体，也不能隐式读取整个 State 或聊天补齐输入。

输入是可参与工作流传递的数据，配置是执行参数，不按是否由用户手填划分。duration 等动态量可通过 constant 或 connection 表达；模型、供应商及凭证选择仍待 Plugin / Capability 设计，不固定到领域类型。

## 数据绑定与控制关系

Node.inputs 是数据绑定的唯一真相。connection 派生 React Flow 数据边；新增连线更新目标节点对应输入，删除连线仅在旧快照仍匹配当前来源时移除绑定，避免过期事件误删新连接。数据边不另行保存到 Workflow.edges。

Workflow.edges 只保存 ControlEdgeDefinition：id、sourceNodeId、可选 sourcePort、targetNodeId。条件路由等控制关系与数据来源分离；可视化统一使用 React Flow Edge，并以 data.kind 的 data / control 区分。执行激活和数据传值不同，二者联合依赖必须无环。

正式 workflowDefinitionSchema 检查节点、工作流输入和控制边引用、控制边 ID 唯一、自连接及联合 DAG。它不取得 Manifest，因此不检查 outputKey、路由端口是否已声明或端口类型兼容；也不检查资源权限、执行 Binding 或调度图。完整发布校验还需服务端类型与权限。

## 端口类型与配置

DataType 支持 any、string、number、boolean、json、image、video、audio、file、domain{name} 和递归 array{item}。它是端口类型描述，不等于 Zod 或媒体运行值协议。

isDataTypeAssignable 的 V1 规则是：any 在两侧均放宽静态匹配；其余基础种类相同，domain 名称相同，数组元素递归匹配。json 只匹配 json 或 any，file 只匹配 file 或 any，不引入继承、隐式类型提升或媒体转换。任何真实值仍须通过服务端 Zod。

端口 key 对应 Handle.id，同方向唯一、输入输出可同名。required / multiple 当前只描述端口，multiple 不等于数组，也不启用同一输入的多连接。端口不保存 defaultValue；固定输入放在 constant Binding。配置字段是 string / number / boolean / select 四类纯 JSON 声明，携带类型正确的默认值、适用范围和控件提示；默认值不会自动写入实例或 State。

## 服务端注册与编译

NodeType 持有 manifest、inputSchema、outputSchema、configSchema 与 compile。NodeRegistry 的 register / get / compile 使用相同的 type / version；listManifests 返回经过 Schema 白名单校验的独立 JSON 副本，不包含 Zod、compile 或服务端私有属性。

注册时 assertNodeSchemas 核对输入、输出及配置 key 集合，并验证公开配置默认值能被对应服务端字段接受；字段名相同不代表全部运行约束一致。Manifest 不由 Zod 自动转换生成，后端完整校验仍是实际值的权威。

createOperationNodeType(manifest, schemas, operation) 保留已有普通操作适配。编译产物接收泛型 State，CompileContext 读取明确输入并写回该节点的 State 增量；普通操作只收到 inputs / config 及独立 RunnableConfig。当前没有平台 WorkflowState 或 Binding 求值器，也没有完整 DSL Compiler。

Definition / Preset 保留原始 JSON 配置，Schema 转换和默认值不回写定义，防止编译、应用和执行间累积 transform。普通操作不重试、不更换插件；异常直接传播，LangGraph interrupt 控制异常不能记为普通 failed。节点只编译自身函数，不取得 Graph builder、修改其他节点或添加全图边。

## Preset 与 NodeRun

Preset 是所属 type / typeVersion 的配置模板，不是新的 Runtime 身份。applyNodePreset 检查类型版本、合并模板配置和实例覆盖并校验，不修改原对象、不运行节点，也不改变 Registry 查找。相近业务复用运行机制，不为剧本、广告文案等名称复制执行器。

NodeRun 保存 JSON 输入输出、结构化 code / message、ISO 时间与 pending、ready、running、waiting、completed、failed、skipped、cancelled 八种业务状态。它不包含调度逻辑，持久化、权限及事件投影尚未实现。运行固定不可变 WorkflowVersion 与节点类型版本；恢复使用原 thread，细节见 [Runtime 架构](runtime-architecture.md)。

## 视频领域能力与厂商边界

图生视频、合成、字幕、抽帧等可以是专业领域能力，保持契约明确且不绑定单一厂商。capabilities 目前只声明需求，不提供 Resolver、自动 Routing、模型或凭证选择。当前生产 Registry 为空，没有可调用的 LLM / 视频节点或生产 Preset 目录；前端展示与测试类型不代表真实生成能力。
