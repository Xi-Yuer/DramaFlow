# Runtime 架构与技术分工

LangGraph 是核心图 Runtime。平台实现定义协议、编译适配、业务执行和记录，不自建图调度、Checkpoint 或恢复状态机。数据与 Node 模型见 [数据模型](data-model.md)、[Node](node-model.md) 和 [State](workflow-state.md)，当前能力见 [架构](architecture.md)。

## 技术边界

React Flow 负责编辑器与交互，平台定义经适配保存；contracts 不依赖 React Flow、NestJS、Prisma 或 LangGraph。LangChain 提供模型 / Tool / Agent 等节点内部抽象。Zod 验证协议和实际值，可执行 Schema 留在服务端。

NestJS 承担认证、权限与业务入口；PostgreSQL 分别保存 Prisma 业务记录和官方 LangGraph checkpoint；RustFS / S3 保存内容。Redis / Worker 已承担执行命令投递；配额与更多唤醒语义后续定义，不决定图中下一个节点。

## 编译与执行分离

```text
NodeDefinition + NodeExecutionContext
  → NodeRunRepository.createRunning
  → NodeRegistry.getAction(type, version)
  → BindingResolver.resolveInputs
  → NodeRunRepository.updateInputs(RuntimeValue map)
  → RuntimeValueCodec.decodeRecord
  → inputSchema.parse / configSchema.parse
  → NodeType.execute(input, config, context)
  → outputSchema.parse
  → 按 OutputPortDefinition 调用 RuntimeValueCodec.encode
  → NodeRunRepository.markCompleted(RuntimeValue map)
  → NodeExecutionResult { output: Record<string, RuntimeValue> }
  → Action wrapper 返回 { outputs: { [nodeId]: output } }
  → WorkflowStateAnnotation.outputs reducer 合并
```

普通 NodeType 不再 compile，也不取得 Graph builder。ActionNodeCompilationStrategy 只包装统一 Executor，注入调用时的当前 State 与 state.run 中的项目 / 运行 ID，再将结果映射为当前 nodeId 的 WorkflowStateUpdate。wrapper 不展开旧 outputs，不解析 Binding、校验业务 Schema 或操作 Artifact；这些仍由 Executor 与注入服务承担。control / composite / interaction 使用独立结构策略，不强行套普通 action。

普通 Action NodeExecutor 先创建 running 记录，再执行精确版本查找、绑定、记录输入、decode、输入 / 配置 Zod 校验、业务调用、输出 Zod 校验和逐端口 encode；完成记录成功后才返回 RuntimeValue map。NodeExecutionContext 包含领域 workflow / state、项目运行定位及可选信号 / 能力 / 配置，不传 React Flow 对象；Codec 接收单独构造的项目运行定位；encode 额外携带 nodeId / outputKey / nodeRunId，Writer 另收到 DataType。不按 node.type 分支，不直接访问 Artifact 存储，通过独立 Repository 记录 NodeRun，不处理 State 增量、Retry 或 Human Review，实际范围见 [架构](architecture.md#数据与-node-基础库)。

### Action 执行错误阶段

NodeExecutionError 保留 nodeId、nodeType、stage、code 和原始 cause。Executor 对业务管线异常记录 resolve_input、decode_input、validate_input、validate_config、execute、validate_output、encode_output；Registry 缺少版本或非 action 拒绝归入 resolve_input。NodeRunRepository 故障保留原始异常，不包装为这些业务失败。普通失败停止后续步骤，不自动重试。输入校验使用 NODE_INPUT_VALIDATION_FAILED，引用错误保留在 decode_input 的 cause 中，输出编码或 Artifact 写入失败使用 encode_output / NODE_OUTPUT_ENCODING_FAILED，不与 validate_output 混淆。

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

decode 不读取 Registry、不依赖数据库或对象存储实现、不生成 URL，也不执行业务 Schema 校验。引用失败用 REFERENCE_RESOLUTION_FAILED 保留边界与 cause；NodeExecutor 解码后执行 inputSchema.parse，按 NODE_INPUT_VALIDATION_FAILED 区分业务校验。NodeType.execute 只接收校验后的业务输入。输出 encode 根据端口存储策略，经统一 DataStoragePolicyResolver 选择 inline / reference；reference 只委托 ArtifactWriter。inline 只检查可持久化 JSON 边界，不调用业务 Schema；默认类型规则、最小上下文及失败约束见 [数据模型](data-model.md#codecbinding-与执行服务接口)。

### 节点业务记录与 Checkpoint

NodeRun 是实际业务执行历史，Checkpoint 是 LangGraph 恢复快照，二者不互相推导。领域协议位于 contracts/workflow/node-run.ts，NodeRunRepository 位于 workflow/run/node-run-repository.ts，数据库模型位于 database/prisma/schema.prisma，生产实现与权限工厂位于 packages/server/workflow，供 API / Worker 复用；Executor 不依赖 Prisma 或数据库。createRunning 只接收 workflowRunId / nodeId；Repository 实例由工厂限定所有者、项目和运行，projectId 不由创建参数传递。attempt 由数据库在分配与插入的同一事务锁内原子确定；Executor 不读取或递增旧 attempt。每次明确的新普通 Action 执行创建新记录，旧终态不能覆盖。

running 在 Registry / Binding 之前创建，Binding 成功后 updateInputs 保存 RuntimeValue，decode 后业务大对象不进入记录；校验与编码成功后 markCompleted 保存 RuntimeValue 输出。业务上下文的 nodeRunId 来自本次创建结果，不从调用上下文推断恢复关联。Binding 或后续业务管线的正常异常先转换为具有准确阶段的 NodeExecutionError，再 markFailed 并抛回；不将 Binding 错误归为 execute。createRunning、updateInputs、markCompleted 位于业务失败 catch 范围之外：Repository 故障属于 Runtime 基础设施失败，原样向上抛，不再调用 markFailed。创建记录未返回时不进入 Binding，输入记录未成功时不进入 decode，完成记录未成功时不返回 NodeExecutionResult；不提供内存或本地兜底。若完成请求的提交结果不明确，数据库记录以实际持久化结果为准，Executor 不反向标记 failed 或自动重试。业务失败后 markFailed 自身再失败，沿用 NodeRunRecordingError 同时保留原 stage / cause 和 recordingError，不吞掉任一原因。

NodeRunError 的领域字段 stage 为字符串、code 可省略；Runtime 自己维护严格的执行阶段类型，并写入阶段码与阶段说明，不复制原始 cause、stack 或供应商错误文本；原始原因仍保留在抛出的执行错误中。NodeRun completed 表示业务调用及输出记录成功，不表示随后的 State reducer 或整个 Graph 一定成功；NodeRun、Artifact 与 Checkpoint 不承诺跨服务原子提交。普通 Action 禁止主动 interrupt。原生 interrupt / ParentCommand 仍原样穿透，已有 NodeRun 保持 running，不记 failed；本步不复用恢复关联。Human Review 再引入 waiting，并明确 resume 关联同一 NodeRun、不增加 attempt。

### WorkflowRun 记录边界

WorkflowRun 保存某个明确 WorkflowVersion 的一次完整运行，独立于 NodeRun 历史和 LangGraph Checkpoint。完整协议在 contracts/workflow/workflow-run.ts，Repository 抽象在 workflow/run/workflow-run-repository.ts，Prisma 实现在 packages/server/workflow；不在 contracts 或 workflow Repository 中引入数据库依赖。create 必须接收 projectId / workflowId / workflowVersionId 和 RuntimeValue 输入，不解析最新版、不随草稿更新。id 与 threadId 是独立字段；配置适配只消费运行元数据，不传递输入输出到 RunnableConfig。

Repository 创建 pending，使用明确的 markRunning / markWaiting / markCompleted / markFailed / markCancelled。合法转换、时间规则见 [Workflow 模型](workflow-model.md#workflowrun一次实际运行)；Repository 对当前状态原子检查，数据库保护不可变身份、版本、输入和合法转换。getById 读取限定权限的完整记录，claimPendingForStart 原子完成 pending → running 并写首次时间，claimWaitingForResume 原子完成 waiting → running 并返回已抢占记录；无权访问、记录不存在或已不在 waiting 时返回 null。WorkflowRun waiting 只表示整图正在等待，NodeRun 仍只有普通 Action 的三种状态；记录操作不调用 LangGraph，提交与执行分离，executeStart / executeResume 由 Runner 协调，人工审核尚未实现。

inputs / outputs 是 RuntimeValue map。outputs 只接收最终对外工作流结果，不复制按 nodeId 组织的 State.outputs；结果收集由 WorkflowOutputResolver 承担，完整业务值校验继续由节点三组 Schema 负责。NodeRun 通过同项目复合外键引用真实 WorkflowRun，Checkpoint 继续独立。WorkflowVersionRepository 是纯读取接口，返回完整版本 / 项目 / 工作流身份或 null。共享服务的有权限作用域 Prisma 实现读取独立、不可更新的 workflow_version.definition，经正式 Schema 校验，不读取 draft 或 latest。Draft 更新和绑定修订的发布由独立 WorkflowService 负责，不进入 Runner 或只读 Repository。

### WorkflowRunner 首次启动

run/workflow-run-submission.ts 的 DefaultWorkflowRunSubmissionService 只提交：start 接收项目 / 工作流 / 明确版本 ID 和 RuntimeValue 输入，拒绝 Definition / draft；核对固定版本归属后经 SubmissionRepository 在同一事务创建 pending 与 start Outbox，返回 WorkflowRun。resume 在 Run 行锁下创建 { kind: "resume", workflowRunId, executionId, value }，保存当前 waiting 周期，不 claim、不调用 Graph。Dispatcher 在成功响应前确认 Redis 入队。

run/workflow-runner.ts 是执行已有 Run 的生命周期边界，只提供 executeStart / executeResume。首次执行顺序为读取 pending → claimPendingForStart 原子抢占 running → 重新加载原版本并核对归属 / 冻结 Definition → compile → invoke → 检查原生 snapshot → completed / waiting。竞争失败报 WORKFLOW_RUN_NOT_PENDING，不编译或调用图；执行者不再创建运行。初始 State 使用持久化 Run 的身份与输入快照，outputs / variables / execution 为空。thread_id 唯一取自 run.threadId；Job 不携带 Definition / State / threadId。Compiler 使用限定本次运行的 Executor 工厂与显式 Checkpointer，复用 Action 策略和 DependencyCompiler，连接根节点 START / 叶节点 END；只支持普通确定性 Action DAG。
invoke 返回后仍调用原生 getState(config)。Runner 检查 result 的 isInterrupted 标记，以及 StateSnapshot.next / tasks；有待执行任务或中断则 markWaiting，不收集最终输出。每次读取快照都解析 State 并核对项目 / 版本 / 运行 / thread 身份；只有没有 pending tasks 的终态才通过 WorkflowOutputResolver 按 definition.outputs 数组的 name 与 source.nodeId / outputKey 收集 RuntimeValue；不保存整个 State.outputs。缺失来源、类型不匹配或异常 checkpoint 明确失败，不返回占位结果。检查依据当前安装的 LangGraph API 与 [StateSnapshot](https://reference.langchain.com/javascript/langchain-langgraph/index/StateSnapshot)，不在 State 增加 isInterrupted 字段。[原生 Interrupts](https://docs.langchain.com/oss/javascript/langgraph/interrupts) 规定暂停和 thread 的关系。

业务 / 图执行错误由 Runner 记录整图 failed 后原样上抛；阶段区分 load_version（首次或恢复执行准备）、compile、invoke、inspect_state、resolve_output，持久化稳定摘要，原始原因保留在异常中。NodeRun 仍由 NodeExecutor 单独维护，节点 completed 不等于整图 completed。版本读取 / 编译失败发生在 claim 后，按既定 running → failed 路径记录，不 invoke，也不新增 pending → failed 转换。claim / markWaiting / markCompleted 自身失败原样作为基础设施异常上抛，不反向 markFailed；markFailed 再失败时 WorkflowRunRecordingError 同时保留原异常与记录异常。正常 interrupt 由 LangGraph 返回暂停快照并投影 waiting；若原生 GraphBubbleUp 异常仍逃出 Graph，则原样交还上层，不猜测其等待状态或记为业务失败。

Runner 不实现 cancel / retry、HumanReviewRecord、SubWorkflow 或 Batch。生产版本读取已有 Prisma 实现和模块，共享服务已有官方 PostgreSQL Checkpointer；API / Worker 已装配生产 Runtime Service，Run HTTP 已接入，Worker 队列消费者已接入，没有内存或 draft 生产兜底。API 集成以真实版本 / 运行 Repository 和官方 saver 验证 Action 编译；独立进程测试另以原生中断测试图验证进程退出后恢复，单元测试仍可显式使用 MemorySaver 和版本替身。

### WorkflowRunner 恢复

ResumeWorkflowRunInput 只接受 workflowRunId 与 unknown value，拒绝调用方覆盖版本、thread 或初始 State。Runner 经 getById 读取原运行并要求 waiting，由实际执行者调用 claimWaitingForResume 原子抢占 running，随后只按 run.workflowVersionId 加载和核对原项目 / 工作流归属、重新编译相同定义；读取时非 waiting 或 claim 返回 null 均抛 WORKFLOW_RUN_NOT_WAITING，竞争失败方不 invoke，也不记录胜者 failed。Prisma 实现在同一事务内以项目 / 所有者 / waiting 为更新条件，更新后读回完整记录，保留首次 startedAt、版本、thread 和输入快照，不使用普通 get → markRunning 代替 claim。

claim 成功后先核对原 checkpoint 的 State、项目 / 版本 / 运行 / thread 身份及 pending tasks，再用 Command({ resume }) 调用 Graph；绝不再次传 initialState，不创建 WorkflowRun 或线程。executeStart 与 executeResume 共用 handleExecutionResult：再次中断记 waiting，END 时解析声明的最终输出并记 completed，普通异常记 failed。恢复准备阶段读取版本或编译失败，也须先成功 claim 才能按 running → failed 记录；竞争失败不能越权写入失败。claim 及最终状态记录自身的基础设施异常继续向上抛，不反向 markFailed。

当前 LangGraph 1.5.0 的 mapCommand 对直接 resume 值使用 truthy 检查，会将 false / 0 / 空字符串 / null 视为空 Command。仅有一个 pending interrupt 且带原生 ID 时，Runner 使用官方支持的 interruptId → value 原生映射传输，既保留原业务值，也避免其对象键被误认为 resume map；不定义或校验审批数据格式。多个中断继续透传 LangGraph 的原生 resume 协议，不在本步增加 Batch 路由。依据见 [原生中断映射](https://docs.langchain.com/oss/javascript/langgraph/interrupts#handling-multiple-interrupts)，没有修改 LangGraph 或在 State 中模拟恢复。

Runner 不查询或关联 interaction NodeRun；Human Review 后续单独定义同一 NodeRun 的 waiting / resume / completed，普通 Action 的执行历史仍归 NodeExecutor。原 checkpoint 缺失、已经 END 或身份不符时，在 invoke 前明确失败，不从新 State 重新开始，不自动重试生成副作用。

### 生产应用装配

API / Worker 的 WorkflowRuntimeModule 导出各自应用 Service。共享 WorkflowRunSubmissionFactory.forProject(ownerId, projectId) 只用版本与运行 Repository 构造提交服务，不创建 Compiler / Checkpointer。共享 WorkflowExecutionService 接收受信任的 WorkflowExecutionJob，核对持久 Outbox、payload 与 waiting 周期后按 workflowRunId 读取项目及当前所有者，再用 WorkflowRuntimeFactory.forProject 构造权限作用域 Runner。三个 Prisma Repository 的每次操作继续检查权限；Worker 不导入 API 实现。

API Service 的 submitStart / submitResume 是可独立调用的提交边界；Worker Service 只提供 execute(job)、executeStart(id)、executeResume(input)，从不创建新运行。内部执行服务不能代替 HTTP 权限检查：HTTP 先验证当前用户与 Version / Run 项目关系，再交付 Job。API 只装配 SubmissionModule / QueueModule，Worker 装配 RuntimeInfrastructureModule、Consumer 与 Outbox Pump。Job 确定性身份和持久 Outbox 防止重复交付，运行 claim 由实际执行者完成，不自动重跑业务副作用。完整故障边界见 [执行队列](architecture.md#workflow-execution-queue)。
共享 WorkflowRuntimeInfrastructureModule 提供真实 Codec / 存储策略 / 最终输出解析，factory 连接精确版本 NodeRegistry、既有 Action Compiler、应用级 PostgresSaver 和按运行创建的 NodeExecutor。编译器仍只支持现有 Action 策略，没有新增 CompilationStrategyRegistry。NodeRegistry 在同一应用的目录与 Runtime 中共享，默认空目录不构成业务执行能力。

ArtifactModule 提供生产内容读写；ArtifactRuntimeFactory 按已授权 owner / project / Run 创建 Codec，注入 ArtifactWriterService、ArtifactDataReferenceResolver 和统一策略。写入 RuntimeValueEncodeContext 由 Executor 增加真实 nodeRunId，Writer 校验来源后登记写入、上传 RustFS 并确认 ready；只有完成确认才返回引用。JSON decode 返回原业务值，blob decode 返回临时 MediaResource，State / NodeRun 仍只记录引用。Asset 尚未实现，明确报 REFERENCE_RESOLUTION_FAILED.cause.code = ASSET_REFERENCE_NOT_CONFIGURED。失败补偿与提交不明语义见 [Artifact 生产数据通道](architecture.md#artifact-生产数据通道)，不返回占位内容或降级 inline。Run HTTP Controller 与 Worker Consumer 已接入，生产 Registry 仍为空。

### Run HTTP 边界

WorkflowRunsController 只从 Actor 取得当前用户，并调用 API WorkflowRuntimeService.startVersion / getRun / resumeRun。start 请求为 { workflowVersionId, inputs }，严格拒绝 projectId / workflowId / threadId / status 等额外字段；服务端按当前用户反查版本归属，submitStart 使用已派生身份创建 pending。get / resume 先按 Run 的项目所有者检查访问权限，权限拒绝不调用 Runner；底层 Repository 仍重新检查。resume 只接受显式 value，null / 0 / false 等不是缺少参数，具体交互数据契约留给未来节点。

所有成功响应使用 WorkflowRunResponse，只公开业务 Run ID、固定版本、状态、RuntimeValue 输入 / 最终输出、稳定错误摘要和 ISO 时间。threadId 仅保留在领域运行、配置适配和 checkpoint 中。资源缺失 / 无权统一 404，非 waiting / 重复恢复意图为 409，队列入队未确认返回安全 503 并保留 Outbox；执行故障由 Worker 写入 Run 稳定摘要供 GET 查询，cause、stack、供应商及数据库文本留在服务端。现有统一 ApiExceptionFilter 负责请求标识和错误 envelope。

HTTP 先事务提交，再经 Dispatcher 确认 enqueue，成功返回 202 与 Run DTO；GET 轮询状态。API 进程不调用 Graph，Worker Consumer 验证 Job 后交给执行服务。队列只传命令、Outbox 保证崩溃后可重投；claim 后结果不明记 recovery_required，不自动重跑。没有基于请求断开取消执行或后台 fire-and-forget 兜底。

## State 与持久化

WorkflowStateAnnotation 与既有 State 接口共处 runtime/state.ts。outputs 使用 mergeNodeOutputs 合并局部 RuntimeValue map，缺省为空；重复 nodeId 写入明确失败。其余分区不由普通 Action wrapper 写入，定义、业务历史、内容存储与执行快照分离，完整规则见 [State 边界](workflow-state.md#并行与历史)。不以对象覆盖或业务状态轮询代替通道。[官方 Graph API](https://docs.langchain.com/oss/javascript/langgraph/graph-api) 说明图和状态机制。

运行配置使用必填 Run.threadId；恢复必须加载原不可变 WorkflowVersion，以兼容实现重建图，接回原 thread 与持久 checkpointer，而不是当前草稿。知道 thread_id 不等于拥有资源权限。已有独立提交服务、executeStart / executeResume 执行协调器与普通 Action 整图编译，已有异步 Run HTTP 与 Worker 队列入口。[官方 Persistence](https://docs.langchain.com/oss/javascript/langgraph/persistence) 说明原生持久化机制。

### PostgreSQL Checkpointer

packages/server 的 WorkflowCheckpointerModule 提供应用级 WorkflowCheckpointerService，API / Worker 经 InfrastructureModule 引入。官方 `@langchain/langgraph-checkpoint-postgres@1.1.0` 的 PostgresSaver 使用独立 pg.Pool，读取同一 DATABASE_URL，在固定 langgraph schema 保存 checkpoint、blobs 和 pending writes；Prisma 仍只管理业务表。平台不实现 BaseCheckpointSaver、序列化或 checkpoint 表迁移。具体 API 以安装包类型 / 实现和[官方 PostgreSQL 使用说明](https://docs.langchain.com/oss/javascript/langgraph/add-memory#postgres)为准。

Nest 初始化期间先获取数据库级 advisory transaction lock，串行调用官方 setup() 并经 getTuple() 验证读取，完成后才开放 service.saver。setup 的 DDL 仍由官方实现执行；锁只防止 API / Worker 多实例同时初始化官方迁移。失败抛 WORKFLOW_CHECKPOINT_UNAVAILABLE 并关闭池，应用不得就绪；健康检查通过官方读取路径探测，应用关闭调用官方 end()。Compiler 仅接收 BaseCheckpointSaver 并传给 graph.compile，Runner.executeStart / executeResume 不创建 saver 或执行 setup，也不降级到内存。

多个进程的 Saver 对象与连接池相互独立，恢复依赖相同数据库 / schema、原 threadId 和原 WorkflowVersion。进程退出后数据仍在 PostgreSQL；两个新进程竞争同一 waiting Run 时，业务 Repository 的原子 claim 只允许一个进入 invoke。Checkpoint 与 WorkflowRun / NodeRun 分属不同持久化路径，不承诺跨两者原子提交；故障后的对账及业务删除后的 checkpoint 保留策略仍需单独设计。初始化权限、备份和验证见 [部署说明](deployment.md#langgraph-postgresql-checkpointer)与[开发指南](development.md)。

## 人工介入、并行与副作用

人工介入继续使用 interrupt / Command.resume，不能吞掉中断控制异常或把它记为普通失败；恢复可能使节点从开头重入。审核决策是独立业务审计，waiting 仅业务投影；生成副作用与审核分离，受理结果不明不盲目重试，不承诺外部 exactly-once。[官方 Interrupts](https://docs.langchain.com/oss/javascript/langgraph/interrupts) 描述原生规则。

Data Edge 保存值来源，Control Edge 保存显式执行先后；定义层的联合 DAG 只检查无环，执行依赖由独立收集函数生成。普通确定性 fan-in 遵循上述 ALL Join，条件分支、Send、Batch 与子图的精确映射留待各自结构策略。单次图调用 maxConcurrency 位于顶层配置；跨运行与供应商配额由后续 Queue / Worker 处理，不把 Send 当作全部容量控制。[官方 Graph API 示例](https://docs.langchain.com/oss/javascript/langgraph/use-graph-api) 展示这些执行机制。

当前没有控制 / 交互结构策略或模型调用、审核或内容 Store。生产节点目录仍为空；首次启动基础库不代表已有真实生成服务，不得将测试适配、类型接口或规划标为可用业务能力。
