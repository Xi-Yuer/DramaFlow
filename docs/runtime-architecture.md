# Runtime 架构与技术分工

LangGraph 是核心图 Runtime。平台实现定义协议、编译适配、业务执行和记录，不自建图调度、Checkpoint 或恢复状态机。数据与 Node 模型见 [数据模型](data-model.md)、[Node](node-model.md) 和 [State](workflow-state.md)，当前能力见 [架构](architecture.md)。

## 技术边界

React Flow 负责编辑器与交互，平台定义经适配保存；contracts 不依赖 React Flow、NestJS、Prisma 或 LangGraph。LangChain 提供模型 / Tool / Agent 等节点内部抽象。Zod 验证协议和实际值，可执行 Schema 留在服务端。

NestJS 承担认证、权限与业务入口；PostgreSQL 保存业务记录并承接未来持久 checkpointer；RustFS / S3 保存内容。Redis / Worker 后续承担长任务、配额与唤醒，不决定图中下一个节点。

## 编译与执行分离

```text
NodeDefinition + NodeExecutionContext
  → NodeRegistry.getAction(type, version)
  → BindingResolver.resolveInputs
  → RuntimeValueCodec.decodeRecord
  → inputSchema.parse / configSchema.parse
  → NodeType.execute(input, config, context)
  → outputSchema.parse
  → NodeExecutionResult { output }
```

普通 NodeType 不再 compile，也不取得 Graph builder。ActionNodeCompilationStrategy 只包装统一 Executor，注入调用时的当前 State 并返回 NodeExecutionResult；输出 encode 与图 State 增量适配独立处理，不把业务结果冒充 State 更新。control / composite / interaction 使用独立结构策略，不强行套普通 action。

普通 Action NodeExecutor 主干固定为精确版本查找、绑定、decode、输入 / 配置 Zod 校验、业务调用和输出 Zod 校验，返回业务 output。NodeExecutionContext 包含领域 workflow / state、项目运行定位及可选信号 / 能力 / 配置，不传 React Flow 对象；Codec 只接收单独构造的最小项目运行上下文。不按 node.type 分支，不处理输出编码、Artifact、State 增量、NodeRun、Retry 或 Human Review，实际范围见 [架构](architecture.md#数据与-node-基础库)。

### Action 执行错误阶段

NodeExecutionError 保留 nodeId、nodeType、stage、code 和原始 cause。六个 stage 为 resolve_input、decode_input、validate_input、validate_config、execute、validate_output；Registry 缺少版本或非 action 拒绝归入 resolve_input。普通失败停止后续步骤，不自动重试。输入校验使用 NODE_INPUT_VALIDATION_FAILED，引用错误保留在 decode_input 的 cause 中，不把所有问题当成原始 ZodError。

LangGraph GraphBubbleUp（含 interrupt / 父图 Command 控制异常）原样传播，不包装为业务失败，不自建恢复状态机。[官方 Interrupts](https://docs.langchain.com/oss/javascript/langgraph/interrupts) 说明中断必须交还图 Runtime；这里只守住异常边界，不引入审核实现。

原有 invokeNodeOperation 是独立值校验工具，不是第二套 Runtime。测试中直接使用原生 StateGraph / MemorySaver 只验证适配与线程机制，不能作为生产持久化或真实生成能力。

### 普通确定性依赖的 ALL Join

普通节点具有多个已确定的执行上游时，必须等全部上游完成后执行一次。NodeDefinition 不增加 joinMode；ANY / N_OF_M 等语义以后由专门控制节点表达。

当前 WorkflowEdge 只有 Data / Control Edge，两者均产生确定性执行依赖：Data Edge 表示目标需要上游输出，Control Edge 表示目标须在上游完成后执行。collectNodeDependencies 只读取两端 nodeId，按 target 聚合且对 source 去重；同一 A → C 的 Data Edge 与 Control Edge 只算一个上游，不按边 ID、端口或边种类重复计数。

DependencyCompiler 接收 edges 并使用收集后的 NodeDependency。单上游使用 `graph.addEdge(sourceNodeIds[0], targetNodeId)`，多上游使用 `graph.addEdge(sourceNodeIds, targetNodeId)`，例如 `graph.addEdge(['character', 'scene'], 'script')`。多上游不能拆成多个独立 addEdge；等待由 LangGraph 原生 waiting edge 承担，不建立平台 ready 计数、轮询或 Join Runtime。[官方 addEdge API](https://reference.langchain.com/javascript/langchain-langgraph/index/StateGraph/addEdge) 定义了数组上游参数。

执行依赖只决定什么时候执行，不替代输入绑定。原始 Data Edge 和 source / target.portKey 保持完整，由 BindingResolver 定位上游 RuntimeValue 并组装目标输入 map；decode 与完整输入校验继续留在后续执行层。Dependency Compiler 不读取数据端口、不获取 A.output、不 decode 或构造 B.input；Control Edge 不提供输入值。

If / Switch / Conditional Edge / Send / Batch 产生的候选分支不属于普通确定性上游。即使 A / B 到目标的边是静态的，只要条件路由可能跳过其中一条路径，也不能把 `[A, B]` 作为普通 ALL Join 的等待集合，否则目标可能永远无法触发。依赖收集规则仅覆盖当前普通确定性 Data / Control Edge；未来控制结构须先区分候选路径，不能直接沿用此规则，Compiler 不推断分支可达性。

### Data Edge 与节点输入

BindingResolver.resolveInputs 的上下文包含 node、nodeType、edges、state。上层按节点精确类型版本提供 Manifest，Resolver 不访问 NodeRegistry，按 nodeType.inputs 建立端口索引。仅处理 kind=data 且 target.nodeId 等于当前节点的边，把 `state.outputs[source.nodeId][source.portKey]` 原样绑定到 `inputs[target.portKey]`，再合并静态 Binding。constant 按端口 dataType 包装为 inline；workflow_input 按协议字段 key 直接复用 State.inputs；asset 按端口类型生成含 assetId / versionId 的固定版本引用。完整规则见 [数据模型](data-model.md#codecbinding-与执行服务接口)。

在取值与静态转换前，先检查静态 Binding 与数据边的来源冲突及已绑定的目标输入端口；同一目标端口的多条数据边也必须报 INPUT_SOURCE_CONFLICT，不定义覆盖优先级。上游节点结果或指定输出键缺失时，报 SOURCE_NODE_OUTPUT_MISSING；缺失工作流输入报 WORKFLOW_INPUT_MISSING；未声明的目标输入端口报 INPUT_PORT_NOT_FOUND。错误附带目标节点、输入键及相应边 / 来源定位，不返回 undefined 或借静态值补齐，原型继承属性不视为已有值。Resolver 无外部 I/O，不调用 Codec、NodeType、Zod 或内容 Store，不下载内容、生成 signed URL 或解析引用；未绑定的必填端口与实际类型校验继续留给执行层。

### RuntimeValue Decode 边界

RuntimeValueCodec.decode 只接收 RuntimeValue 与 projectId / workflowRunId，返回 unknown。inline 原样返回实际值；reference 只调用 DataReferenceResolver，具体授权与内容访问由该引用服务实现承担。媒体可以返回含临时访问 URL 的 MediaResource，其他领域返回相应业务对象，不统一转换成 Buffer 或 URL。decodeRecord 使用 Promise.all 并行解码，再保留输入键组装结果；任何引用失败都使批量调用失败，不提供部分结果或重试。

Codec 不读取 Registry、不依赖数据库或对象存储实现、不生成 URL，也不执行 Zod。引用失败用 REFERENCE_RESOLUTION_FAILED 保留边界与 cause；NodeExecutor 解码后执行 inputSchema.parse，按 NODE_INPUT_VALIDATION_FAILED 区分业务校验。NodeType.execute 只接收校验后的业务输入。输出 encode 仍保留独立 RuntimeValueEncoder 端口，详见 [数据模型](data-model.md#codecbinding-与执行服务接口)。

## State 与持久化

WorkflowState.outputs 使用 RuntimeValue map，定义、业务历史、内容存储与执行快照分离。真正的通道和 reducer 随 Graph Model 明确，不能用对象覆盖或业务状态轮询代替。[官方 Graph API](https://docs.langchain.com/oss/javascript/langgraph/graph-api) 说明图和状态机制。

运行配置使用必填 Run.threadId；恢复必须加载原不可变 WorkflowVersion，以兼容实现重建图，接回原 thread 与持久 checkpointer，而不是当前草稿。知道 thread_id 不等于拥有资源权限。当前只实现配置映射，没有生产运行接口和持久 checkpointer。[官方 Persistence](https://docs.langchain.com/oss/javascript/langgraph/persistence) 说明原生持久化机制。

## 人工介入、并行与副作用

人工介入继续使用 interrupt / Command.resume，不能吞掉中断控制异常或把它记为普通失败；恢复可能使节点从开头重入。审核决策是独立业务审计，waiting 仅业务投影；生成副作用与审核分离，受理结果不明不盲目重试，不承诺外部 exactly-once。[官方 Interrupts](https://docs.langchain.com/oss/javascript/langgraph/interrupts) 描述原生规则。

Data Edge 保存值来源，Control Edge 保存显式执行先后；定义层的联合 DAG 只检查无环，执行依赖由独立收集函数生成。普通确定性 fan-in 遵循上述 ALL Join，条件分支、Send、Batch 与子图的精确映射留待各自结构策略。单次图调用 maxConcurrency 位于顶层配置；跨运行与供应商配额由后续 Queue / Worker 处理，不把 Send 当作全部容量控制。[官方 Graph API 示例](https://docs.langchain.com/oss/javascript/langgraph/use-graph-api) 展示这些执行机制。

当前没有结构策略、完整 Compiler、生产 Runtime、模型调用、Queue、审核或内容 Store。生产节点目录仍为空；不得将测试适配、类型接口或规划标为可用业务能力。
