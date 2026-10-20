# 开发指南

按 README 初始化环境，根任务自动加载根目录 .env。前端端口 3000，API 3001；直接启动单个应用时需自行传入环境变量，不复制秘密文件。不提交真实凭证及本地环境文件，密钥规则见 [认证与安全](authentication.md)。

已实现能力与目录职责见 [当前架构](architecture.md)，平台设计边界见 [平台核心模型](platform-model.md)，当前阶段与下一步见 [分步设计与实施方案](implementation-plan.md)。开始新模块前对照当轮具体范围，不自动恢复旧业务或一次性实施整个路线图。

共享包通过 dist 暴露；根 Turbo 任务先构建依赖。前后端业务目录保留 .gitkeep，加入实际文件后可删除该占位文件。空包入口只标识预留结构，不可当作可用功能。

修改基础服务后运行相关 typecheck、lint、build；需要真实基础设施时运行 pnpm test:storage 或 pnpm test:integration。contracts / workflow 的 Manifest、三类静态 Binding、Data / Control Edge 与联合 DAG、值校验、快照及泛型 LangGraph 适配，以及 web 的整图转换和 renderer 测试接入 pnpm test；pnpm check 同时检查源码与测试的类型。没有测试的空业务包不设置虚假的通过测试任务。

工作流基础开发先阅读 [Runtime 架构](runtime-architecture.md)。复用 LangGraph 的 StateGraph、Checkpoint、Interrupt / Resume、Send 和条件路由，使用真实 LangGraph 测试编译适配；MemorySaver 仅显式用于单元测试，应用使用共享服务的官方 PostgreSQL Checkpointer，不提供内存兜底。普通节点操作的值校验测试与图执行测试分开，不能用单节点成功证明整个 WorkflowDefinition 已可执行。

普通确定性依赖编译须检查 Data / Control Edge 均计入依赖、按目标聚合与来源去重，同一节点对的混合边或不同数据端口不重复计数。验证原始边及 portKey 保持完整、依赖编译不读取端口；单上游生成字符串边、多上游只生成一条数组 Join Edge。使用真实 LangGraph 验证混合边去重后，两种上游完成顺序及不同长度路径下均等待全部完成且目标只执行一次，并覆盖上游失败。条件候选分支不套用此规则；这些测试不代表输入绑定、生产 WorkflowState、整图编译或真实模型调用已接入。

BindingResolver 测试使用真实静态转换实现，检查 Data Edge 端口映射、常量按目标声明 dataType 内联包装、workflow_input 原样复用 inline / reference，以及 asset 引用保留明确版本。上下文显式提供精确版本 Manifest，测试未知静态 / 数据目标端口报 INPUT_PORT_NOT_FOUND、缺失工作流输入报 WORKFLOW_INPUT_MISSING，并保留来源冲突、缺失上游输出及继承属性不可作为值的回归。覆盖空值 / 数组等常量、不做类型猜测或业务 Zod 校验、不同资产版本不互相改写、引用不被 decode、输入上下文不被修改及网络调用防护。静态校验的冲突 issue.params.code 与运行错误均使用 INPUT_SOURCE_CONFLICT。引用包装不证明资产存在、版本 / 权限可访问或完整 NodeExecutor 已接入。

RuntimeValueCodec 测试检查 inline 原样返回且不调用引用服务，reference 保留引用与最小上下文后委托 DataReferenceResolver。验证媒体 / 领域对象原样返回、引用失败 code / cause、并行解码、按原键返回、空 map 与整体失败；只处理自有键且不污染原型。输出编码检查显式策略绕过 auto、统一类型规则不按大小猜测、未知规则报错、JSON 承载边界、Writer 收到原始业务值 / 类型 / 输出定位、无效引用与写入失败不回退或重试。替身不证明真实存储、授权或 signed URL 已接入。

Action NodeExecutor 测试用仅测试注册的 math.add 与真实 Registry / BindingResolver / Codec，验证精确版本、严格步骤顺序、三组 Schema、默认 / 转换后逐端口编码，以及定义 / State 不变。用测试视频节点检查 reference video 与 inline duration、Writer 上下文、校验失败不写入及写入失败停止后续端口。分别覆盖业务阶段失败摘要 / cause 与后续步骤停止，及 createRunning / updateInputs / markCompleted 故障原样传播、均不调用 markFailed；完成记录确认前不返回执行结果。覆盖三类真实 Binding 错误的 resolve_input 摘要、Registry / 非 action 拒绝、非 Error 异常和 GraphBubbleUp 穿透且不记 failed、创建 / 输入 / 完成记录顺序，以及 markFailed 再失败时保留双重原因。真实 StateGraph / MemorySaver 仅测试 interrupt / Command 传播恢复，不证明生产持久化或审核。编译包装检查只返回自身输出增量、不改原 State、项目运行身份取自 state.run、配置传递及失败透传。

State 测试用真实 WorkflowStateAnnotation 验证 outputs 缺省空 map、独立调用初始化、纯合并不修改输入、同 step 重复 nodeId 冲突与跨 step 隐式覆盖拒绝，包含原型相关键。使用真实 Registry / BindingResolver / Codec / Executor / Action 策略和 DependencyCompiler 构造 A、B → C，控制两种完成顺序，检查双方输出完整保留、C 通过 Data Edge 读取两份值且只执行一次。DefaultWorkflowCompiler 的整图用例另外覆盖根 / 叶连接、混合边去重、两种完成顺序、空图与精确版本拒绝；这些测试不证明真实 Artifact 持久化或生产运行服务已接入。

NodeRun contract 测试独立放在 contracts/test/node-run.test.ts，验证三状态、ISO 时间、RuntimeValue map、字符串阶段及可选错误码的 JSON 往返。NodeRun 的数据库集成测试先经真实 WorkflowRun Repository 创建父运行，再使用真实 PostgreSQL、Repository 和 Executor，并经 Action wrapper / outputs reducer 验证先失败再成功的两条历史。另注入完成记录服务故障，验证 NodeRun 不反向 failed、输入仍保留、State 无输出。检查最小创建参数连续分配 attempt 1/2、任意非空错误阶段 / 可省略 code、Binding 失败、RuntimeValue 快照不含解码媒体 URL、并发 attempt、唯一约束、输入只写一次、终态不可覆盖及所有者 / 项目 / 运行隔离；内容服务仍是测试替身。

WorkflowRun contract 测试检查六状态、独立 thread、ISO 时间、输入与最终输出 RuntimeValue map；现有配置适配测试同时接受完整运行对象。WorkflowRun Repository 的数据库用例不 invoke LangGraph，覆盖完整等待再运行路径、30 组合法 / 非法转换、首次时间不变、终态并发竞争、thread 唯一、固定版本与输入、权限隔离、NodeRun 同项目外键与级联删除。

WorkflowRunner 单元测试用真实 StateGraph / MemorySaver、Registry、BindingResolver、Codec、Executor 和普通 Action Compiler，检查首次启动的完整顺序、thread 来自已保存 Run、输入初始值、快照隔离、项目 / 工作流 / 版本错配及 draft 拒绝。原生 interrupt、静态断点和只返回 State 的 invoke 适配均验证 waiting；缺失或错误 checkpoint、节点错误、最终输出缺失、编译错误及记录服务故障验证相应失败边界。WorkflowOutputResolver 另检查按名称收集引用、不泄漏内部节点结果、缺失来源 / 继承属性 / 类型错误。

workflow-resume.test.ts 用同一 MemorySaver 重新编译原图，验证 waiting → running → waiting → running → completed、只传 Command 和原 thread、已完成节点不重跑、State 输出与首次时间保留，且不查询或关联 NodeRun。覆盖 false / 0 / 空字符串 / null / 特殊对象键的值原样进入中断节点、非 waiting / 缺失记录拒绝、调用方版本 / thread 覆盖拒绝、claim 失败不 invoke、原 checkpoint 缺失 / END / 身份错配、准备 / 执行 / 记录故障边界。Runner 的 executeStart / executeResume 共用结束分类与最终输出解析。

test/workflow-versions.e2e-spec.ts 在真实 PostgreSQL 经 WorkflowService 保存 / 发布，验证 V1 = A、修改草稿后 V2 = B 且 draft = B，新 Repository 和独立数据库连接仍能读取 V1。约束异常测试保留显式建数，覆盖版本全部字段不可更新、单项目单 Workflow、版本唯一及正数约束、权限、无效 Definition 拒绝和删除级联。

test/workflows.e2e-spec.ts 使用真实服务和两个独立数据库连接，检查 12 次同修订并发编辑只成功一次、过期发布不生成版本、12 次同修订并发发布只生成一个版本并返回明确重复发布冲突，以及新修订继续获得下一版本号。用 PostgreSQL 阻塞信息验证发布实际等待未提交编辑行锁，编辑提交后以新 revision 拒绝过期请求，不依赖固定 sleep 猜测顺序。另覆盖发布重新校验存储草稿、失败不消耗版本号、输入必填 / 严格字段、所有者与过期权限、来源修订唯一 / 正数约束。此文件不测试 HTTP、运行或持久 checkpoint。

test/workflow-runner.e2e-spec.ts 使用真实 PostgreSQL 的版本、WorkflowRun、NodeRun Repository、普通 Action Compiler 和生产 provider 的官方 PostgresSaver，验证首次成功、节点失败、原生暂停、NodeRun completed 但最终输出解析失败、编译失败、完成记录不可用时不反向 failed。版本快照在测试中显式建数，Runner 经生产读取实现获取。用 pnpm test:integration 在 dramaflow_test 运行，测试只清理自己创建的用户、项目、级联记录及 thread checkpoint，不清空开发库。可定向执行 workflows、workflow-versions、workflow-runner、workflow-runs、node-runs、persistent-checkpoint、workflow-runtime 七个 e2e-spec；这些测试不证明 Artifact 或运行 HTTP 入口已接入。workflow 包另验证提交时版本读取返回 null 不创建运行；执行时版本读取失败由 claim 成功者记录 load_version 失败。

test/persistent-checkpoint.e2e-spec.ts 是真实 PostgreSQL 跨进程测试，不用 MemorySaver：启动进程 A 的 Nest / Repository / Saver / Compiler / Runner，interrupt 后等待 A 完全退出；再启动 B，从原 workflowVersionId / threadId 恢复并完成。期间通过真实 WorkflowService 更新 / 发布新版本，检查原输入、已完成节点和原版本仍有效。两个全新进程另用 IPC 屏障先同时读到 waiting，释放后只有一个 claim 成功且进入 graph.invoke；第三项验证不可用 checkpoint 数据库使 Nest 初始化失败。子进程导入生产持久化模块与 Repository，原生 interrupt 图是测试专用 Compiler，不能视作 HumanReview 产品或 NodeRun waiting 实现。测试清理只调用官方 deleteThread 删除自建 thread，并关闭连接。health.e2e-spec 验证真正 API 启动和 checkpoint 读取健康项。

test/workflow-runtime.e2e-spec.ts 动态加载正式 API / Worker AppModule 编译产物，不覆盖生产 provider。验证 API 没有 Runner factory / ExecutionService、Worker 完整 DI、API 事务提交 pending / Outbox 后由实际队列 Consumer 完成同一 Run，以及权限、未知节点、引用未配置和缺失 checkpoint 的边界。生产 Registry 仍为空，不把空图当作已交付业务节点。

test/workflow-run-api.e2e-spec.ts 使用两个真实 HTTP API、密码会话 / 签名 Cookie，并启动独立 Worker 子进程。验证没有 Worker 时也能返回 202 / pending、GET 完成输出、API 进程不执行 Runner、两轮恢复 / 0 值、同等待周期并发提交单意图 / 409、跨用户不可见、字段严格校验及 Redis 入队未确认返回安全 503。原生等待图只存在于测试子进程，不注册生产交互节点。

test/workflow-queue.e2e-spec.ts 使用真实 PostgreSQL / Redis、正式 Submission / Dispatcher / Consumer，并对独立子进程执行 SIGKILL。覆盖提交事务后未 enqueue、enqueue 后 published 尚未提交、Worker 收件或 claim 后死亡、BullMQ stalled 重投、连续两轮 resume 与 Redis 旧 Job 删除后重投的持久去重。额外验证数据库触发器强制 Outbox INSERT 失败时 Run 一同回滚、投递失败保留意图 / 尝试次数、claim 前临时基础设施故障重试，以及真实 NodeRun execute 失败只记 attempt 1、队列不跑五次业务执行。claim 后结果不明保留 running，意图 recovery_required；不以自动重跑冒充安全恢复。

恢复的数据库用例另外验证同一运行经过两次 resume 完成、同一 State 输出保留、运行记录与 thread 数不增加、恢复失败结束同一记录。两个不同 Repository / Runner 实例通过屏障先都读到 waiting，图执行期间只有一个 claim 成功并 invoke，另一个收到 WORKFLOW_RUN_NOT_WAITING。Repository 用例另测试 12 个并发 claim 的单胜者、完整六状态读取、所有者 / 项目 / 过期权限与非 waiting 不更新；不以纯内存替身证明并发持久化正确。

节点类型开发对照 [Node 模型](node-model.md) 与 [Manifest 实施说明](node-type-implementation.md)。分别验证纯 JSON Manifest 的配置类型 / 默认值、输出 storagePolicy 可选且枚举合法 / 输入不接受该字段、服务端三组 Zod 与声明字段一致、精确类型版本注册以及 listManifests 的白名单与数据隔离。Preset 只测试配置模板行为，不作为 Registry 身份；保留 transform 和默认值不回写定义的回归。

正式 WorkflowDefinition 测试检查三类 StaticInputBinding、两类边引用与全局 ID 唯一、自连接及联合 DAG；Data Edge 另检查目标数据端口单连接与静态 Binding 冲突，Control Edge 不占用输入并允许多个控制上游。检查控制端口可省略或命名，拒绝旧 ConnectionBinding。通用 factory 继续用独立自定义 Schema 测试，不强加正式 Node 协议。静态成功不证明端口存在、真实值有效或资产可访问，也不替代独立依赖收集与运行输入绑定检查；assetId / versionId 只是明确版本的引用声明。

React Flow 测试检查两类边 ID / 端点往返、edge.data.kind 与控制 Handle 命名空间、控制端口省略与命名映射、跨类连线拒绝，以及删除 / 重连按边种类与完整快照防止误改。数据连线还检查精确版本 Manifest、共享 isTypeAssignable、目标单连接与数组输入不聚合、移除被显式替换的静态 Binding；节点转换检查临时字段剔除，renderer 检查数据端口 key、普通控制 Handle 与不可用状态。目录 API 使用真实默认鉴权与 no-store，前端处理加载、错误与空态；生产 Registry 为空，不用假类型填充。画布已接入两类边事件，但没有节点添加与 Workflow 保存入口，项目保存继续只处理名称、视口和 revision。

数据库模型在 packages/database/prisma/schema.prisma 定义。执行迁移前核对 DATABASE_URL 仅指向本项目开发库，再运行 pnpm db:migrate。迁移影响范围与操作方式统一见 [部署与数据库](deployment.md)。

开发环境允许按需要重建数据，但不能把此授权用于其他项目或生产环境。新增迁移时审查 SQL，并同步文档；不要为已删除的开发业务增加历史协议兼容层。

认证相关开发先阅读 authentication.md。新增业务 API 默认受 AuthGuard 保护，公开接口需显式 Public；修改角色、停用或会话逻辑后执行隔离数据库集成测试。

项目接口或保存协议变更后，执行 pnpm check 和 pnpm test:integration，重点验证名称/视口边界、所有者隔离、分页、revision 冲突及旧节点/插件字段被拒绝；浏览器检查登录、新建项目、名称和视口保存、重新加载及账户中心。画布当前仅查询节点目录，项目保存接口不保存或执行节点；独立的 State / Action 适配测试覆盖确定性数据流，不覆盖应用运行入口、生产持久化、队列或真实模型。

仅更新架构和规划文档时，检查 Markdown 格式、相对链接、当前实现描述及模型约束的一致性；不把未运行的构建、集成测试或模型调用写成已通过。后续各步新增真实能力后，再更新相应验证范围。

## 文档维护

文档是随实施修订的当前说明。每个主题保留一个主要维护入口，其他位置仅保留必要摘要与链接，避免同一阶段或方案存在多份独立维护的正文。

根 AGENTS.md 只保留稳定约束和按任务选读的入口，不复制实现清单、字段定义、路线图或专题正文。更新功能时直接修改对应 docs；只有跨任务长期适用的协作规则才加入 AGENTS.md。开始任务按需读取相关主题，不为一次局部改动自动加载全部 docs 或新增同样冗长的子目录规范。

| 入口                               | 主要维护内容                                                    |
| ---------------------------------- | --------------------------------------------------------------- |
| `AGENTS.md`                        | 简短的稳定协作约束与按任务选读入口                              |
| `README.md`                        | 项目简介、启动入口、简要能力说明与文档导航                      |
| `docs/architecture.md`             | 已实现能力、当前结构和实际依赖边界                              |
| `docs/platform-model.md`           | 仍有效的平台定位、概念与顶层设计边界                            |
| `docs/workflow-model.md`           | Workflow 静态定义、版本、输入输出及运行关系                     |
| `docs/node-model.md`               | Node 实例、有效类型契约、Preset、调用和运行记录边界             |
| `docs/node-type-implementation.md` | 纯 JSON Manifest、配置字段、服务端 NodeType、目录与通用节点边界 |
| `docs/runtime-architecture.md`     | 技术职责、Workflow / Node 编译、LangGraph 执行及恢复边界        |
| `docs/implementation-plan.md`      | 当前阶段、设计顺序、下一步与待决策项                            |
| 认证、存储、部署、前端等专题文档   | 对应主题的当前实现、操作方式或有效规范                          |
| 应用与包的 README                  | 本目录职责、局部限制及相关文档链接                              |

每轮实施在交付前完成以下维护：

1. 按最新明确需求、已确认设计和实际代码核对受影响文档，分别更新设计结论、已实现能力及实际验证范围。设计尚未落地时明确标注；文档与代码冲突时核实并修正，不能将旧文档当作当前事实。
2. 原地替换过时方案和状态，合并重复内容；不再适用且没有独立价值的文档直接删除。同步修复导航、相对链接与锚点引用，不为保留旧文本增加兼容说明或另建一套并行方案。
3. 历史过程交给 Git 追溯，不把逐轮交付记录、本机数据数量或一次性操作结果堆入长期指南。仍影响部署的数据变更范围、必要操作与风险继续保留；确有必要保留的决策背景明确标注历史用途及当前结论。
4. 检查变更文档的格式、链接和状态一致性，在交付说明中简述更新、合并或删除的内容以及实际检查结果。不要把未执行的验证写成已通过。

## 定向验证范围

按改动选择 contracts 的数据 / 节点协议测试、workflow 的 Registry / 编译包装 / State 通道与并行增量 / 输入解析 / Codec / 存储策略 / Action Executor 测试，以及相关 API / Web 类型检查和定向用例。DataType / RuntimeValue / Artifact / Asset 的结构测试不代表已有内容持久化；WorkflowRun / NodeRun 生命周期另执行隔离 PostgreSQL 集成测试；生产 Checkpointer 的恢复能力用跨进程数据库测试验证，不能用 MemorySaver 单元测试替代。State 增量适配和执行主干不代表已有真实 Artifact 写入或完整图运行接口。避免例行全量测试和浏览器测试，不因修改共享类型而重跑无关存储、认证或部署检查。

WorkflowExecutionJob 契约单测检查仅携带业务 Run ID、resume executionId / value，严格拒绝 State / Definition / thread / version 副本并保留 falsy 值。workflow-run-submission.test.ts 的内存 Repository / MemorySaver 只验证提交与执行分离，不作为生产事务 / Queue 证明；实际事务回滚和崩溃重投由上述 PostgreSQL / Redis 集成覆盖。
