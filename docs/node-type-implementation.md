# NodeType Manifest 与服务端实现

节点体系分为纯 JSON 共享定义、服务端实现与 React Flow 编辑视图。本文维护 Manifest 与后端类型的边界，实例和绑定关系见 [Node 模型](node-model.md)，实际接入见 [当前架构](architecture.md)。

## 公开 Manifest

| 字段             | 职责                              | 当前约束                                                              |
| ---------------- | --------------------------------- | --------------------------------------------------------------------- |
| type / version   | 稳定类型身份与正整数版本          | 通过实例 type / typeVersion 精确引用                                  |
| metadata         | name、description、category、icon | category 仅 input / ai / image / video / audio / flow / data / output |
| inputs / outputs | 可见端口                          | key、name、可选 description、DataType 及相应 required / multiple      |
| config           | 执行配置字段数组                  | string / number / boolean / select 四类                               |
| capabilities     | 所需能力类型                      | 可选、无重复，不绑定供应商                                            |
| ui               | 节点及输入的编辑提示              | 可选 color / inputs；配置控件只在 config[].ui                         |

Manifest 全部字段可 JSON 序列化，不含 Zod、JSON Schema、compile、实际参数值、服务端连接或密钥。端口与字段 key 发布后保持稳定，修改契约需明确类型版本；展示名称可调整。端口按方向检查唯一，配置 key 独立检查唯一。

配置默认值按字段类型校验；number 的 min / max 有效且默认值在范围内，select 选项值唯一且默认值属于选项。FieldUI 仅有受控 component 与可选 placeholder，slider 的数值边界来自对应 number 配置，不另存第二份范围。UI 输入引用必须属于输入端口。

端口不包含默认值；用户固定输入通过 constant Binding 表达。配置默认值可以公开并供后续编辑初始化参考，当前不自动注入 NodeDefinition 或 LangGraph State。端口 multiple 仍不代表多来源聚合已经实现。

## DataType 与真实值

DataType 是稳定类型说明，包含 any、json、file、基础值、媒体、domain 和递归 array；不扩展 Union、Tuple、继承或复杂泛型。any 仅放宽静态匹配，json 不自动吸收其他基础种类，file 不作为媒体基类；领域名称相同、数组元素递归匹配。不做隐式转换，真实值仍用 Zod 校验。

image / video / audio / file 声明不提供媒体读取或版本化 Asset 契约。asset Binding 目前仅有 assetId，不能由编辑器自行拼接 URL 或推断资产版本；资产读取、授权和版本解析尚未实现。

## 服务端 NodeType

```text
NodeTypeManifest（公开 JSON）
+ inputSchema / outputSchema / configSchema（服务端 Zod）
+ compile（仅生成本节点的 LangGraph 函数）
    ↓
NodeType
    ↓ NodeRegistry.register / get(type, version)
受信任的类型版本
```

注册时验证 Manifest，并用 assertNodeSchemas 检查端口及配置字段集合和公开默认值；Zod 保留完整复杂约束，不通过推断 Manifest 生成执行校验器。listManifests 只返回独立白名单 JSON，不能把完整后端对象发给浏览器。

Preset 仅是配置模板。它可以保留实例元数据，不能加入 Registry key，也不能让同一 type / version 的运行契约因 Preset 名称隐式变化。

createOperationNodeType 保留泛型普通操作适配与已有真实 LangGraph 测试。CompileContext 的 State / Update 尚未具体化，不解析四类 Binding，不获取全图构建器。WorkflowState 必须先确定，再实现完整 Workflow Compiler；If / Batch 等控制扩展另行设计。

## 目录 API 与通用节点

GET /api/v1/workflow/node-types 默认经真实 AuthGuard 认证，并设置 Cache-Control: no-store。NodeTypesModule 供服务端注册受信任类型，生产 Registry 当前为空，返回真实空数组，不注册占位 LLM / 视频节点。

前端边界校验 Manifest 列表并拒绝重复类型版本。GenericWorkflowNode 按 `(type, typeVersion)` 精确查找声明，自动生成输入输出 Handle、显示配置摘要；缺少对应版本时显示不可用。Handle 使用端口 key，图标来自受信任映射，不执行远程 UI 代码。这复用 [React Flow 原生 Handles](https://reactflow.dev/learn/customization/handles)。

画布已注册通用 renderer 并查询目录，显示加载、失败与真实空态；当前没有添加节点、完整配置面板、图编辑或工作流保存。项目保存仍只有名称、视口和 revision，不保存节点或控制边。

## 静态对照与下一步

| 维度       | LLM 示例                 | 图生视频示例                         |
| ---------- | ------------------------ | ------------------------------------ |
| 类型 ID    | ai.llm                   | video.image_to_video                 |
| 输入方向   | prompt、明确选择的上下文 | image、prompt、可动态传入的 duration |
| 输出方向   | text                     | video                                |
| 运行值依赖 | 显式文本 Zod             | 尚需明确媒体 / Asset 运行值协议      |
| 外部能力   | 受信任文本生成插件       | 受信任图生视频插件                   |

上述是声明职责对照，没有对应生产注册。下一步先明确 WorkflowState 的通道、节点输出身份、并行 reducer、Checkpoint 大小及 Binding 求值，再写完整编译链；Plugin Resolver、Tool、Agent、Middleware、Batch、HumanReview、SubWorkflow 和完整 Runtime 本轮不实施。
