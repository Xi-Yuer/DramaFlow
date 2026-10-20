# 当前架构与目录职责

DramaFlow 是面向团队自部署的 AI 视频生产工作流平台，漫剧优先。顶层概念见 [平台模型](platform-model.md)，定义与运行见 [Workflow](workflow-model.md)，节点见 [Node](node-model.md)，技术职责见 [Runtime 架构](runtime-architecture.md)，下一步见 [实施方案](implementation-plan.md)。本文只维护实际能力与目录边界。

## 已实现的基础工程

应用已有登录、平台鉴权、账户中心、项目管理和 React Flow 画布。画布注册通用节点 renderer、查询真实节点目录，并接入 Data / Control Edge 连线、重连与删除事件。目前目录为空，没有添加节点、Workflow 保存 / 发布入口、模型生成、工作流运行或业务对话。

Next.js 使用 App Router、Ant Design 深色主题和 TanStack Query。认证通过同源代理接入 NestJS Better Auth 白名单入口，业务 API 默认受真实全局 AuthGuard 保护。PostgreSQL / Prisma 保存身份、资料、凭证、会话、认证限流、基础项目、Workflow / WorkflowVersion 及 WorkflowRun / NodeRun 业务记录；Redis 与 RustFS 提供基础服务。会话与角色边界见 [认证实施](authentication.md)。

每项目恰好一张画布。项目保存所有者、名称、视口、revision 和时间，不保存节点、绑定或 WorkflowDefinition；读取与写入按所有者隔离。列表按更新时间与 id 倒序，游标保存毫秒精度更新时间和 id，并校验长度、编码与字段；相同更新时间用 id 确定边界。分页读取当前列表，不建立跨请求数据库快照。原子更新检查 revision，冲突返回 409。revision 是项目保存的修订号，不是工作流发布版本。目录与渲染器接入没有改变项目保存协议或数据库。

项目 API 为 GET / POST /api/v1/projects、GET / PUT /api/v1/projects/:id。新增 GET /api/v1/workflow/node-types 默认认证，响应 Cache-Control: no-store。NodeTypesModule 导出服务端 Registry 供后续显式注册；当前返回真实空数组，没有注册占位 LLM / 视频类型。

worker 仍是独立 NestJS 应用上下文，通过 `@dramaflow/server` 复用数据库、Redis 与对象存储，不消费业务队列；plugins、context 保留空入口。LangGraph 普通节点适配在基础库验证，未接入运行 API / worker，LangChain 模型调用与供应商适配未实现。

## Workflow 基础库

contracts 的 `workflow/metadata.ts` 保留元数据、版本 / 运行元数据、六种运行状态、输出来源与显式 createWorkflowSchemas 工厂。调用方提供 DataType、Node、Edge Schema，组合器检查顶层字段、名称 / 节点 ID 唯一及最终输出来源节点；不强迫通用调用方采用具体节点协议。

正式 workflowDefinitionSchema 使用当前 DataType、NodeDefinition 与 WorkflowEdge 组合，保留 inputs / nodes / edges / outputs。WorkflowEdge 包含 DataEdgeDefinition 与 ControlEdgeDefinition，以 kind 区分值来源和显式执行先后，两类边均保存在 edges。Data Edge 两端必填 nodeId / portKey；Control Edge 两端必填 nodeId、可选 portKey，不自动随数据连接创建控制边。Schema 检查全局边 ID 唯一、两端节点、workflow_input 名称、自连接与数据 / 控制联合 DAG；只有 Data Edge 检查目标数据端口单连接及静态 Binding 冲突。

Node.inputs 只接受 constant / workflow_input / asset 三类 StaticInputBinding，不保存 ConnectionBinding。Control Edge 不占用 inputs，允许多个控制上游；当前 Data / Control Edge 均产生确定性执行依赖。正式静态校验不访问 Registry，因此不判断端口或配置契约是否存在，不做类型兼容、资源权限或资产访问，也不解析运行值。联合 DAG 只验证无环，不承担依赖收集、完整发布或执行校验。

workflow 包已有 parseWorkflowInputs、collectWorkflowOutputs、createWorkflowVersionSnapshot、assertWorkflowRunVersion：按显式 Zod 契约校验值、按声明来源收集最终结果、复制并冻结 JSON 快照、检查运行版本身份。这些函数不发布版本或创建运行；快照只保证内存隔离，不替代数据库不可变性、权限与并发控制。

数据库 workflow 保存 draft JSON、revision、名称及时间，以 projectId 唯一约束落实每项目一个逻辑 Workflow。workflow_version 每条保存完整 WorkflowDefinition JSON，不引用 draft 或保存差量；workflowId / version 唯一，数据库触发器禁止更新版本身份、归属、编号、时间与定义，父级删除按外键级联。revision 当前仅有字段和正数约束，没有草稿乐观锁或并发发布分配器。API 的 WorkflowVersionRepositories.forProject 返回限定项目 / 所有者的只读 PrismaWorkflowVersionRepository，每次查询重新检查权限，经 workflowVersionRecordSchema 校验并把 createdAt 映射为 publishedAt；不存在或无权访问返回 null，不回退 draft / latest。模块已注册并导出工厂，没有发布或运行 HTTP 入口。

`packages/workflow/src/compiler/dependency.compiler.ts` 导出 collectNodeDependencies：接收当前 WorkflowEdge 列表，Data / Control Edge 均按两端 nodeId 收集执行依赖，按 target 聚合、按 source 去重并保留首次出现顺序，输出 NodeDependency。同一节点对的不同端口数据边及重复 Data / Control 关系只形成一个上游。DependencyCompiler.compile 直接接收 edges 并调用收集函数，单上游生成字符串 addEdge，多上游只生成一条数组 addEdge（ALL Join），不会拆成多个独立触发边。它保留原始边，不读取或修改 portKey、不获取输出或构造输入；这些仍属 BindingResolver / NodeExecutor。真实 LangGraph 测试覆盖混合边去重后的两种完成顺序、不同路径长度、仅执行一次和上游失败；测试另验证端口不被读取及冻结边保持完整。不新增 NodeDefinition.joinMode 或平台 Join Runtime。If / Switch / Conditional Edge / Send / Batch 候选分支不适用；普通 Action 整图组装复用此 Compiler，生产运行入口尚未接入。

compiler/workflow-compiler.ts 提供普通 Action 的 WorkflowCompiler / DefaultWorkflowCompiler，复制并冻结领域定义，复用 Registry 精确版本、Action 策略与 DependencyCompiler，连接根节点到 START、叶节点到 END，空定义直接结束。调用方显式注入 Checkpointer 与按运行限定权限的 Executor 工厂；Compiler 不生成 thread、不写运行状态、不处理候选分支。真实 LangGraph 用例验证完整 A/B → C 在两种完成顺序下保留 ALL Join 与双方 State 输出。

run/workflow-runner.ts 提供 DefaultWorkflowRunner.start / resume，是 WorkflowRun 执行的生命周期协调器。请求只接受项目 / 工作流 / 明确版本 ID 和 RuntimeValue 输入；从 WorkflowVersionRepository.getVersion 读取含归属的版本记录，校验三重身份并递归冻结定义后创建 pending，再编译、markRunning 和 invoke。初始 State 使用已保存运行的身份与输入快照，thread_id 来自独立 run.threadId。返回结果只包含 workflowRunId、threadId、waiting / completed 和成功时的对外输出，不伪造 Repository 未返回的运行时间。

Runner 在 invoke 返回后检查原生 StateSnapshot 的 next / tasks 与 isInterrupted，并核对快照的运行 / 版本 / 项目 / thread。存在待执行任务时仅 markWaiting；没有待执行任务时由 WorkflowOutputResolver 按声明名称及 source.nodeId / outputKey 收集 RuntimeValue，检查缺失来源与类型兼容，再 markCompleted。原有 collectWorkflowOutputs 是业务值 Zod 工具，不承担 RuntimeValue / checkpoint 解析。Node / Graph 失败记录整图稳定摘要后原样抛回；编译失败按既定 pending → running → failed 记录。记录服务本身失败不反向 markFailed，双重失败保留两种原因。生命周期不放进 Compiler 或 NodeExecutor，规则见 [Runtime](runtime-architecture.md#workflowrunner-首次启动)。

resume 只接受 workflowRunId 与 unknown value，getById 校验 waiting 后按原版本编译，通过 claimWaitingForResume 原子转为 running；非 waiting 或 claim 竞争失败报 WORKFLOW_RUN_NOT_WAITING 且不 invoke。Prisma 的读取和 claim 继续按项目 / 所有者过滤；claim 在事务中有条件更新后读回完整记录，保留 startedAt 与身份。恢复前先检查原 checkpoint，再传 Command，不传 initialState、不新建 Run 或线程；与 start 共用结果分类、最终输出解析及状态落库逻辑。再次暂停可回 waiting，错误由已 claim 的调用方写 failed。Runner 不查询 interaction NodeRun；其 waiting / resume 关联仍独立设计。当前 LangGraph 对 falsy resume 的行为以单个原生 interrupt ID 映射适配，interaction node 接收的业务值不变，细节见 [恢复边界](runtime-architecture.md#workflowrunner-恢复)。

版本读取已有生产 Prisma 实现，并用于真实 PostgreSQL / LangGraph 的 Runner 集成；生产 Runner 装配、节点目录、持久 Checkpointer 与运行 API / worker 服务仍未接入。MemorySaver 和测试节点仅用于测试，不构成生产兜底。版本测试显式写入完整快照，验证 A → Version 1、草稿改 B → Version 2 后旧版本不变，以及新 Repository / 独立数据库连接读取、更新拒绝、唯一约束、权限和无效定义拒绝；这些建数步骤不是发布服务。Runner 集成覆盖首次成功、节点失败、原生暂停、输出 / 编译失败、连续恢复和并发 claim；原有 Run Repository 并发与权限边界保持独立。

## 数据与 Node 基础库

contracts/data 提供正式 DataType、builtin 类型常量、共享 isTypeAssignable、DataTypeManifest、RuntimeValue 与 DataReference。primitive / named / array / object / union / any 描述语义类型；inline / reference 描述运行值承载。数组元素用 itemType；兼容规则包含递归数组、Union 全来源覆盖和对象结构子集，any 仅放宽目标。

contracts/content 提供 Artifact 与版本化 Asset 的共享协议；Artifact 引用不可变产物 ID，AssetReference / AssetBinding 固定 versionId。没有对应数据库表、上传、Promote 或引用读取服务。详细类型与生命周期见 [数据模型](data-model.md)。

服务端 DataTypeRegistry 按名称注册 Manifest + Zod，拒绝重复及未知名称；schemaFor / parse 递归检查实际 JSON 值。目录只返回独立 Manifest 副本，未注册虚构媒体实现，也未接入类型目录 API。

NodeTypeManifest 增加必填 executionKind：action / control / composite / interaction。NodeType 改为 execute(input, config, context)，不再自行 compile。NodeRegistry 仍精确匹配 type / version，并固定实现读取的 Manifest；普通 action 提供 execute，其他种类声明由独立结构策略处理，生产目录仍为空。

createOperationNodeType 只组合 Manifest、三组 Zod 与 operation。parseNodeDefinition、applyNodePreset、invokeNodeOperation 保留独立值契约校验，Preset 不改变运行身份，转换与默认值不回写定义。assertNodeSchemas 检查字段集合和默认值，不证明任意 Schema 与语义类型完全等价。

ActionNodeCompilationStrategy 校验精确类型版本、复制定义并只生成调用 NodeExecutor 的函数包装。上下文工厂提供 workflow 与可选能力 / 运行配置，包装注入当前 WorkflowState，并从 state.run 取得 projectId / workflowRunId。节点等待 Executor 完成后只返回 `{ outputs: { [node.id]: result.output } }` 的 WorkflowStateUpdate，不展开旧 outputs，不解析 Binding、业务 Schema 或 Artifact；Executor 失败原样传播。DefaultWorkflowCompiler 复用该包装，结构策略尚未接入；编译不执行业务、不管理运行状态或暂停恢复。

runtime/state.ts 在既有接口旁导出 WorkflowStateAnnotation。run / inputs / variables / execution 为单值通道，outputs 使用 mergeNodeOutputs，default 生成空 map。reducer 只合并不同节点的自有键，重复 nodeId 抛 DuplicateNodeOutputWriteError（DUPLICATE_NODE_OUTPUT_WRITE），不修改原 map。标准 reducer 无 step 身份，本步普通 DAG 因而拒绝对所有已有键的隐式覆盖；重执行的新 effective output 仍须显式语义。真实 StateGraph 测试用现有 DependencyCompiler、Action 策略、Executor、BindingResolver 与 Codec 验证 A/B 两种完成顺序后 C 读到双方输出并只执行一次；另覆盖通道初始化、同一步冲突、跨 step 覆盖拒绝及原型相关键。

runtime/binding-resolver.ts 已实现 resolveDataEdgeInputs 和无参数 createBindingResolver。BindingResolver.resolveInputs 接收 node / nodeType / edges / state，按传入 Manifest 的 inputs 索引校验已绑定目标端口，只读取当前目标的数据边，将上游指定输出原样映射为目标输入 RuntimeValue。三类静态 Binding 使用实际实现：constant 按端口 dataType 包装为 inline；workflow_input 按既有 key 直接复用 State.inputs 的 RuntimeValue；asset 按端口类型生成包含 assetId / versionId 的 reference，不查内容或最新版。未重新引入 ConnectionBinding，也不 decode、调用 NodeType、Zod 或持久化 Artifact，Resolver 没有数据库、对象存储或网络依赖。

BindingResolutionError 包含 INPUT_SOURCE_CONFLICT、SOURCE_NODE_OUTPUT_MISSING、WORKFLOW_INPUT_MISSING、INPUT_PORT_NOT_FOUND；details 提供节点、输入键及可选边、来源端口或工作流输入键。正式 WorkflowDefinition 的两种输入冲突校验继续在 issue.params.code 标记 INPUT_SOURCE_CONFLICT。测试覆盖四类来源真实合并、端口声明类型、空值 / 数组等常量、inline / reference 工作流输入的身份保留、固定资产版本及四类错误，使用真实静态转换实现。

runtime/runtime-value-codec.ts 提供统一 RuntimeValueCodec 和 DefaultRuntimeValueCodec，显式注入 DataReferenceResolver、ArtifactWriter 与 DataStoragePolicyResolver。decode 对 inline 原样返回，reference 委托引用服务；decodeRecord 并行解码自有键，引用失败以 ReferenceResolutionError / REFERENCE_RESOLUTION_FAILED 保留 reference 和 cause。encode 接收 DataType、存储策略及项目 / 运行 / 节点 / 输出键定位；inline 校验 JSON 承载后包装，reference 经 ArtifactWriter 写入并验证返回的 ArtifactReference。Codec 不依赖数据库或对象存储实现，不拼接 URL，不执行业务 Schema。data-reference-resolver.ts 保留 MediaResource，value-codec.ts 仅保留通用 RuntimeValueContext，不再另设输出 Encoder。

OutputPortDefinition 增加可选 storagePolicy，复用既有 DataStoragePolicy；省略时 Executor 使用 auto。data-storage-policy-resolver.ts 提供统一接口及默认类型规则：primitive / system.json / story.character / story.scene 内联，media.file / image / video / audio / document 引用；规则表可显式扩展。未注册 named 及结构类型的 auto 明确失败，不用 JSON 大小猜测。artifact-writer.ts 仅定义写入接口，携带声明类型及输出来源，未接入实际 Artifact 创建或对象存储写入。

runtime/node-executor.ts 提供 DefaultNodeExecutor，显式注入 Registry、BindingResolver、Codec 与 NodeRunRepository。先 createRunning，再 getAction、绑定、updateInputs、decodeRecord、输入 / 配置校验、业务调用、输出校验和逐端口 encode；markCompleted 确认成功后才返回 `{ output: Record<string, RuntimeValue> }`，不修改 WorkflowState。不按业务 type 分支，不直接操作数据库或对象存储，NodeRun 持久化只经注入 Repository，不重试或实现审核。编码失败停止后续输出，不返回部分结果；前序已写入的 Artifact 不由 Executor 自动回滚。

node-execution-error.ts 提供 NodeExecutionError，保留 nodeId、nodeType、stage、code 和 cause。Executor 记录的业务阶段为 resolve_input / decode_input / validate_input / validate_config / execute / validate_output / encode_output；输出编码及 Writer 失败使用 NODE_OUTPUT_ENCODING_FAILED，与输出业务校验区分。业务管线异常按准确阶段先 markFailed 再抛出；创建、输入记录与完成记录方法均在该 catch 外，Repository 故障保留原始异常上抛，不反向 markFailed。失败记录写入也失败时沿用 NodeRunRecordingError，同时保留原 cause 与 recordingError。GraphBubbleUp 原样传播、记录保持 running，不记 failed；普通 Action 不得主动 interrupt，恢复关联未实现。测试用真实 Registry / BindingResolver / Codec 验证 math.add、Schema 转换后编码、三类真实 Binding 错误的 resolve_input 阶段、业务失败记录、三个 Repository 方法故障原样上抛、等待完成记录确认及 State 不变；测试视频输出得到 Artifact 引用和内联 duration，检查 Writer 上下文与失败停止。独立 TestState / MemorySaver 仅验证原生中断与 Command 恢复，不代表生产 Checkpoint 或审核服务。

DataReferenceResolver、ArtifactWriter 与内容 Store 仍只有服务接口，真实内容读写、项目授权、版本检查及 signed URL 未接入。math.add 与视频节点仅在测试注册，生产目录为空。State.outputs 使用 NodeOutputMap，execution 保留为空；已提供 outputs 通道与 Action 增量适配，没有内容持久化、生产 checkpointer 或完整图运行服务，不提供内存 / 本地存储降级。

createWorkflowRunConfig 使用显式 Run.threadId，不从 Run.id 推断或允许其他配置覆盖，不创建运行或 checkpointer。contracts/workflow/node-run.ts 独立定义 NodeRun 的三状态、必填 ISO 开始时间、RuntimeValue inputs / outputs 和结构化错误，并从包入口导出。NodeRunError.stage 为非空字符串，code 可省略，不绑定 Runtime 的阶段枚举；NodeExecutionStage 仅在 workflow/runtime/node-execution-error.ts 内维护。run/node-run-repository.ts 定义 Repository 抽象，createRunning 只接收 workflowRunId / nodeId，不接收 attempt 或数据库字段；Executor 只依赖该抽象。

API 的 workflow/node-runs 模块提供 NodeRunRepositories.forRun(ownerId, projectId, workflowRunId)，验证同项目真实父运行和所有者，返回限定项目 / 运行的 PostgreSQL Repository。projectId 来自该工厂作用域，不属于 CreateNodeRunInput。写入继续过滤所有者、项目、运行和 running 状态；输入只写一次，终态不可改写。createRunning 在 ReadCommitted 事务中按运行 / 节点获取 PostgreSQL advisory transaction lock 后分配 attempt，并受唯一约束保护。Prisma NodeRun 使用 String status，数据库继续约束三状态及终态字段一致性，包含 workflowRunId 和 workflowRunId / nodeId 索引。node_run 关联 canvas_project，并以 workflowRunId / projectId 复合外键关联 workflow_run，防止跨项目归属；删除父运行级联删除节点历史。

contracts/workflow/workflow-run.ts 在既有元数据上补全 WorkflowRun，保存项目、明确版本、独立 threadId、六种状态、RuntimeValue inputs / 最终 outputs、结构化错误和 ISO 时间。run/workflow-run-repository.ts 定义 create、getById、claimWaitingForResume 与五种明确状态操作，不暴露 updateStatus 或数据库实现。API 的 WorkflowRunRepositories.forProject(ownerId, projectId) 返回有权限作用域的 Prisma Repository；创建固定 pending、输入与版本，分别生成 id / threadId，所有写入继续检查所有者与项目。markRunning 首次写 startedAt，waiting 恢复保留它；其余操作以当前合法状态作为原子更新条件，终态不改写。数据库约束字段一致性、threadId 唯一、不可变身份 / 版本 / 输入及合法转换，规则见 [WorkflowRun](workflow-model.md#workflowrun一次实际运行)。Run 的 workflowId / workflowVersionId 暂保留逻辑引用，本轮版本建模不调整运行外键；Runner 经真实版本 Repository 核对项目 / 工作流 / 版本归属。start / resume 尚无生产运行 HTTP / worker 入口或 Human Review 接入。

WorkflowRun 测试检查协议 JSON 往返、输入输出 RuntimeValue map、独立 thread 与 ISO 时间；真实隔离 PostgreSQL 覆盖创建、等待再运行、首次时间保留、30 组状态操作、终态并发竞争、版本不可改、thread 唯一、权限隔离、同项目 NodeRun 外键与级联删除。记录中的最终输出只含调用方提交的对外 RuntimeValue map，Repository 不执行最终结果收集或业务 Schema 校验。

真实隔离 PostgreSQL 测试覆盖仅用两个创建字段连续得到 attempt 1/2、可省略错误码及可扩展阶段，并覆盖视频节点首次失败、第二次成功的两条历史与有效 State 输出、Binding 失败无输入快照、12 次并发 attempt、数据库唯一约束、终态不可覆盖及项目 / 运行权限隔离。完成记录不可用的故障注入用例验证业务已成功时不会调用 markFailed，已创建的 running 记录和输入保留，且不写 State。内容 Resolver / Writer 仍显式使用测试替身；这些用例不证明真实视频或 Artifact 持久化。

## React Flow 数据适配

react-flow-adapter.ts 提供整图转换与节点白名单映射。React Flow type 使用 workflowNode renderer，领域类型版本在 data.nodeType / data.typeVersion，位置对应必填 ui.position；selected、dragging、measured 不回写 DSL。

Workflow.edges 是节点间连接的唯一来源。Data Edge 的 id、source.nodeId / portKey、target.nodeId / portKey 与 React Flow 的 id、source / sourceHandle、target / targetHandle 无损往返；数据 Handle.id 必须等于对应 Manifest 端口 key。新增数据连接对照 Manifest 检查精确类型版本、节点与端口存在、共享 isTypeAssignable、自连接及目标已有数据边，再创建 DataEdgeDefinition；显式连接可移除目标静态 Binding，数组输入同样至多一条数据边，不自动聚合多连接。目录查询与显式数据连线共用目录 Schema，拒绝重复 type / version。

controlEdgeToReactFlowEdge 使用 edge.data.kind=control 区分控制边，默认控制 Handle 为 `control:source` / `control:target`，命名端口映射到 `control:source:approved` 等保留命名空间，避免与数据端口 key 冲突；领域仅保存可选实际 portKey，不保存默认 UI 控制 Handle。两类边都保留 ID 与端点，连接只允许 Data → Data 或 Control → Control。断连和重连核对种类及完整旧边快照，防止过期事件修改新连接；连接辅助函数不做运行值校验或调度。

GenericWorkflowNode 根据精确类型版本 Manifest 自动生成数据 Handle、显示端口类型与配置摘要，并提供普通控制出入口；缺失版本显示不可用，图标采用受控映射。命名控制端口只有结构与转换支持，尚无对应 Manifest、路由交互或 Branch 实现。画布以本地 WorkflowDefinition 派生 React Flow nodes / edges，onConnect / onReconnect / onEdgesDelete 使用上述适配操作；已注册 renderer、加载目录并处理加载 / 错误 / 空态。生产目录仍为空，没有节点添加和 Workflow 保存入口。项目保存按钮仍只处理名称、视口及 revision。

## 目录与依赖

| 目录               | 当前职责                                             | 后续边界                               |
| ------------------ | ---------------------------------------------------- | -------------------------------------- |
| apps/web           | 身份、账户、项目画布、目录查询、通用 renderer 与适配 | 创作交互，不加载服务端插件或密钥       |
| apps/api           | 认证、资料、项目和节点目录                           | 模块化业务入口、权限与应用服务         |
| apps/worker        | 独立进程，只接入共享基础设施                         | 独立执行进程，不自建图调度语义         |
| packages/server    | 数据库、Redis、对象存储和凭证加密                    | 不包含 HTTP、认证或业务流程            |
| packages/contracts | 身份、项目、Workflow 与 Node 的中立 JSON 协议        | 不依赖前端、数据库或 Runtime 框架      |
| packages/database  | Prisma 与身份、基础项目和运行记录持久化              | 模型、迁移按实际业务增加               |
| packages/workflow  | 值契约、数据 / 节点 Registry、运行接口及编译包装     | 先确定 Graph Model，再接入执行与持久化 |
| packages/plugins   | 空入口，保留模型 SDK                                 | 受信任外部能力，无隐式供应商选择       |
| packages/context   | 空入口                                               | 独立构建明确选择的上下文               |

不为附件目录示意重命名为 common / client，不为未来概念建立空壳执行器。API 与 worker 通过服务和契约协作；第三方类型在适配层转换，不进入 contracts。

contracts/src 的 identity.ts 与 project.ts 分别承载身份与项目协议，workflow/ 和 node/ 承载工作流与节点协议，NodeRun / WorkflowRun 领域记录各归 workflow/ 下同名文件，data/ 和 content/ 承载值与内容协议。workflow/src 分为 definition/、data/、node/、runtime/、compiler/、run/；server/src 分为 database/、redis/、storage/、secrets/。API 的 health/ 与 http/ 保留 HTTP 职责，基础设施不反向依赖 API，worker 不再依赖 API 应用包。

LangGraph 是核心 Runtime，平台不再建设图调度、Checkpoint 或暂停恢复状态机。Queue / Worker 后续处理长异步作业、跨运行与供应商限流，不决定图中下一个节点。一个项目一个逻辑 Workflow 的边界不变，子流程只引用其他项目固定版本；当前没有对应持久化、发布或运行应用接口。
