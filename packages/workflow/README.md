# @dramaflow/workflow

提供领域无关的值契约、版本快照、服务端 NodeType / Registry 及泛型 LangGraph 节点适配。当前不实现 WorkflowState、Binding 运行求值、整图 Compiler、持久化运行或外部模型调用。

| 导出                          | 行为                                                                            |
| ----------------------------- | ------------------------------------------------------------------------------- |
| parseWorkflowInputs           | 按显式 Zod 契约校验工作流输入，拒绝额外字段和非 JSON 值                         |
| collectWorkflowOutputs        | 按声明来源收集并校验最终输出，不取任意最后节点                                  |
| createWorkflowVersionSnapshot | 按完整版本 Schema 校验、复制并递归冻结 JSON 快照                                |
| assertWorkflowRunVersion      | 检查运行的版本与 Workflow 身份一致                                              |
| isDataTypeAssignable          | 目标为 any 时接受任意来源；any 来源只匹配 any；其余同种类、同 domain 或数组递归 |
| parseNodeManifest             | 验证并复制纯 JSON 公开说明书                                                    |
| assertNodeSchemas             | 检查 Manifest 与三组 Zod 的字段集合，校验公开配置默认值                         |
| parseNodeDefinition           | 检查实例类型版本、输入端口与配置，不求值 Binding                                |
| applyNodePreset               | 检查所属类型版本并显式合并配置，不改变运行身份                                  |
| invokeNodeOperation           | 校验 inputs / config → 调用操作 → 校验输出，透传 RunnableConfig                 |
| NodeRegistry                  | 按 type / version register、get、compile；listManifests 只返回公开副本          |
| createOperationNodeType       | 组合 Manifest、NodeSchemas 与 operation，生成本节点适配                         |
| createWorkflowRunConfig       | 检查 Run / Version，以显式 Run.threadId 绑定 thread_id，拒绝配置冲突            |

NodeType 只在服务端存在，持有 manifest、inputSchema、outputSchema、configSchema 和 compile。NodeSchemas 是三组真实值 Zod，内部 NodeContract 再带明确类型版本；Manifest 以 config 字段数组说明编辑与公开约束，不从 Zod 转换生成，也不包含任何可执行实例。

Registry 不注册 Preset 身份，不选择最新版或回退类型。NodePreset 是配置模板，实例 preset 元数据不改变运行类型；同一个 type / version 保持明确契约。公开配置默认值按 Manifest 校验并须被对应服务端字段接受，但不自动写入实例或 State。

DataType 的 any 只作为目标端口放宽静态匹配，实际值仍由 Zod 校验；json 只与 json / any 目标匹配，file 只与 file / any 目标匹配，不提供类型继承或媒体转换。Media 与 Asset 的运行契约、资产权限和读取尚未实现。函数定义在 contracts，本包再导出。

CompileContext.readInputs / writeOutputs 保持泛型边界，普通操作只收到自身 inputs / config 与独立 RunnableConfig。现有适配不解析 connection / constant / workflow_input / asset，不确定图执行顺序，也不给普通节点 Graph builder。先确定 DataType / RuntimeValue / Reference / Domain Object 的关系，再完成 WorkflowState 与整图编译。

Definition / Preset 保留原始 JSON 配置，转换和默认值不回写定义，避免重复 transform。操作值与调用方隔离，拒绝额外字段和非 JSON，异常直接传播，不重试、不寻找替代厂商；interrupt 控制异常交还 LangGraph。

快照只保证内存隔离与只读，不替代发布权限、持久化不可变性或完整图校验。Run 配置映射不创建运行、查询权限、加载版本或选择 checkpointer，也不将缺失 threadId 默认填成 Run.id。真实 LangGraph 测试验证独立 threadId 的中断恢复和隔离，并保留普通操作、Send / reducer 与并发验证；MemorySaver 与测试类型不作为生产能力。State、运行历史、资产与 Checkpoint 分工见 [WorkflowState 边界](../../docs/workflow-state.md)。

API 的真实 NodeRegistry 当前为空，没有生产 LLM、视频节点或插件。模型见 [Workflow](../../docs/workflow-model.md)、[Node](../../docs/node-model.md) 与 [Manifest](../../docs/node-type-implementation.md)，技术分工见 [Runtime](../../docs/runtime-architecture.md)，现状与下一步见 [架构](../../docs/architecture.md) 和 [实施方案](../../docs/implementation-plan.md)。
