# 当前架构与目录职责

DramaFlow 是面向团队自部署的 AI 视频生产工作流平台，漫剧优先。顶层概念见 [平台模型](platform-model.md)，定义与运行见 [Workflow](workflow-model.md)，节点见 [Node](node-model.md)，技术职责见 [Runtime 架构](runtime-architecture.md)，下一步见 [实施方案](implementation-plan.md)。本文只维护实际能力与目录边界。

## 已实现的基础工程

应用已有登录、平台鉴权、账户中心、项目管理和 React Flow 画布。画布注册通用节点 renderer、查询真实节点目录，并接入 Data / Control Edge 连线、重连与删除事件。目录已有正式文本生成节点；画布已加载并保存真实 Workflow Draft，支持节点位置和连线编辑；已有项目内模型管理抽屉；没有添加节点、节点模型选择、发布或运行交互，没有业务对话。

Next.js 使用 App Router、Ant Design 深色主题和 TanStack Query。认证通过同源代理接入 NestJS Better Auth 白名单入口，业务 API 默认受真实全局 AuthGuard 保护。PostgreSQL / Prisma 保存身份、资料、凭证、会话、认证限流、基础项目、Workflow / WorkflowVersion 及 WorkflowRun / NodeRun 业务记录；Redis 与 RustFS 提供基础服务。会话与角色边界见 [认证实施](authentication.md)。

每项目恰好一张画布。项目保存所有者、名称、视口、revision 和时间，不保存节点、绑定或 WorkflowDefinition；读取与写入按所有者隔离。列表按更新时间与 id 倒序，游标保存毫秒精度更新时间和 id，并校验长度、编码与字段；相同更新时间用 id 确定边界。分页读取当前列表，不建立跨请求数据库快照。原子更新检查 revision，冲突返回 409。Project revision、Workflow 草稿 revision 和发布 version 各自独立。新建项目通过 Prisma 嵌套写入原子创建默认 Workflow，任一创建失败都回滚；Project 请求和响应不嵌入 Workflow，保存项目仍只修改名称与视口。

项目 API 为 GET / POST /api/v1/projects、GET / PUT /api/v1/projects/:id。GET /api/v1/workflow/node-types 默认认证，响应 Cache-Control: no-store。NodeTypesModule 复用共享 WorkflowNodeRegistryModule，与本应用 Runtime 共用服务端 Registry；当前注册正式 `ai.text_generate@1`，只返回 JSON Manifest，不公开实现、配置实例或密钥。

worker 是独立 NestJS 应用上下文，通过 `@dramaflow/server` 复用基础设施，运行 Outbox Pump 和 BullMQ Consumer。异步 Run HTTP 只提交，Graph 在 Worker 执行；正式文本节点通过 packages/plugins 的受信任适配器使用 LangChain 调用配置模型。context 包仍为空入口。

## Workflow 基础库

contracts 的 `workflow/metadata.ts` 保留元数据、版本 / 运行元数据、六种运行状态、输出来源与显式 createWorkflowSchemas 工厂。调用方提供 DataType、Node、Edge Schema，组合器检查顶层字段、名称 / 节点 ID 唯一及最终输出来源节点；不强迫通用调用方采用具体节点协议。

正式 workflowDefinitionSchema 使用当前 DataType、NodeDefinition 与 WorkflowEdge 组合，保留 inputs / nodes / edges / outputs。WorkflowEdge 包含 DataEdgeDefinition 与 ControlEdgeDefinition，以 kind 区分值来源和显式执行先后，两类边均保存在 edges。Data Edge 两端必填 nodeId / portKey；Control Edge 两端必填 nodeId、可选 portKey，不自动随数据连接创建控制边。Schema 检查全局边 ID 唯一、两端节点、workflow_input 名称、自连接与数据 / 控制联合 DAG；只有 Data Edge 检查目标数据端口单连接及静态 Binding 冲突。

Node.inputs 只接受 constant / workflow_input / asset 三类 StaticInputBinding，不保存 ConnectionBinding。Control Edge 不占用 inputs，允许多个控制上游；当前 Data / Control Edge 均产生确定性执行依赖。正式静态校验不访问 Registry，因此不判断端口或配置契约是否存在，不做类型兼容、资源权限或资产访问，也不解析运行值。联合 DAG 只验证无环，不承担依赖收集、完整发布或执行校验。

workflow 包已有 parseWorkflowInputs、collectWorkflowOutputs、createWorkflowVersionSnapshot、assertWorkflowRunVersion：按显式 Zod 契约校验值、按声明来源收集最终结果、复制并冻结 JSON 快照、检查运行版本身份。这些函数不发布版本或创建运行；快照只保证内存隔离，不替代数据库不可变性、权限与并发控制。

数据库 workflow 保存 draft JSON、revision、名称及时间，以 projectId 唯一约束落实每项目一个逻辑 Workflow。workflow_version 每条保存完整 WorkflowDefinition JSON，不引用 draft 或保存差量；workflowId / version 与 workflowId / sourceRevision 分别唯一，同一草稿修订只能产生一个版本。sourceRevision 必填且为正数，数据库触发器禁止更新版本的所有字段，父级删除按外键级联。共享服务的 WorkflowVersionRepositories.forProject 返回限定项目 / 所有者的只读 PrismaWorkflowVersionRepository，每次查询重新检查权限，经 workflowVersionRecordSchema 校验并把 createdAt 映射为 publishedAt；不存在或无权访问返回 null，不回退 draft / latest。

API 的 workflows/WorkflowService 提供 updateDraft 与 publish。updateDraft 按所有者和 expectedRevision 原子更新完整草稿；已注册 Action 只检查允许的配置字段，不要求模型和必填输入已经填写，未知类型也可保留在编辑草稿。Publish 在 ReadCommitted 事务内锁定 Workflow，检查来源修订与重复发布，再按正式 Definition、Registry、Node Schema 和本地模型配置严格验证，通过后才分配 max(version) + 1 并写入完整快照。失败不产生版本、不消耗版本号、不改变 draft / revision；来源修订冲突及同修订重复发布仍分别返回 WORKFLOW_REVISION_CONFLICT / WORKFLOW_REVISION_ALREADY_PUBLISHED。发布和版本 HTTP 见下文。

`packages/workflow/src/compiler/dependency.compiler.ts` 导出 collectNodeDependencies：接收当前 WorkflowEdge 列表，Data / Control Edge 均按两端 nodeId 收集执行依赖，按 target 聚合、按 source 去重并保留首次出现顺序，输出 NodeDependency。同一节点对的不同端口数据边及重复 Data / Control 关系只形成一个上游。DependencyCompiler.compile 直接接收 edges 并调用收集函数，单上游生成字符串 addEdge，多上游只生成一条数组 addEdge（ALL Join），不会拆成多个独立触发边。它保留原始边，不读取或修改 portKey、不获取输出或构造输入；这些仍属 BindingResolver / NodeExecutor。真实 LangGraph 测试覆盖混合边去重后的两种完成顺序、不同路径长度、仅执行一次和上游失败；测试另验证端口不被读取及冻结边保持完整。不新增 NodeDefinition.joinMode 或平台 Join Runtime。If / Switch / Conditional Edge / Send / Batch 候选分支不适用；普通 Action 整图组装复用此 Compiler，运行 HTTP 与执行队列已接入。

compiler/workflow-compiler.ts 提供普通 Action 的 WorkflowCompiler / DefaultWorkflowCompiler，复制并冻结领域定义，复用 Registry 精确版本、Action 策略与 DependencyCompiler，连接根节点到 START、叶节点到 END，空定义直接结束。调用方显式注入 Checkpointer 与按运行限定权限的 Executor 工厂；Compiler 不生成 thread、不写运行状态、不处理候选分支。真实 LangGraph 用例验证完整 A/B → C 在两种完成顺序下保留 ALL Join 与双方 State 输出。

run/workflow-run-submission.ts 提供 DefaultWorkflowRunSubmissionService：start 校验明确版本与项目 / 工作流归属后通过 createWithExecution 在同一 PostgreSQL 事务写入 pending Run 与 start Outbox；resume 在 Run 行锁下校验 waiting，按本轮 waitingRevision 创建恢复意图，不修改 Run 状态。提交只依赖版本 / 运行 Repository，不编译或调用 Graph。contracts/workflow/workflow-execution-job.ts 定义严格的 start / resume Job，只携带 workflowRunId，resume 另有由 Outbox 分配的 executionId / unknown value，不复制 Definition、State、版本或 thread。

run/workflow-runner.ts 提供 DefaultWorkflowRunner.executeStart / executeResume，只执行已存在的 Run。executeStart 读取 pending，原子 claimPendingForStart 转 running 并写 startedAt；竞争失败报 WORKFLOW_RUN_NOT_PENDING，不加载版本或执行 Graph。抢占后重新读取原 workflowVersionId、核对归属并冻结定义，再编译、invoke；初始 State 与 thread_id 唯一取自已保存的运行及输入快照，不创建新 Run。
Runner 在 invoke 返回后检查原生 StateSnapshot 的 next / tasks 与 isInterrupted，并核对快照的运行 / 版本 / 项目 / thread。存在待执行任务时仅 markWaiting；没有待执行任务时由 WorkflowOutputResolver 按声明名称及 source.nodeId / outputKey 收集 RuntimeValue，检查缺失来源与类型兼容，再 markCompleted。原有 collectWorkflowOutputs 是业务值 Zod 工具，不承担 RuntimeValue / checkpoint 解析。Node / Graph 失败记录整图稳定摘要后原样抛回；版本读取 / 编译失败在成功 claim 后按 running → failed 记录。记录服务本身失败不反向 markFailed，双重失败保留两种原因。生命周期不放进 Compiler 或 NodeExecutor，规则见 [Runtime](runtime-architecture.md#workflowrunner-首次启动)。

executeResume 只接受 workflowRunId 与 unknown value，getById 校验 waiting 后通过 claimWaitingForResume 原子转为 running，再加载原版本和编译；非 waiting 或 claim 竞争失败报 WORKFLOW_RUN_NOT_WAITING 且不 invoke。Prisma 的读取和 claim 继续按项目 / 所有者过滤；claim 在事务中有条件更新后读回完整记录，保留 startedAt 与身份。恢复前先检查原 checkpoint，再传 Command，不传 initialState、不新建 Run 或线程；与 start 共用结果分类、最终输出解析及状态落库逻辑。再次暂停可回 waiting，错误由已 claim 的调用方写 failed。Runner 不查询 interaction NodeRun；其 waiting / resume 关联仍独立设计。当前 LangGraph 对 falsy resume 的行为以单个原生 interrupt ID 映射适配，interaction node 接收的业务值不变，细节见 [恢复边界](runtime-architecture.md#workflowrunner-恢复)。

版本读取已有生产 Prisma 实现，并用于真实 PostgreSQL / LangGraph 的 Runner 集成；生产 Runner 已通过 Worker Runtime Service 装配，队列消费者、正式文本节点与 Run HTTP 已接入。MemorySaver 和测试节点仅用于测试，不构成生产兜底。版本测试经真实 WorkflowService 更新 / 发布，验证 A → Version 1、草稿改 B → Version 2 后旧版本不变，以及新 Repository / 独立数据库连接读取。发布测试使用两个独立连接验证 12 次并发编辑单胜者、过期发布无版本、12 次同修订发布单版本、新修订递增版本号；另以 PostgreSQL 阻塞信息确认发布等待未提交编辑行锁，并在编辑提交后拒绝过期修订。覆盖发布时无效定义拒绝、所有者隔离、输入校验及 sourceRevision 数据库约束。Runner 与 Run Repository 的既有失败、恢复、并发 claim 和权限边界保持独立。

## Workflow 编辑 HTTP API

| 接口                                      | 行为                                                                       |
| ----------------------------------------- | -------------------------------------------------------------------------- |
| POST /api/v1/projects/:projectId/workflow | 显式初始化并返回当前默认 Workflow；空请求或 `{}`，创建和已存在均返回 200   |
| GET /api/v1/projects/:projectId/workflow  | 只读当前 Workflow；未初始化、不存在或无权访问返回 404，不隐式写库          |
| PUT /api/v1/workflows/:workflowId/draft   | 接受 `{ expectedRevision, definition }`，成功返回本次保存的 `{ revision }` |

三个入口均由全局 AuthGuard 保护，响应为 no-store，写入遵循既有 Origin 策略。Workflow 读取响应包含 id、projectId、name、revision、完整 draft 和创建 / 更新时间，经共享 Schema 校验，不携带 ownerId、版本数组、运行或凭证。默认名称为“默认工作流”，初始 revision 为 1，草稿的 inputs / nodes / edges / outputs 均为空数组；后续项目改名不会同步覆盖 Workflow 名称。

initializeForProject 在 ReadCommitted 事务中按 projectId / ownerId 锁定项目行，等待锁后查询现有 Workflow，仅缺失时创建；既有 workflow.projectId 唯一约束作为数据库防线。重复或跨实例并发初始化返回同一身份，不更新已有名称、草稿、revision 或 updatedAt，也不修改 Project。此选择逻辑只属于当前应用的项目默认工作流入口；Workflow、Version、Run 和 Runtime 仍以独立 Workflow ID 工作，没有新增永久单工作流的内核约束或数据库迁移。

读取按项目所有者过滤，初始化在项目行锁内校验所有者；保存复用 updateDraft 的权限和乐观锁，不信任客户端传入的归属。客户端先取得真实 Workflow ID 和 revision，再保存完整 definition；并发保存只有一个请求成功，过期请求返回 409，不覆盖最新草稿。保存不发布版本、不创建 Run / Outbox、不调用模型；允许未选择模型的编辑草稿，仍执行既有结构与已注册节点配置字段校验，不承诺已可执行。Web 已调用这些入口，加载和保存边界见下文。

workflow-editor-api.e2e-spec 同时覆盖默认 Workflow 编辑与正式发布，具体边界见下节；初始化和草稿保存均不会调用模型或生成运行。

## Workflow 发布与版本 HTTP API

| 接口                                       | 行为                                                                           |
| ------------------------------------------ | ------------------------------------------------------------------------------ |
| POST /api/v1/workflows/:workflowId/publish | 仅接受 `{ expectedRevision }`，成功返回 201 与完整版本快照                     |
| GET /api/v1/workflows/:workflowId/versions | 版本倒序摘要，每页最多 20 条；可传 `beforeVersion`，响应含 `nextBeforeVersion` |
| GET /api/v1/workflow-versions/:versionId   | 按明确版本 ID 读取完整不可变快照，不回退到 draft / latest                      |

三个入口默认认证、no-store，按当前项目所有者过滤，不存在或无权访问统一返回 404；发布还遵循 Origin 策略。响应使用 contracts/workflow/workflow-api.ts 的中立 Schema，包含版本身份、项目归属、sourceRevision 与 publishedAt；列表不携带 definition，完整读取和发布响应携带 definition，不返回 Provider、凭证、SDK 错误或运行状态。发布不创建 Run / Outbox，不执行模型，也不要求外部服务此刻在线。

`workflow/definition/validate-publish.ts` 在正式 Definition 结构校验之后补齐静态语义：

- 精确类型 / 版本必须存在且为当前可编译的 Action；节点名称直接使用官方 StateGraph.addNode 检查，校验用 builder 不 compile / invoke。
- Data Edge 与静态绑定必须指向真实输入 / 输出端口，必填输入必须有来源；Workflow Input 到节点、Data Edge 两端及最终输出采用同一个 isTypeAssignable。常量使用真实 inputSchema 字段校验，全部输入已知时执行整组 Schema；完整 config 使用正式 strict configSchema 校验，不将 transform / 默认值回写快照。
- 未实现的 Asset 绑定、命名 Control 端口及非 Action 结构拒绝发布；普通 Control Edge 仍表达确定性依赖，联合 DAG 规则沿用现有 Schema。输出采用 auto 时必须存在现有默认存储策略。
- 静态语义失败返回安全的 WORKFLOW_PUBLISH_VALIDATION_FAILED 和节点 / 端口定位原因；节点配置不合法保留 WORKFLOW_NODE_CONFIGURATION_INVALID。格式错误仍为 VALIDATION_FAILED，不回显原配置值。

当前文本节点的模型绑定由应用层使用正式 textGenerationConfigSchema 与 Manifest 能力声明解析，不从 UI 控件推断。ModelProviderService.assertPublishableConfiguration 在同一个发布事务内验证模型配置、Provider 和项目归属，持有共享行锁直到提交；缺失、跨项目、能力不匹配、模型或 Provider 停用均拒绝发布。插件精确版本必须在当前受信任 Registry 中提供该能力，Provider configuration、模型名与 settings 必须满足同一插件 Schema。该方法只 SELECT 非秘密字段，不读取密文、不解密、不调用插件能力。错误仅保存安全摘要，不泄漏其他项目配置是否存在。

这保证发布时本地已知配置可用，不把 mutable enabled / credentials 冻结进版本。后续停用、凭证轮换或删除不会改写旧版本；执行时 Worker 仍重新鉴权、检查 enabled、解密和校验凭证。动态运行输入、生成输出、跨动态字段的 Schema 约束、Artifact 实际内容 / 权限、网络、额度、模型在线状态、凭证解密与外部受理结果均留在 Runtime 判断。新的 NodeType 若需要其他资源绑定，须显式补齐其发布资源校验，不能绕过当前边界。

workflow-editor-api.e2e-spec 使用正式 HTTP、两个 API 实例及真实 PostgreSQL，覆盖不完整草稿与严格发布、未知类型 / 版本、端口 / 来源 / 输出错误、模型归属 / 能力 / 停用、不可用插件或参数、并发编辑 / 发布、配置停用行锁、旧版本不变、权限、失败无版本和版本列表分页。ai-text.e2e-spec 的正常路径从正式发布 HTTP 进入既有 Outbox / Queue / Worker / 文本插件；原生等待和不兼容历史快照由测试显式建数，不伪装成支持它们正式发布。

## 生产 Runtime 装配

API 与 Worker 各有 workflow/runtime/WorkflowRuntimeModule 和 WorkflowRuntimeService，AppModule 显式引入。API 仅引入 WorkflowSubmissionModule / WorkflowQueueModule，不提供 Runner factory 或 ExecutionService；执行基础设施、Consumer 和 Outbox Pump 仅在 Worker 装配。共享 WorkflowRunSubmissionFactory.forProject(ownerId, projectId) 创建限定权限的提交服务，独立于 Compiler / Checkpointer。WorkflowExecutionService 接收受信任的 Job，核对持久 Outbox 的身份、payload 和 waiting 周期，再按 Run ID 从数据库读取项目及所有者，再经 WorkflowRuntimeFactory.forProject 装配权限与 executionId 作用域的 Runner；版本 / thread 仍由 Runner 从持久记录读取，不缓存跨用户 Runner。执行服务是内部执行端边界，HTTP 必须在交付 Job 前校验当前用户权限。Worker Service 暴露 execute(job)、executeStart(id)、executeResume(input)，不再创建 Run。
packages/server/workflow 复用原有 Prisma 版本 / Run / NodeRun Repository 实现，权限过滤、原子 attempt 与 claim 语义不变，Worker 不依赖 API 包。WorkflowRuntimeInfrastructureModule 提供 Repository 工厂、ArtifactModule、最终输出解析与装配 factory。factory 使用既有 DefaultWorkflowCompiler / Action 策略，注入应用级 PostgresSaver；按真实 Run 创建限定权限的 DefaultNodeExecutor 和 Artifact Codec，复用纯 BindingResolver 与统一存储策略。未新增策略注册框架或修改 Runner 图执行语义。

WorkflowNodeRegistryModule 为每个应用提供同一个生产 Registry；API 目录与 Runtime 共用正式文本节点。Worker factory 为每个授权 Run 构造 CapabilityInvoker，并注入 NodeExecutor 的业务上下文；能力服务不进入 State 或 checkpoint。ArtifactRuntimeFactory.forRun(ownerId, projectId, workflowRunId) 构造有授权作用域的真实 Writer / Resolver / Codec；Asset 引用仍以 REFERENCE_RESOLUTION_FAILED.cause.code = ASSET_REFERENCE_NOT_CONFIGURED 明确拒绝，不回退 inline。

workflow-runtime.e2e-spec 启动正式 API / Worker AppModule，检查 API 不装配执行依赖、Worker 构造生产依赖、正式文本节点目录、空版本从提交到消费、权限、未知节点与缺失 checkpoint 的失败边界。测试用故障节点和原生等待图不会进入生产源码；文本业务调用由下述专用用例验证。

## Workflow Run HTTP API

API 的 WorkflowRuntimeModule 注册 WorkflowRunsController，三个路由默认受真实 AuthGuard / Origin 策略保护，返回 Cache-Control: no-store。POST /api/v1/workflow-runs 只接受 workflowVersionId 与 RuntimeValue inputs；Service.startVersion 按当前用户查询版本所属 Workflow / Project，派生内部身份，先 submitStart 创建 pending，再通过 Dispatcher 确认 start Job 已入 Redis。GET /api/v1/workflow-runs/:runId 和 POST /api/v1/workflow-runs/:runId/resume 先按 Run 的项目所有者检查权限，后者只接受必填的 unknown value，再 submitResume 取得持久意图并确认入队；提交不 claim，Controller 不组装 Runtime。

contracts/workflow/workflow-run-api.ts 提供严格请求与 WorkflowRunResponse Schema。响应只包含 Run 业务 ID、版本、状态、RuntimeValue 输入 / 最终输出、稳定错误摘要与 ISO 时间，不公开 projectId / threadId、State 或 checkpoint。不存在与无权访问分别统一为 WORKFLOW_VERSION_NOT_FOUND / WORKFLOW_RUN_NOT_FOUND（404），非 waiting / 原子 claim 失败为 409；配置缺失为 503，节点执行或未知 Runtime 故障返回安全的 500，不返回原始 message、stack 或 cause。既有草稿修订冲突保持 409；发布 Controller 属于独立的 Workflow 发布入口。

workflow-run-api.e2e-spec 使用两个真实 API HTTP 实例、真实密码会话和签名 Cookie，并启动独立 Worker 子进程。检查 202 / pending / GET、API 进程不调用 Runner、原版本与 thread 的两轮异步恢复、0 值、同等待周期并发提交单意图 / 409、跨用户 404、严格字段和队列不可用时安全 503。中断图只存在于测试 Worker 编译器。

POST start / resume 成功均为 202，返回 Run DTO；GET 查询实际运行状态。API 不执行 Graph，Worker 经共享执行服务处理队列；正式文本节点可由已发布 Workflow 执行，Web 画布尚未接入运行交互。

## Workflow Execution Queue

PostgreSQL 的 workflow_execution_outbox 保存 id、kind、workflowRunId、payload、status、createdAt、publishedAt、attempts，以及 waitingRevision / completedAt / availableAt。start 与 Run 同事务提交；resume 在 Run 行锁下生成独立 executionId，同一 waitingRevision 只能创建一个意图，重复提交报 WORKFLOW_RESUME_ALREADY_SUBMITTED。waitingRevision 是数据库管理的内部周期，每次 running → waiting 自动递增，不进入公开 Run DTO / WorkflowState。Outbox 的身份、payload、周期不可修改。

packages/server/workflow/queue 使用 BullMQ 6.3.18，复用 REDIS_URL 服务，独立连接、固定 workflow-execution queue 与可配置 prefix。Job ID 由 kind / Run ID / resume executionId 的 SHA-256 确定性生成，使用不含冒号的编码；Redis 只保存共享 Job，不保存 Definition、State、thread 或 outputs。成功 / 失败 Job 有界保留，PostgreSQL Outbox 完成标记继续防止 Redis Job 被清理后的重复执行。

API 只提交和显式 publish；Worker 的 WorkflowOutboxPump 在启动后扫描 pending，Dispatcher 以 FOR UPDATE SKIP LOCKED 并发选取行，在事务中 enqueue 再记 published。enqueue 前死亡仍有 pending；enqueue 成功但记录前死亡，事务回滚后按相同 Job ID 重投。Redis 故障保存尝试次数与指数退避，不改变 Run；HTTP 不返回成功受理，而是安全的 WORKFLOW_QUEUE_UNAVAILABLE / 503，持久意图之后仍可能执行，调用方不能盲目重提为新 Run。

Worker Consumer 校验 Job，再调用 WorkflowExecutionService。执行服务校验 Outbox，Runner 使用带 executionId 的 Repository；原子 Run claim 同时把对应意图转 executing，并检查 waitingRevision。API、Dispatcher、Queue 不执行 Run claim。Graph 成功 / 再次等待后意图 completed，业务失败后意图 failed；Consumer 用 UnrecoverableError 停止业务重试。临时数据库连接 / 超时等 claim 前故障最多重试五次，指数退避；stalled redelivery 由 BullMQ 管理。

Worker 在 claim 前死亡，重投可继续执行；claim 后死亡且 Run 仍 running，结果无法确认时记录 recovery_required，队列停止自动执行，Run / NodeRun 不伪装为业务 failed。若 Run 已 completed 或已进入紧接着的 waiting 周期，仅补记意图 completed，不再次 invoke。此边界防止重复生成副作用，不承诺收费调用 exactly-once，不实现业务 Retry 或自动核查恢复。

workflow-queue.e2e-spec 使用真实 PostgreSQL / Redis 与 SIGKILL 子进程，验证提交后未 enqueue、enqueue 后未记 published、Worker 收件 / claim 后死亡、两次 resume、清理 Redis 旧 Job 后重投、事务回滚、投递失败、临时基础设施重试及 NodeRun 业务失败不重跑。跨进程 checkpoint 恢复仍由原有独立用例验证；测试原生等待图不等于 Human Review 产品能力。

## PostgreSQL Checkpointer

packages/server 的 checkpoint/WorkflowCheckpointerModule 提供应用级 WorkflowCheckpointerService，API / Worker 经 InfrastructureModule 启动和关闭。使用官方 @langchain/langgraph-checkpoint-postgres 1.1.0 的 PostgresSaver 和独立 pg.Pool，DATABASE_URL 指向的数据库中固定使用 langgraph schema；Prisma 不管理 checkpoint 表。启动先用 advisory transaction lock 串行化官方 setup()，再经 getTuple() 验证读取，成功后开放 saver；失败报告 WORKFLOW_CHECKPOINT_UNAVAILABLE 并释放连接，应用不就绪。健康接口通过相同读取路径探测；应用关闭调用 end()。Compiler 继续只接收 BaseCheckpointSaver 并传给 graph.compile，不创建连接或初始化表。

API 的 workflow-runner.e2e-spec 已使用生产 provider 和官方 saver 验证普通 Action Compiler。persistent-checkpoint.e2e-spec 通过独立子进程启动 / 恢复：A 在 interrupt 后真实退出并关闭 Nest / Prisma / Saver，B 用全新实例与原 thread / 版本恢复；期间发布新版本仍不改变原运行，保留输入与已完成节点输出。另以进程间屏障让两个实例都读到 waiting，真实 PostgreSQL claim 只允许一个 graph.invoke；数据库不可用时应用启动失败。测试使用原生中断专用编译器，不提供 HumanReview 节点或 NodeRun waiting，也没有把主动 interrupt 加进普通 Action。初始化、连接预算与备份见 [部署说明](deployment.md#langgraph-postgresql-checkpointer)。

## 数据与 Node 基础库

contracts/data 提供正式 DataType、builtin 类型常量、共享 isTypeAssignable、DataTypeManifest、RuntimeValue 与 DataReference。primitive / named / array / object / union / any 描述语义类型；inline / reference 描述运行值承载。数组元素用 itemType；兼容规则包含递归数组、Union 全来源覆盖和对象结构子集，any 仅放宽目标。

contracts/content 提供 Artifact 与版本化 Asset 的共享协议；Artifact 引用不可变产物 ID，AssetReference / AssetBinding 固定 versionId。Artifact 已接入下述生产数据通道；Asset 仍无数据库、版本内容读取、Promote 或资产库服务。详细类型与生命周期见 [数据模型](data-model.md)。

服务端 DataTypeRegistry 按名称注册 Manifest + Zod，拒绝重复及未知名称；schemaFor / parse 递归检查实际 JSON 值。目录只返回独立 Manifest 副本，未注册虚构媒体实现，也未接入类型目录 API。

NodeTypeManifest 增加必填 executionKind：action / control / composite / interaction。NodeType 改为 execute(input, config, context)，不再自行 compile。NodeRegistry 精确匹配 type / version，并固定实现读取的 Manifest；普通 action 提供 execute，其他种类声明由独立结构策略处理。生产目录已有 `ai.text_generate@1`。

createOperationNodeType 只组合 Manifest、三组 Zod 与 operation。parseNodeDefinition、applyNodePreset、invokeNodeOperation 保留独立值契约校验，Preset 不改变运行身份，转换与默认值不回写定义。assertNodeSchemas 检查字段集合和默认值，不证明任意 Schema 与语义类型完全等价。

ActionNodeCompilationStrategy 校验精确类型版本、复制定义并只生成调用 NodeExecutor 的函数包装。上下文工厂提供 workflow 与可选能力 / 运行配置，包装注入当前 WorkflowState，并从 state.run 取得 projectId / workflowRunId。节点等待 Executor 完成后只返回 `{ outputs: { [node.id]: result.output } }` 的 WorkflowStateUpdate，不展开旧 outputs，不解析 Binding、业务 Schema 或 Artifact；Executor 失败原样传播。DefaultWorkflowCompiler 复用该包装，结构策略尚未接入；编译不执行业务、不管理运行状态或暂停恢复。

runtime/state.ts 在既有接口旁导出 WorkflowStateAnnotation。run / inputs / variables / execution 为单值通道，outputs 使用 mergeNodeOutputs，default 生成空 map。reducer 只合并不同节点的自有键，重复 nodeId 抛 DuplicateNodeOutputWriteError（DUPLICATE_NODE_OUTPUT_WRITE），不修改原 map。标准 reducer 无 step 身份，本步普通 DAG 因而拒绝对所有已有键的隐式覆盖；重执行的新 effective output 仍须显式语义。真实 StateGraph 测试用现有 DependencyCompiler、Action 策略、Executor、BindingResolver 与 Codec 验证 A/B 两种完成顺序后 C 读到双方输出并只执行一次；另覆盖通道初始化、同一步冲突、跨 step 覆盖拒绝及原型相关键。

runtime/binding-resolver.ts 已实现 resolveDataEdgeInputs 和无参数 createBindingResolver。BindingResolver.resolveInputs 接收 node / nodeType / edges / state，按传入 Manifest 的 inputs 索引校验已绑定目标端口，只读取当前目标的数据边，将上游指定输出原样映射为目标输入 RuntimeValue。三类静态 Binding 使用实际实现：constant 按端口 dataType 包装为 inline；workflow_input 按既有 key 直接复用 State.inputs 的 RuntimeValue；asset 按端口类型生成包含 assetId / versionId 的 reference，不查内容或最新版。未重新引入 ConnectionBinding，也不 decode、调用 NodeType、Zod 或持久化 Artifact，Resolver 没有数据库、对象存储或网络依赖。

BindingResolutionError 包含 INPUT_SOURCE_CONFLICT、SOURCE_NODE_OUTPUT_MISSING、WORKFLOW_INPUT_MISSING、INPUT_PORT_NOT_FOUND；details 提供节点、输入键及可选边、来源端口或工作流输入键。正式 WorkflowDefinition 的两种输入冲突校验继续在 issue.params.code 标记 INPUT_SOURCE_CONFLICT。测试覆盖四类来源真实合并、端口声明类型、空值 / 数组等常量、inline / reference 工作流输入的身份保留、固定资产版本及四类错误，使用真实静态转换实现。

runtime/runtime-value-codec.ts 提供统一 RuntimeValueCodec 和 DefaultRuntimeValueCodec，显式注入 DataReferenceResolver、ArtifactWriter 与 DataStoragePolicyResolver。decode 对 inline 原样返回，reference 委托引用服务；decodeRecord 并行解码自有键，引用失败以 ReferenceResolutionError / REFERENCE_RESOLUTION_FAILED 保留 reference 和 cause。encode 接收 DataType、存储策略及项目 / 运行 / 节点 / 输出键定位；inline 校验 JSON 承载后包装，reference 经 ArtifactWriter 写入并验证返回的 ArtifactReference。Codec 不依赖数据库或对象存储实现，不拼接 URL，不执行业务 Schema。data-reference-resolver.ts 保留 MediaResource，value-codec.ts 仅保留通用 RuntimeValueContext，不再另设输出 Encoder。

OutputPortDefinition 增加可选 storagePolicy，复用既有 DataStoragePolicy；省略时 Executor 使用 auto。data-storage-policy-resolver.ts 提供统一接口及默认类型规则：primitive / system.json / story.character / story.scene 内联，media.file / image / video / audio / document 引用；规则表可显式扩展。未注册 named 及结构类型的 auto 明确失败，不用 JSON 大小猜测。workflow 的 artifact-writer.ts 保持接口与业务 BinaryContent 类型，携带声明类型及输出来源；实际 Artifact 持久化由 server 适配，不让内核依赖 Prisma / S3。

runtime/node-executor.ts 提供 DefaultNodeExecutor，显式注入 Registry、BindingResolver、Codec 与 NodeRunRepository。先 createRunning，再 getAction、绑定、updateInputs、decodeRecord、输入 / 配置校验、业务调用、输出校验和逐端口 encode；markCompleted 确认成功后才返回 `{ output: Record<string, RuntimeValue> }`，不修改 WorkflowState。不按业务 type 分支，不直接操作数据库或对象存储，NodeRun 持久化只经注入 Repository，不重试或实现审核。编码失败停止后续输出，不返回部分结果；前序已写入的 Artifact 不由 Executor 自动回滚。

node-execution-error.ts 提供 NodeExecutionError，保留 nodeId、nodeType、stage、code 和 cause。Executor 记录的业务阶段为 resolve_input / decode_input / validate_input / validate_config / execute / validate_output / encode_output；输出编码及 Writer 失败使用 NODE_OUTPUT_ENCODING_FAILED，与输出业务校验区分。业务管线异常按准确阶段先 markFailed 再抛出；创建、输入记录与完成记录方法均在该 catch 外，Repository 故障保留原始异常上抛，不反向 markFailed。失败记录写入也失败时沿用 NodeRunRecordingError，同时保留原 cause 与 recordingError。GraphBubbleUp 原样传播、记录保持 running，不记 failed；普通 Action 不得主动 interrupt，恢复关联未实现。测试用真实 Registry / BindingResolver / Codec 验证 math.add、Schema 转换后编码、三类真实 Binding 错误的 resolve_input 阶段、业务失败记录、三个 Repository 方法故障原样上抛、等待完成记录确认及 State 不变；测试视频输出得到 Artifact 引用和内联 duration，检查 Writer 上下文与失败停止。独立 TestState / MemorySaver 仅验证原生中断与 Command 恢复，不代表生产 Checkpoint 或审核服务。

DataReferenceResolver / ArtifactWriter 的 Artifact 分支已接入 server 生产实现；旧 ArtifactStore / AssetStore 端口不作为第二套内容链使用，Asset 内容服务未实现。math.add、媒体及产物测试节点仅在测试注册，正式文本节点由生产 Registry 注册。State.outputs 使用 NodeOutputMap，execution 保留为空；Action 增量、持久 Checkpointer、内容通道与 Worker Consumer 已接入，不提供内存 / 本地存储降级。

createWorkflowRunConfig 使用显式 Run.threadId，不从 Run.id 推断或允许其他配置覆盖，不创建运行或 checkpointer。contracts/workflow/node-run.ts 独立定义 NodeRun 的三状态、必填 ISO 开始时间、RuntimeValue inputs / outputs 和结构化错误，并从包入口导出。NodeRunError.stage 为非空字符串，code 可省略，不绑定 Runtime 的阶段枚举；NodeExecutionStage 仅在 workflow/runtime/node-execution-error.ts 内维护。run/node-run-repository.ts 定义 Repository 抽象，createRunning 只接收 workflowRunId / nodeId，不接收 attempt 或数据库字段；Executor 只依赖该抽象。

packages/server 的 workflow/node-run-repository.ts 提供 NodeRunRepositories.forRun(ownerId, projectId, workflowRunId)，验证同项目真实父运行和所有者，返回限定项目 / 运行的 PostgreSQL Repository。projectId 来自该工厂作用域，不属于 CreateNodeRunInput。写入继续过滤所有者、项目、运行和 running 状态；输入只写一次，终态不可改写。createRunning 在 ReadCommitted 事务中按运行 / 节点获取 PostgreSQL advisory transaction lock 后分配 attempt，并受唯一约束保护。Prisma NodeRun 使用 String status，数据库继续约束三状态及终态字段一致性，包含 workflowRunId 和 workflowRunId / nodeId 索引。node_run 关联 canvas_project，并以 workflowRunId / projectId 复合外键关联 workflow_run，防止跨项目归属；删除父运行级联删除节点历史。

contracts/workflow/workflow-run.ts 在既有元数据上补全 WorkflowRun，保存项目、明确版本、独立 threadId、六种状态、RuntimeValue inputs / 最终 outputs、结构化错误和 ISO 时间。run/workflow-run-repository.ts 定义 create、getById、claimPendingForStart、claimWaitingForResume 与五种明确状态操作，不暴露 updateStatus 或数据库实现。共享服务的 WorkflowRunRepositories.forProject(ownerId, projectId) 返回有权限作用域的 Prisma Repository；创建固定 pending、输入与版本，分别生成 id / threadId，所有写入继续检查所有者与项目。markRunning 首次写 startedAt，waiting 恢复保留它；其余操作以当前合法状态作为原子更新条件，终态不改写。数据库约束字段一致性、threadId 唯一、不可变身份 / 版本 / 输入及合法转换，规则见 [WorkflowRun](workflow-model.md#workflowrun一次实际运行)。Run 的 workflowId / workflowVersionId 暂保留逻辑引用，本轮版本建模不调整运行外键；Runner 经真实版本 Repository 核对项目 / 工作流 / 版本归属。start / resume 已有受鉴权保护的 HTTP 与 Worker 消费者，Human Review 尚未接入。

WorkflowRun 测试检查协议 JSON 往返、输入输出 RuntimeValue map、独立 thread 与 ISO 时间；真实隔离 PostgreSQL 覆盖创建、等待再运行、首次时间保留、30 组状态操作、终态并发竞争、版本不可改、thread 唯一、权限隔离、同项目 NodeRun 外键与级联删除。记录中的最终输出只含调用方提交的对外 RuntimeValue map，Repository 不执行最终结果收集或业务 Schema 校验。

真实隔离 PostgreSQL 测试覆盖仅用两个创建字段连续得到 attempt 1/2、可省略错误码及可扩展阶段，并覆盖视频节点首次失败、第二次成功的两条历史与有效 State 输出、Binding 失败无输入快照、12 次并发 attempt、数据库唯一约束、终态不可覆盖及项目 / 运行权限隔离。完成记录不可用的故障注入用例验证业务已成功时不会调用 markFailed，已创建的 running 记录和输入保留，且不写 State。内容 Resolver / Writer 仍显式使用测试替身；这些用例不证明真实视频或 Artifact 持久化。

## 文本 AI 与 Provider Plugin

`packages/workflow/src/node/text-generation.ts` 提供正式 `ai.text_generate@1`：输入为 prompt 和可选 system，配置只有 modelConfigurationId，输出为 text。节点只表达 `text.generate` 能力，经业务上下文中的 CapabilityInvoker 调用；不导入具体 SDK、读取环境凭证、访问 Provider 数据库或自行记录 NodeRun。输入和输出继续经过统一 BindingResolver、Codec、三组 Schema、NodeExecutor、NodeRun 与 WorkflowOutputResolver。

`packages/plugins` 提供 ProviderPlugin 与 PluginRegistry。插件按 pluginId / 整数版本精确注册，一个插件可提供多个 Capability；各 Capability 声明输入、输出和模型参数 Schema。Registry 校验调用边界并转换安全错误，不自动选择其他插件、版本或模型。现有 `openai_compatible@1` 仅实现 `text.generate`，通过 LangChain ChatOpenAICompletions 调用标准 Chat Completions 协议，明确接收 baseURL、model 与 apiKey。HTTP(S) 地址拒绝 userinfo、query 和 fragment；显式自部署本地 HTTP 地址可用。其他能力尚未实现，动态 npm 加载、远程安装、插件市场与不可信代码沙箱均未建立。

`packages/server/src/models` 提供生产 ModelProviderService、Prisma 配置读取和按 Run 限定权限的 CapabilityInvoker。model_provider 保存所属项目、插件身份 / 版本、endpoint 等配置及加密凭证；model_configuration 单独保存 Provider 引用、capability、模型名与参数。数据库约束同项目引用，插件 / 模型配置身份不可改写；禁用状态可变，凭证可通过显式服务操作轮换。改用其他模型或 endpoint 需创建新配置，旧 WorkflowVersion 的 modelConfigurationId 不变；凭证轮换和配置禁用不会把新模型静默替换进旧运行。每次调用按当前项目所有者和真实 Run 重新核验权限，拒绝跨项目、跨所有者、禁用或缺失配置。

凭证使用既有 SecretsService 的 AES-256-GCM，ownerId 作为 AAD；安全 DTO 不返回明文或密文。Workflow / Version 只保存配置 UUID，NodeRun 与 checkpoint 不保存 endpoint、凭证或能力服务对象。API 与 Worker 可注入 ModelProviderService；正式管理 HTTP 见下节，项目内模型管理 Web 已接入，Workflow 节点的模型选择 UI 尚未接入。服务端配置工具继续可用，见 [部署说明](deployment.md#文本模型-provider-配置)。调用前才解密，配置缺失或坏密文在现有 execute 阶段失败，不新建另一套运行记录。

模型调用有界超时，默认 60 秒，可明确配置为 100 毫秒至 180 秒；LangChain 与 SDK 重试关闭，不流式返回。适配器隔离父级与自动 tracing、关闭 SDK 日志；全局 LANGCHAIN_VERBOSE=true 时拒绝调用。连接中断、超时或 5xx 的外部受理结果可能不明，不自动再次发送；Worker 仍沿既有 NodeRun / WorkflowRun 失败及 Outbox 终态记录，不承诺外部调用 exactly-once。原始供应商响应、message、cause 不进入持久错误摘要。

`ai-text.e2e-spec.ts` 已通过 6 项真实基础设施测试，路径为鉴权 HTTP、正式发布、PostgreSQL Outbox、BullMQ、独立正式 Worker、文本节点与本机 OpenAI-compatible 协议服务。覆盖配置 / 凭证不可用、503 不重试、项目 / 所有者隔离、配置不可改写、凭证轮换、服务端 CLI 真实写库，以及持久记录和 Worker 日志无凭证；本机协议服务不冒充外部模型。全仓库 check 与隔离数据库集成均通过，默认集成跳过真实收费调用。

2026-10-21 已显式执行 `ai-text-live.e2e-spec.ts`：使用操作者选择的 DeepSeek `deepseek-flash`，通过正式发布、HTTP 202、Outbox、BullMQ、独立 Worker、生产文本 Node 和参考插件完成真实外部模型请求，NodeRun attempt 为 1，WorkflowRun completed，并取得非空文本最终输出。用例检查 Version / Draft、Run / NodeRun、Outbox、所有 checkpoint 与 Worker 日志不含该凭证明文，结束后清理自建测试记录与 thread。此项使用真实服务，没有覆盖或替换 Registry / Compiler / SDK；本机协议服务负责失败边界，真实调用只验证本次选择的服务与模型。可用 `pnpm test:ai:live` 显式复验，参数和边界见 [开发指南](development.md)。

仓库的 [LiteLLM 隔离实验](../experiments/litellm-l1/README.md)提供固定 `1.104.5` Gateway、双协议本机服务与自动验证驱动；其结果只验证 Gateway 边界，生产 PluginRegistry / Worker 尚未装配 LiteLLM。运行中观察到 SDK client cache 会保留凭证引用，普通响应头及错误路径会返回 endpoint，细节与复现见实验说明；拟议领域所有权见[集成评估](litellm-integration.md)。

## Plugin / Provider / 模型配置管理 HTTP

`apps/api/src/models` 提供模型管理 Controller，复用共享 ModelProviderService、SecretsService 与生产 PluginRegistry。业务 API 默认认证，写入遵循既有 Origin 校验，所有管理响应为 no-store。资源不存在或不属于当前用户 / 路径项目时统一 404；无效请求与插件 Schema 校验失败为安全 400，已停用 Provider 不接受新模型绑定并返回 409，加密或服务故障为安全 503。

以下路径均以 `/api/v1` 为前缀：

| 方法与路径                                                 | 行为                                                                    |
| ---------------------------------------------------------- | ----------------------------------------------------------------------- |
| GET /provider-plugins                                      | 已安装且显式允许配置的插件精确版本、安全配置描述与能力参数目录          |
| GET /projects/:projectId/providers                         | 当前项目 Provider 列表                                                  |
| POST /projects/:projectId/providers                        | 显式指定名称、插件版本、configuration 与 credentials 创建 Provider，201 |
| GET /projects/:projectId/providers/:providerId             | 安全 Provider 详情，不读取凭证密文                                      |
| PATCH /projects/:projectId/providers/:providerId           | 仅接受 enabled，返回当前安全 DTO                                        |
| PUT /projects/:projectId/providers/:providerId/credentials | 校验后完整替换凭证密文，204，无返回值                                   |
| GET /projects/:projectId/model-configurations              | 当前项目模型配置与静态可选性列表                                        |
| POST /projects/:projectId/model-configurations             | 指定 providerId、capability、model 和 settings 创建不可变绑定，201      |
| GET /projects/:projectId/model-configurations/:modelId     | 模型配置详情与静态可选性                                                |
| PATCH /projects/:projectId/model-configurations/:modelId   | 仅接受 enabled，不改变能力或模型绑定                                    |

共享请求 / 响应 Schema 位于 `contracts/ai/model-management.ts`。项目身份仅来自路径，创建体不接受 projectId / ownerId。两个列表按 createdAt / id 倒序，每页至多 50 条，以 nextCursor 继续读取；游标仅在同项目 / 所有者作用域内有效。模型选择器可结合插件目录、Provider 目录 / 详情与模型列表，按 capability 和 availability.selectable 筛选，保存 modelConfigurationId；不需要访问内部 Service 或凭证。

Plugin 的可选 management 元数据显式允许新配置，缺省插件仍可被 Runtime 精确查找，但不出现在管理目录，也不能创建新 Provider / 模型绑定。公共目录只返回可序列化描述；configurationSchema 和 modelSettingsSchema 从正式 Zod Schema 生成 JSON Schema，凭证仅公开字段名、必填及长度约束，不输出默认值、示例、枚举或完整凭证 Schema。服务器继续用原 Zod Schema 校验，包括 JSON Schema 无法表达的自定义约束。目录不携带 invoke、Zod 对象、SDK 或输入的凭证值。

沿用数据库不可变约束：Provider 名称、projectId、pluginId / version、configuration，以及模型的 providerId、capability、model、settings 均不可 PATCH。换 endpoint / 插件 / 模型 / 参数或 Provider 名称须创建新配置；没有删除或覆盖绑定入口。启停使用所有者作用域内的原子字段更新，重复设置幂等，最后成功写入生效，不引入另一套 revision，也不推进 Project / Workflow revision。启停与凭证轮换修改不同字段，并发不互相覆盖。

停用 Provider 不批量改写其模型的 enabled；重新启用模型不隐式启用 Provider。模型 availability 仅根据当前 enabled、插件 / capability 存在性及正式非秘密配置 Schema 判断，带稳定不可选原因；不解密、不探活、不查询全网模型目录。可选性只是本地状态，凭证解密、权限重检和外部服务状态仍在 Runtime 判断。发布继续在自己的事务锁内验证，管理变更不会修改已发布版本。

Provider 创建与完整凭证轮换复用 AES-256-GCM 和 ownerId AAD。读取数据库投影不包含 encryptedCredentials，输出白名单也不包含 credentials；停用的 Provider 仍可轮换凭证。校验或加密失败保留旧密文。Controller 不透传原始 Zod issues、插件 / 数据库 / 加密异常；全局错误过滤器对模型管理路径的前置 JSON 解析错误和未知错误同样脱敏，不在响应或日志中复制秘密。

`model-management.e2e-spec.ts` 经真实鉴权 HTTP / PostgreSQL 检查目录、创建 / 读取 / 启停 / 轮换、跨用户与跨项目隔离、分页、严格字段白名单、失败无写入、错误与日志脱敏、并发字段更新及旧版本不变。`ai-text.e2e-spec.ts` 的正常配置路径已改用管理 HTTP，再经过正式发布、Outbox / Queue 和独立 Worker，验证绑定可被现有 Runtime 使用；本机兼容协议服务只用于测试，不代表本轮调用了外部模型。

## Web 项目模型设置

画布顶部“模型设置”打开项目内抽屉，不离开或卸载 Workflow Editor。界面按“模型供应商 / 模型”组织：接入方式来自 A3 的安全 Plugin 目录，供应商对应 Provider Instance，模型对应 Model Configuration。同一个供应商下可以添加多个模型或同名模型的不同参数配置，不存在厂商硬编码列表、默认供应商或默认模型。

用户添加供应商时明确选择接入方式，填写名称、服务地址等非秘密配置和新凭证；成功后继续添加模型，供应商为刚才明确创建的实例。模型表单从其能力目录选择 capability，用户填写准确 model 名称和 Schema 参数。列表可刷新恢复配置，按 A3 的 nextCursor 遍历所有分页；查询 key 包含项目身份。没有节点模型选择、发布 / Run 操作、连接探测或远程模型列表同步。

`features/models/schema-fields.ts` 校验可表现的 JSON Schema 子集，以安装版本的 Zod fromJSONSchema 完成客户端验证。支持扁平对象中的字符串、数字、整数、布尔和标量枚举，必填、默认值、范围、长度、格式和模式约束来自公开 Schema；少量通用字段中文标签只负责展示，不决定字段或验证规则。未支持的嵌套、数组、组合或未知约束会明确提示并禁用提交，不保存部分配置；服务端 Zod 仍是最终校验边界，不在前端复制未公开的插件自定义规则。

凭证只在独立组件状态中作为本次输入存在，不注册到 AntD Form store，不进入 TanStack Mutation、查询数据、URL 或浏览器存储。发送创建 / 轮换请求即清空；失败也不恢复，关闭后卸载，重新打开始终为空。普通读取只接收严格安全 DTO；模型 API 适配层对错误和不合契约的响应重新生成安全错误，不保留原始 message、details 或 cause。轮换是独立表单与 PUT 操作，只接受 204，不读取返回体；保存失败保留非 Secret 配置并要求核对列表后重试，不自动重发创建或轮换。

供应商和模型分别启停，不改变绑定或批量改写另一方的 enabled。模型卡片使用服务端 availability 展示可选性与安全原因，更新期间显示正在更新；失败不假报成功，读取失败明确重试。供应商停用会使其模型不可选，重新启用模型不隐式启用供应商。目录为空或接入方式不在可配置目录时，说明原因并关闭相应新增 / 轮换操作。名称、endpoint、插件、模型和参数没有覆盖编辑入口，需要调整时添加新配置。

抽屉打开期间锁住画布图操作和保存快捷键，管理模型不保存 Project / Workflow，也不推进它们的 revision；关闭后保留本地未保存内容。`model-settings.spec.ts` 使用真实项目、模型 HTTP / PostgreSQL 验证创建与刷新、同供应商多模型、轮换、启停、错误重试、项目隔离、窄屏及画布状态保留；同时检查响应、输入、浏览器存储和 Query / Mutation 缓存不包含测试凭证，包括保存请求尚未返回的阶段。Schema / API 单测覆盖默认值、零值 / false、未知结构拒绝、分页及异常脱敏。验证方式见[开发指南](development.md#web-模型管理验证)。

## Artifact 生产数据通道

packages/server/artifacts 提供 ArtifactRepository、ArtifactWriterService、ArtifactDataReferenceResolver 与 ArtifactRuntimeFactory。WorkflowRuntimeFactory 按已授权 Run 构造 Codec；读取时重新检查当前运行和项目所有者，并限制 Artifact 属于同一项目，允许同项目其他运行引用，拒绝跨项目或与已授权作用域不符的 context。写入还要求父 Run 正在运行，可选 NodeRun 必须属于同一项目 / Run / nodeId 且为 running；Executor 总会传入真实 NodeRun ID。数据库使用复合外键阻止来源拼接。

Artifact 契约复用 contracts/content/artifact.ts，增加 json / blob 内容编码。PostgreSQL artifact 保存来源、DataType、storageKey、MIME、字节数和 SHA-256；不保存业务内容或 signed URL。写入先登记 writing，JSON 值编码为 UTF-8 JSON，BinaryContent `{ bytes: Uint8Array, mimeType }` 原样存储二进制，上传 RustFS 后确认 ready，再返回 ArtifactReference。所有内置 media 类型要求二进制内容，不自动下载外部 URL；大文本或领域 JSON 可显式使用 reference 策略。当前使用内存字节与单次 PUT，尚无流式 / multipart 大文件路径。

只解析 ready 记录：JSON 从 RustFS 读取并检查大小、摘要后还原业务值；blob 先 HEAD 验证对象存在及元数据，再生成 900 秒 signed URL 的 MediaResource。Codec、Executor、State / Checkpoint 与 NodeRun 都保留 RuntimeValue 引用，不保存解码后的媒体 URL。缺失、跨项目、非 ready、对象删除或 JSON 内容损坏统一抛 REFERENCE_RESOLUTION_FAILED，仍由 Executor 标记 decode_input。

写入失败使用 ARTIFACT_WRITE_FAILED，细分 prepare / register / upload / finalize；Executor 标记 encode_output。登记失败不上传；PUT 失败尝试删除同一专属 key，再记录 failed / cleanupRequired，补偿与记录错误保留在 AggregateError。确认数据库状态失败可能已提交，保留 writing 或真实 ready 记录及对象，不返回引用，不删除可能已确认的对象。数据库触发器保护内容身份、编码和来源不变，终态不可覆盖。这里不承诺数据库 / S3 / NodeRun / Checkpoint 原子提交；中途退出的 writing、清理失败及未被最终 State 使用的产物仍需核对，自动对账与垃圾回收未实现。

artifacts.e2e-spec 使用真实 PostgreSQL / RustFS、生产 Compiler / Executor 验证 A→B 的 JSON / 图片二进制管线、NodeRun 输入输出引用和所有 checkpoint / pending writes 无实际大内容。另启动两个独立进程加载正式 Worker AppModule，A 在测试原生等待门前写完产物并真实退出，B 重建 Prisma / Storage / Saver 后恢复原 thread，读取相同 Artifact ID；A / B 各只有一次 NodeRun。测试还覆盖跨项目与上下文伪造、对象不存在 / 删除 / JSON 损坏、上传确认丢失、补偿失败、登记失败、数据库确认前失败及提交后响应丢失。中断门是测试 Compiler，不提供 HumanReview 产品能力；测试节点不加入生产 Registry，没有调用真实生成模型。

## React Flow 数据适配

react-flow-adapter.ts 提供整图转换与节点白名单映射。React Flow type 使用 workflowNode renderer，领域类型版本在 data.nodeType / data.typeVersion，位置对应必填 ui.position；selected、dragging、measured 不回写 DSL。

Workflow.edges 是节点间连接的唯一来源。Data Edge 的 id、source.nodeId / portKey、target.nodeId / portKey 与 React Flow 的 id、source / sourceHandle、target / targetHandle 无损往返；数据 Handle.id 必须等于对应 Manifest 端口 key。新增数据连接对照 Manifest 检查精确类型版本、节点与端口存在、共享 isTypeAssignable、自连接及目标已有数据边，再创建 DataEdgeDefinition；显式连接可移除目标静态 Binding，数组输入同样至多一条数据边，不自动聚合多连接。目录查询与显式数据连线共用目录 Schema，拒绝重复 type / version。

controlEdgeToReactFlowEdge 使用 edge.data.kind=control 区分控制边，默认控制 Handle 为 `control:source` / `control:target`，命名端口映射到 `control:source:approved` 等保留命名空间，避免与数据端口 key 冲突；领域仅保存可选实际 portKey，不保存默认 UI 控制 Handle。两类边都保留 ID 与端点，连接只允许 Data → Data 或 Control → Control。断连和重连核对种类及完整旧边快照，防止过期事件修改新连接；连接辅助函数不做运行值校验或调度。

GenericWorkflowNode 根据精确类型版本 Manifest 自动生成数据 Handle、显示端口类型与配置摘要，并提供普通控制出入口；缺失版本显示不可用，图标采用受控映射。命名控制端口只有结构与转换支持，尚无对应 Manifest、路由交互或 Branch 实现。画布从受鉴权 HTTP 取得真实 Workflow Draft，以完整 WorkflowDefinition 派生 React Flow nodes / edges。onNodesChange 只将位置回写 ui.position，onConnect / onReconnect / onEdgesDelete 使用上述适配操作；选择和测量状态留在表现层，受控 React Flow 的测量结果由视图缓存承接；Tailwind loader 只处理 globals.css，CSS Module 保留原生类名导出。现有节点配置、Preset、静态绑定、Workflow 输入输出及两类边均保留，未知类型显示不可用但不会因移动或保存丢失。当前不开放节点添加、删除及配置表单，也无发布或模型选择入口。

### Web Workflow Draft 持久化

CanvasPage 先读取项目，再 GET 默认 Workflow；查询失败不以本地空图兜底。旧项目 GET 404 时显示“初始化工作流”，只有用户点击才 POST，初始化成功取得真实身份、revision 和草稿后进入画布。正常新项目直接读取创建时已有的默认 Workflow。节点目录失败不清空已读取草稿，连线操作在目录就绪后才开放。

useWorkflowDraft 持有 Workflow ID、revision、完整定义和已确认保存快照。保存草稿提交 expectedRevision 与完整 definition，只使用共享草稿协议，不复制严格发布校验。保存成功推进 Workflow revision，仅确认本次提交的快照；请求期间的新编辑继续显示未保存。网络、服务端或响应协议失败不推进客户端修订、不清除本地修改；409 锁住草稿保存，明确提示冲突。用户可取消重新读取并保留修改，也可确认放弃当前图修改后读取服务器版本；重新读取失败继续保留本地图和冲突。

项目名称 / 视口与 Workflow 分别保存、分别显示状态和 revision。Project 保存及冲突重读不替换图，Workflow 重读不覆盖项目名称 / 视口。Cmd/Ctrl+S 保存草稿；点击返回项目或关闭 / 刷新页面时，若有未保存或尚未确认的修改则提示。编辑器查询不在窗口聚焦或网络重连时自动重载，以免替换本地修改。后台会话检查的临时故障保留编辑器并提示重试；明确 401 / 403 仍隐藏受保护内容，所有保存照常由服务端鉴权。刷新或重新进入通过 HTTP 重建画布。保存不发布版本、不创建运行。

Web 单元测试覆盖 HTTP 契约、失败状态、保存期间编辑以及 adapter 完整字段往返。独立 Playwright 测试经真实 API / PostgreSQL 验证新项目、旧项目显式初始化、已有草稿移动 / 连线删除后的保存刷新、修订独立、409、读取与保存失败、后台会话检查的临时故障 / 访问拒绝及越权页面。测试不调用外部模型；普通测试图通过正式 HTTP 写入，仅旧项目场景直接构造无 Workflow 的历史数据。运行方式见[开发指南](development.md#web-workflow-浏览器验证)。

## 目录与依赖

| 目录               | 当前职责                                                                        | 后续边界                               |
| ------------------ | ------------------------------------------------------------------------------- | -------------------------------------- |
| apps/web           | 身份、账户、项目画布、目录查询、通用 renderer 与适配                            | 创作交互，不加载服务端插件或密钥       |
| apps/api           | 认证、资料、项目、默认 Workflow 编辑、节点目录与 Runtime Service                | 模块化业务入口、权限与应用服务         |
| apps/worker        | 独立进程，基础设施、Runtime Service、Outbox Pump 与任务消费者                   | 独立执行进程，不自建图调度语义         |
| packages/server    | 数据库、Checkpointer、运行 Repository 与装配 factory、Redis、对象存储和凭证加密 | 不包含 HTTP、认证或业务流程            |
| packages/contracts | 身份、项目、Workflow 与 Node 的中立 JSON 协议                                   | 不依赖前端、数据库或 Runtime 框架      |
| packages/database  | Prisma 与身份、基础项目和运行记录持久化                                         | 模型、迁移按实际业务增加               |
| packages/workflow  | 值契约、数据 / 节点 Registry、运行接口及编译包装                                | 先确定 Graph Model，再接入执行与持久化 |
| packages/plugins   | ProviderPlugin、PluginRegistry 与 OpenAI-compatible 文本能力                    | 受信任静态适配，无隐式供应商选择       |
| packages/context   | 空入口                                                                          | 独立构建明确选择的上下文               |

不为附件目录示意重命名为 common / client，不为未来概念建立空壳执行器。API 与 worker 通过服务和契约协作；第三方类型在适配层转换，不进入 contracts。

contracts/src 的 identity.ts 与 project.ts 分别承载身份与项目协议，workflow/ 和 node/ 承载工作流与节点协议，NodeRun / WorkflowRun 领域记录各归 workflow/ 下同名文件，data/ 和 content/ 承载值与内容协议。workflow/src 分为 definition/、data/、node/、runtime/、compiler/、run/；server/src 分为 database/、checkpoint/、workflow/、redis/、storage/、secrets/。API 的 health/ 与 http/ 保留 HTTP 职责，基础设施不反向依赖 API，worker 不再依赖 API 应用包。

LangGraph 是核心 Runtime，平台不再建设图调度、Checkpoint 或暂停恢复状态机。Queue / Worker 后续处理长异步作业、跨运行与供应商限流，不决定图中下一个节点。一个项目一个逻辑 Workflow 的边界不变，子流程只引用其他项目固定版本；当前没有对应持久化、发布或运行应用接口。
