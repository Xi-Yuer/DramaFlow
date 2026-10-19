# @dramaflow/workflow

提供领域无关的 Workflow / Node 契约、快照、类型说明书适配及 LangGraph 节点编译边界。完整 State / InputValue / Binding、整图 Compiler、生产节点、外部调用和持久化运行服务尚未接入。

| 导出                          | 行为                                                                   |
| ----------------------------- | ---------------------------------------------------------------------- |
| parseWorkflowInputs           | 用显式 Zod 契约校验工作流输入，拒绝额外字段和非 JSON 值                |
| collectWorkflowOutputs        | 按显式节点与输出键收集最终输出并校验，不取任意最后节点                 |
| createWorkflowVersionSnapshot | 按完整版本 Schema 校验、复制并递归冻结 JSON 快照                       |
| assertWorkflowRunVersion      | 检查运行的版本及 Workflow 身份一致                                     |
| isDataTypeAssignable          | 按种类、domain 名称与数组元素结构判断兼容，不隐式转换                  |
| parseNodeDefinition           | 校验实例类型、版本、Preset、目标输入端口与配置                         |
| applyNodePreset               | 检查所属类型版本，显式合并 Preset 配置和实例覆盖后校验                 |
| inputBindingFromEdge          | 从完整端口映射提取数据绑定，不激活节点                                 |
| invokeNodeOperation           | 校验 inputs / config → 调用明确操作 → 校验 output，透传 RunnableConfig |
| parseNodeTypeDefinition       | 复制静态说明书并检查 ui.config 引用属于配置 Schema                     |
| assertNodePortSchemas         | 检查说明书端口 key 与运行输入输出 Zod 字段集合一致                     |
| createNodeTypeManifest        | 白名单输出静态声明与配置 JSON Schema，不导出输入输出值 Schema          |
| NodeRegistry                  | register / get / compile 按 type、version、可选 preset 精确匹配        |
| createOperationNodeType       | 组合说明书、显式 NodeValueSchemas 与 operation，产物可加入 StateGraph  |
| createWorkflowRunConfig       | 检查 Run / Version 身份，绑定根 Run.id 为 thread_id，保留其他配置      |

NodeTypeDefinition 是 NodeTypeDeclaration 加 configSchema，描述 type、version、metadata、inputs、outputs、configSchema、可选 capabilities 和 ui，不继承 NodeContract。端口以纯 JSON DataType 描述；ui.inputs 与 ui.config 分开，分别引用输入端口和配置字段。required / defaultValue / multiple 只是静态声明，不自动注入输入默认值或开放多连接；Capability 也不含 Resolver 或供应商选择。

NodeValueSchemas 显式提供 inputSchema / outputSchema。createOperationNodeType(definition, valueSchemas, operation) 可在 valueSchemas 中指定 preset，并生成内部 NodeContract：type、version、可选 preset 与三个 Zod Schema。assertNodePortSchemas 仅核对名称集合，不从 Zod 推断 DataType 或生成媒体值校验器。isDataTypeAssignable 只判断声明结构，不验证真实资产、权限或整张图。

NodeType 持有 definition、可选 preset 与 compile，Preset 标识不混入说明书。Registry 的 get(type, version, preset?) 不找最新版或回退；实例 / Preset 必填 typeVersion，编译与应用配置时检查身份。类型版本固定不等于已经实现发布存储、Preset 不可变版本或跨部署代码兼容管理。

CompileContext.readInputs / writeOutputs 隔离 State 与普通操作；控制与审核类型可直接使用 LangGraph 原生 Command / interrupt。NodeOperation 只收到 inputs / config，另收 LangChain RunnableConfig。值校验拒绝额外字段和非 JSON 值，保留对象级约束并隔离可变对象，不解析绑定、不更新 NodeRun、不判断 ready、不重试或调度。控制异常必须直接交还 LangGraph。

Definition / Preset 保留原始 JSON 配置；转换和默认值不回写定义，避免编译、应用和调用之间累积 transform。WorkflowInputContract / WorkflowOutputContract 同样是执行侧显式 Zod 契约，不传给浏览器；DataType 到完整运行值约束的统一映射尚待设计。

manifest 只公开静态声明与配置 JSON Schema。配置通过 Zod 官方转换器使用 input 方向、独立空 metadata registry 和不可表示即失败的策略；服务端仍执行完整 refine 等约束。Schema 默认值、枚举及端口默认值必须可以公开，不包含模型、插件实例或密钥。完整 NodeTypeDefinition 不能直接发送给浏览器。

快照保证内存隔离与只读，不写数据库、不替代权限或完整发布校验。Run 配置映射不创建任务、加载版本或检查项目权限。真实 LangGraph 测试验证节点编译、Interrupt / Command、Send / reducer 和图内并发；MemorySaver 与测试类型不代表生产恢复或真实模型调用。

模型见 [Workflow 模型](../../docs/workflow-model.md) 与 [Node 模型](../../docs/node-model.md)，说明书见 [NodeType 实施说明](../../docs/node-type-implementation.md)，技术分工见 [Runtime 架构](../../docs/runtime-architecture.md)。实际范围与下一步见 [当前架构](../../docs/architecture.md) 和 [实施方案](../../docs/implementation-plan.md)；当前没有生产 LLM 或图生视频节点。
