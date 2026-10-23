# 当前架构与目录职责

只记录已实现能力及其入口。协议见 [Workflow](workflow-model.md)、[Node](node-model.md)、[数据模型](data-model.md)、[Runtime](runtime-architecture.md)；当前工作与待决策项见[实施方案](implementation-plan.md)。精确字段以 contracts、Schema 和 Controller 为准。

## 已实现的基础工程

| 领域       | 当前能力与边界                                                                                                         |
| ---------- | ---------------------------------------------------------------------------------------------------------------------- |
| 身份与项目 | 登录、账户中心、项目所有者隔离；每项目一张画布、一个逻辑 Workflow                                                      |
| Editor     | 草稿加载 / 保存、节点创建 / 移动 / 删除、Data / Control Edge、候选输入、文本变量与模型选择、End 输出配置；无节点重命名 |
| Publish    | 静态语义、同 Owner 模型绑定校验、不可变版本；保存和发布独立                                                            |
| Run        | 已发布版本提交、幂等身份、状态查询、离开保护和 invocation identity recovery                                            |
| Result     | completed Run 展示 declared outputs；支持 inline 与 reference 身份，尚无 Artifact 内容 HTTP API                        |
| 执行       | Action DAG、简单 If 与分支区域外的串行 Human Review；独立 Worker 执行                                                  |
| 基础设施   | PostgreSQL / Prisma、Redis / BullMQ、RustFS、官方 PostgreSQL Checkpointer                                              |

End 是 `definition.outputs` 的画布投影，不是 NodeType，不进入 nodes、Registry 或执行链。首条业务输出拖到 End 创建独立输出；已有输出时明确选择新建或加入某项候选。候选共用一个输出名称，分别投影连线，删除连线或节点仅清理对应候选；不足时保留可修复 Draft，不转换成单 source。单 source 仍保留原编辑与删除行为，类型按精确版本 Manifest 校验。End 位置仅在当前页面保留，声明从 Definition 恢复；保存与发布分开。协议与准入见 [Workflow](workflow-model.md#输入与输出)。Start Boundary 和 Workflow Input 编辑器尚未实现。

## Workflow 基础库

`packages/contracts` 定义中立 JSON 协议；`packages/workflow` 负责 Registry、发布 / 调用校验、编译和执行适配。运行绑定指定 WorkflowVersion，不读 draft / latest。Action DAG 的联合依赖与技术执行预算见 [Runtime](runtime-architecture.md#action-dag-技术执行预算)。

## Human Review 声明与纯业务边界

`flow.human_review@1` 已进入生产 Registry / 节点目录，执行种类为 interaction，不提供 Action execute 或审批控制出口；Draft、Publish / Compile / Run 已接入独立 HumanReviewNodeCompilationStrategy；其他未知 interaction 仍以 NODE_EXECUTION_KIND_UNSUPPORTED 拒绝。节点标题使用 NodeDefinition.name，不另加 title config。

[Human Review V1 协议](../packages/contracts/src/workflow/human-review.ts)定义严格文本 input、可选静态 instruction、approve / reject decision 与稳定业务 output。合法 reject 是正常业务结果；content 原样透传，缺省 feedback 归一化为空字符串。payload 固定 human_review / schemaVersion 1，保留 RuntimeValue 结构及未来 reference 表达；[纯转换函数](../packages/workflow/src/node/human-review.ts)只接受 string 业务输入，构造 inline string payload，不解释 instruction 模板、不读取 Artifact，也不调用 interrupt。payload 不含 Run / thread / NodeRun / interrupt 身份；Decision 的版本由 V1 Schema/type 名称明确。

[专用策略](../packages/workflow/src/compiler/human-review/strategy.ts)复用 BindingResolver、Codec 和节点 Schema，解码前拒绝 reference content，再调用官方 interrupt(payload)。恢复值经 V1 decision Schema 校验后输出三个 RuntimeValue；缺省 feedback 为空，reject 正常完成，可把 action DataEdge 接入 If.value 控制后续分支。Runner 继续负责 checkpoint 检测、WorkflowRun waiting 与 Command.resume，正式 HTTP 恢复必须携带当前审核 token / waitingRevision，协议见下方 [Human Review 查询与恢复](#human-review-查询与恢复)。

Publish / Compile 共用 Human Review 能力门禁：支持分支区域外有明确依赖先后的串行审核，包括审核后进入 If、已证明 Direct Convergence 的 Candidate 输入进入审核；拒绝 If branch region 内审核和彼此无先后依赖的并行待审批（HUMAN_REVIEW_TOPOLOGY_UNSUPPORTED）。静态 DAG 与 If execution projection 的最长路径仍提供每次调用的技术预算，原生 MemorySaver 测试覆盖初次暂停、resume 和两次串行审核。恢复只重入当前审核函数，上游已完成 Action 不重跑；interrupt 前只做输入解析与可复用的审计持久化，不调用 Provider。

Human Review 已有正式 NodeRun 审计：首次进入创建 attempt 1 running、首次记录 RuntimeValue inputs；WorkflowRun waiting 时 NodeRun 保持 running，interrupt 身份以 checkpoint 为权威，不写入 NodeRun outputs。resume 重入获取同一记录，比较重新解析的 inputs 与首次快照（对象键顺序无关），不再次 updateInputs。decision / 输出校验及编码成功后 markCompleted，再提交 State；approve 和 reject 均正常 completed。业务错误将原记录记 failed，原生 GraphInterrupt / ParentCommand 不记失败；仓储失败不反向标记业务 failed。

[审核专用 Repository](../packages/server/src/workflow/runtime/node-run-repository.ts)在原有事务 advisory lock 内获取 / 创建记录，核对 Owner / Project / Run、已 claim 的 running Run、固定 WorkflowVersion 中的精确 Human Review node，以及唯一 attempt 1 running 历史；终态、多 attempt 或错误节点 / 版本明确拒绝，不按 latest running 猜测，也不自动新建 attempt 2。inputs 仍受原有一次写约束保护，完整执行的串行性依赖 Run / Outbox 的数据库 claim，获取 / 创建本身的唯一性由节点锁与既有唯一约束保证。Action createRunning 继续原子分配新 attempt。

该复用键仅适用于当前无环、每节点每 Run 一次逻辑审核的能力边界。未来 Loop / Iteration 必须增加显式 execution occurrence identity；本轮没有新增发生次数模型、NodeRun waiting、数据库字段或约束。审计 completed 与 Graph checkpoint 不构成跨系统原子提交；异常中断后的对账 / recovery_required 仍沿用既有边界，不重放终态记录。待审批查询与 targeted resume HTTP 已接入，Web 审批与 Artifact 预览待后续任务。

## Workflow 编辑 HTTP API

业务接口均在 `/api/v1`，默认认证、no-store；写入检查 Origin，资源不存在或无权访问统一 404。

Project 使用 `GET / POST /projects`、`GET / PUT /projects/:id`；Workflow 使用 `GET / POST /projects/:projectId/workflow` 和 `PUT /workflows/:workflowId/draft`。Project 名称 / 视口与 Draft 各自维护 revision。初始化幂等，保存冲突返回 409，保存不发布或执行。请求与响应见 [Workflow contracts](../packages/contracts/src/workflow/workflow-api.ts)。

## Workflow 发布与版本 HTTP API

发布入口 `POST /workflows/:workflowId/publish`；版本摘要 `GET /workflows/:workflowId/versions`；固定版本 `GET /workflow-versions/:versionId`。发布锁定来源修订并原子分配版本号，失败不写版本；不解密凭证或调用模型。当前拒绝 Asset 绑定及未支持执行种类。精确 flow.if@1 已支持原生条件路由；Publish 与 Compiler 共享简单拓扑分析，放行分支内串行 / 并行 / ALL join 和静态证明安全的直接汇聚；汇聚按互斥 completion groups 编译为原生 edges / barriers，共同必需上游进入每一组，不新增领域汇聚节点或执行 step。候选输入可独立形成汇聚依赖，无需额外 ControlEdge；仅允许同一 If 两侧各一个来源并满足直接汇聚证明。仍拒绝不安全汇聚、普通单来源绑定直接读取互斥分支、嵌套 If 与不同 If region 交叉。Web 复用 Generic Node 编辑 string value、四种单条件和 true / false 命名控制出口；允许保存不完整 Draft，未知条件不静默改写。协议与能力限制见 [Node](node-model.md#if-条件节点与编译能力边界)。

## 生产 Runtime 装配

API 装配 Submission / Queue；Worker 装配 Consumer、Outbox Pump 和执行服务。执行服务核验持久意图，从 Run 派生项目 / 所有者，再创建有权限作用域的 Runner、Executor、能力和 Artifact 服务，不跨用户缓存。Node 目录与执行共用 Registry，服务对象不进入 State / checkpoint。

### Web 基础发布

dirty、修订冲突或保存未确认时禁止发布；发布锁定 Draft 编辑，不隐式保存或运行。当前保存修订的发布状态与最新版本分别展示，重复发布按 sourceRevision 找回版本，不拿 latest 猜测。目录刷新失败仍保留已确认身份；定位信息保留，但未实现自动聚焦或版本历史管理。

## Workflow Run HTTP API

| 方法与路径                                                  | 行为                                                                |
| ----------------------------------------------------------- | ------------------------------------------------------------------- |
| POST /workflow-runs                                         | 固定 workflowVersionId、invocationKey、inputs；受理返回 202         |
| GET /workflow-runs/:runId                                   | 安全 Run projection，含可选 outputs / error，不含 threadId          |
| GET /workflow-runs/by-invocation/:workflowId/:invocationKey | 授权 Workflow 下只读 lookup，返回 `{ run }` 或 `{ run: null }`      |
| GET /workflow-runs/:runId/pending-human-reviews             | 查询当前单个待审核产品对象；非 waiting 返回空 items                 |
| POST /workflow-runs/:runId/resume                           | 指定 interruptId / expectedWaitingRevision 与 V1 decision；202 受理 |

Start key 的等价性与终态保留规则见 [Workflow](workflow-model.md#start-invocation-身份)。入队确认失败返回 `WORKFLOW_QUEUE_UNAVAILABLE`（503），携带已持久化的 Run ID / key。lookup 不创建 Run / Outbox、不投递或执行；查无结果不能证明原 POST 不会稍后提交。

### Human Review 查询与恢复

[HTTP Contract](../packages/contracts/src/workflow/workflow-run-api.ts)的 Pending 响应为 `{ items }`，每项包含 opaque interruptId、waitingRevision、固定 WorkflowVersion 的 node id / name、纯文本 content、可选 instruction 与 submissionStatus（pending / submitted）。Run 非 waiting 返回空数组；没有通用 checkpoint inspection API，不返回 RuntimeValue wrapper、thread、task、namespace、NodeRunId 或完整 Definition。所有查询和提交均按 User → Project Owner → Run 授权，token 不能代替权限。

[产品服务](../packages/server/src/workflow/human-review.service.ts)在授权 Run 行锁内使用官方 Saver.getTuple 读取原 thread 的 head checkpoint，验证运行身份，并适配 LangGraph 1.5.0 的 INTERRUPT pending write。只接受 HumanReviewInterrupt V1 与 inline string；名称读取原版本，不读 Draft / latest。多个 pending interrupt 返回 HUMAN_REVIEW_CAPABILITY_UNSUPPORTED；未知 kind 或损坏 payload 返回明确的 HUMAN_REVIEW_INTERRUPT_UNSUPPORTED / INVALID（409），不伪装成审核。

POST `/resume` 的严格请求为 `{ interruptId, expectedWaitingRevision, value: { action: "approve" | "reject", feedback?: string } }`。旧裸 `{ value }` 不再属于产品 HTTP 协议；底层通用 Submission / Runner 仍供内部运行与测试使用。服务在同一 Run 行锁内验证 waiting、revision 完全相等、token 为当前 pending 审核，再原子写 Outbox。陈旧 token / revision 返回 HUMAN_REVIEW_STALE（409），不会创建恢复意图。

当前 revision 存在任意已持久化 resume intent 时 submissionStatus 为 submitted，包括投递未确认和 recovery_required；不暴露 Outbox 状态机、不允许修改已提交决策。沿用既有冲突语义：相同请求重复提交或不同 decision 均返回 WORKFLOW_RESUME_ALREADY_SUBMITTED（409）；Worker 已 claim 时可返回 Run 非 waiting 冲突。POST 202 不保证 Run 已变 running。投递 503 后可查询 Pending 确认 submitted，不能盲目再次提交。

Outbox 复用现有 value JSON，保存 `{ kind: "targeted_interrupt", interruptId, value: decision }`，waitingRevision 仍使用原列；无新增 DB / Job 顶层字段。Dispatcher 从持久化 Outbox 投递，Worker 校验 Job 与持久化 payload 完全一致后解包；Runner 验证当前 checkpoint 中的目标，再构造原生 `Command({ resume: { [interruptId]: value } })`。Runner 不解释 decision。通用单 interrupt 的兼容路径不用于正式 Human Review HTTP。

## Workflow Execution Queue

新 Run 与 start Outbox 同事务提交；resume 按 waiting 周期创建唯一意图。Job 不复制定义、State 或 thread。Worker 原子 claim 后执行，claim 前基础设施故障可重投，业务失败不自动重跑。

claim 后进程退出或结果不明进入 recovery_required；已完成或进入下一 waiting 周期时只补记意图，不重新 invoke。尚无 recovery_required 人工处理入口。队列配置和数据保留见[部署](deployment.md#workflow-执行队列)。

## PostgreSQL Checkpointer

API / Worker 启动时初始化官方 PostgresSaver，不提供内存回退。它与业务表使用同一 DATABASE_URL、独立连接池和 langgraph schema；初始化、备份与恢复见[部署](deployment.md#langgraph-postgresql-checkpointer)。

## 文本 AI 与 Provider Plugin

生产调用链是 Node → `text.generate` → ModelConfiguration → Provider Instance → ProviderCapability → Plugin → Provider API。节点只保存 modelConfigurationId，调用时重新验证 running Run、Run 项目权限、模型及 Provider Owner 与 enabled，再解密本次凭证；无默认厂商、自动替换或全局 credential 缓存。

| 插件                | 当前用途                                                |
| ------------------- | ------------------------------------------------------- |
| text_generation@1   | 正式 OpenAI / Anthropic 文本实现，SDK 只在插件内部使用  |
| openai_compatible@1 | 高级 Custom OpenAI-Compatible，可显式配置兼容地址与模型 |

两个插件关闭自动重试并隔离日志 / tracing，拒绝 redirect、空白、截断、过滤、工具调用等无效文本；成功正文包含本次实际 API credential 时以 `CAPABILITY_OUTPUT_INVALID` 拒绝，不返回正文、不重发。错误投影不带原始请求、响应或凭证。参数边界以[插件 Schema](../packages/plugins/src)为准；CapabilityInvoker 尚未透传取消信号，调用依赖插件 deadline。它们不构成通用媒体或内容安全框架。

## Plugin / Provider / 模型配置管理 HTTP

`GET /provider-plugins`、`/provider-catalog`、`/model-catalog` 返回安全目录。Provider / ModelConfiguration 归当前用户所有，管理入口为 `/providers` 与 `/model-configurations`；Owner 仅来自认证会话，创建请求不接受 projectId / ownerId。创建、列表、启停与凭证轮换见[管理 Controller](../apps/api/src/models/model-management.controller.ts)。绑定创建后不可改写；没有删除、远程插件安装或调用厂商 API 的模型发现。

官方 Provider / Model Catalog 随代码发布，当前为 OpenAI、Anthropic 及其预设文本模型；目录不是用户 ModelConfiguration。官方地址不由普通用户填写，自定义地址只属于高级兼容路径。凭证规则见[认证与安全](authentication.md#业务权限与密钥边界)。

## Web 用户模型设置

画布内复用同一抽屉配置当前用户的供应商、凭证和模型；所有自有项目（包括后续新建项目）共用，Query 缓存按用户 ID 隔离。Publish 在事务内按 Workflow Owner 校验模型 / Provider；Runtime 先核对 Run 的项目权限，再按相同用户身份读取配置并解密，不接受跨用户 ID 引用。节点从 Model Catalog 选择模型，仅写 modelConfigurationId；从节点进入供应商配置成功后继续原选择意图，取消不写入节点，设置页主动配置则留在设置。已选模型展示配置参数，不在节点另存。Secret 不回填、不进入 Form / Query 缓存或浏览器存储，请求发出及退出表单时清空；配置不触发生成。

## Artifact 生产数据通道

PostgreSQL 保存身份与元数据，内容写 RustFS；只有 ready Artifact 可解析。内部 Runtime 可还原 JSON 或生成临时媒体访问资源，规则见[数据模型](data-model.md#artifact-与-asset)与[对象存储](object-storage.md)。Run 查询只返回 reference 身份，不 materialize、不签发 URL；Web 尚不能读取引用内容。Asset / Promote、自动对账与垃圾回收未接入。

## React Flow 数据适配

WorkflowDefinition 是唯一持久来源，React Flow 只管理视图；导出不保留 selected / dragging / measured。节点目录、创建与连接行为见 [Node](node-model.md)，界面约束见[前端规范](frontend-ui.md)。

候选输入以 `node.inputs[portKey]` 为唯一持久来源。[适配层](../apps/web/src/features/workflow/canvas/react-flow-adapter.ts)把每个来源投影为数据线，共用目标输入 Handle；通过 `data.projection = 'candidate-input'` 与真实 DataEdge 区分，禁止作为 DataEdge 导出。第二条数据连接复用确认弹窗，明确选择替换现有来源或添加候选；添加时移除原 DataEdge 并写入候选绑定。候选线通过删除后重新连接修改，不支持拖动重连端点。

删除候选线或来源节点只清理对应来源，剩余一个时保留候选 Draft，删光移除该 input binding。Save 直接发送 Definition，reload 从绑定重新投影，不生成真实 DataEdge。输入区域展示来源节点 / 输出端口名称及实际执行分支取值说明，不显示 JSON；候选不足提示补齐。Web 去重并限制新增至两个候选，只校验端点、Manifest 端口与基础类型；互斥和汇聚拓扑由 Publish / Compiler 权威验证，错误沿用发布面板展示。Template variable candidate、任意 N-way 和嵌套 If 编辑不在本版范围。

Template 的 `node_output` 变量也由同一适配层投影为数据线，以 `data.projection = 'template-input'` 标识；真实 DataEdge 不带 projection 标记。投影沿用数据线样式，按 source node / source port / target node / target port 去重，alias 及正文不改写。用户直接插入变量即可建立可见依赖，删除最后一个对应 alias 后连线消失；投影不可直接删除或重连，须在输入编辑器中修改变量。Save / reload 仍只读写原有 Definition，所有输入投影均禁止导出为 DataEdge。

删除来源节点时统一清理相关 Template alias 及其正文 token，保留其他节点和 workflow_input 变量；无变量时保留剩余文字为 constant，文字也为空则移除绑定。此清理与 Candidate / 真实边及 Workflow 输出共用节点删除入口，不维护独立投影状态。当前 inputs 中只有 Template 与 Candidate 绑定可引用节点输出；constant、workflow_input 和 asset 不产生跨节点引用。依赖合法性继续由 Contract / Publish / Compiler 校验。

### Web Workflow Draft 持久化

缺失 Workflow 时显式初始化，不用本地空图兜底。草稿允许未完成配置；保存失败保留编辑，冲突后经用户明确操作重读对应资源，不覆盖另一类未保存内容。Draft 修改不影响已发布版本及已有 Run。

### Editor session 离开保护

Editor 统一保护 dirty Draft、项目修改、进行中的保存 / 重载 / 发布，以及 submitting / uncertain Start；返回项目、账户和 Logout 共用确认，Logout 确认后才执行。clean 但未发布、已受理的 pending / running 不单独阻止离开。

unsafe 注册标准 beforeunload，safe / 卸载时解除。不改写 Router / history；同文档历史切换、崩溃或强制关闭不保证触发。明确授权失效时仍遵守原隐藏 / 跳转边界。

### Web invocation identity recovery

每个 invocation 在 localStorage 独立保存严格 metadata receipt，key 按格式版本 / user / project / workflow / invocationKey 隔离。只保存固定版本、创建时间与可选 Run ID，不保存 inputs、完整 request、凭证、URL、异常或 outputs。冻结合法请求后同步保存，成功才 POST；失败明确提示尚未发送，不回退 memory-only。

页面重进只读 lookup，核对 workflow / version / key / 已知 Run ID 后复用 Status tracking。未找到、冲突或查询失败时保留身份，可重新查询，不自动 POST / 换 key；存在未确认身份时，用户确认新旧请求可能同时执行后才发起独立 Run。accepted / queue uncertainty 补写失败不重发，旧 uncertainty 不被后续一次 4xx 消除。

确认 completed / failed / cancelled 后先由页面持有 Run，再自动清理 receipt；waiting 保留。清理不清空当前页面，但下次重进不依赖已删除的终态 receipt 自动发现历史。多 Run 不覆盖，storage event 只同步集合，不当锁或跨 Tab 自动提交。Logout 成功清本用户并失效晚到写回，失败保留；存储清理失败明确提示。离开保护仍保留，找到当前错误请求的 Run 后解除旧 uncertainty。

### Web Workflow Run Result

Editor 的[执行工作区](../apps/web/src/features/workflow/editor/workflow-execution-workspace.tsx)以紧凑工具栏和可收起的右侧面板承载运行；宽屏并排、窄屏覆盖，配置与状态 / 结果分标签，长内容在面板内滚动。打开面板不会发起运行，关闭不清空输入或停止状态跟踪；受理后切到状态页，正常响应不强制重开已关闭面板。技术 ID 按需展开；保留未确认请求与其他可恢复 Run 的入口。

现有状态面板仅在 completed 时从 `runStatus.run.outputs` 逐项展示结果；不读取 Draft、Node 中间输出或另发 Result 请求。字符串保留换行并按普通文本显示，number / boolean / null 原值展示，array / object 使用格式化 JSON。空字符串有独立提示；`{}` 显示「此运行没有工作流输出」，缺失 outputs 显示「运行结果不可用」。

reference 只展示类型、kind 与 ID（Asset 包含版本），提示暂不支持预览，不生成 URL 或读取内容。Recovery 复用同一状态与 Result 展示；终态 receipt 清理不清空当前页面结果。其他 Run 状态不展示最终结果，failed 保留安全错误。

## 目录与依赖

| 目录                                 | 职责                                                                                                                 |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| apps/web                             | Editor、账户 / 项目 / 模型管理；Workflow 按 editor、canvas、node-catalog、inputs、model-selection、publish、run 组织 |
| apps/api / apps/worker               | 认证 HTTP 与提交 / 持久投递与执行                                                                                    |
| packages/contracts                   | 无框架依赖的 JSON 协议和 Schema                                                                                      |
| packages/workflow                    | 领域校验、编译、执行；runtime/values 管运行值，run/submission 管受理                                                 |
| packages/server                      | 授权 Repository、基础设施和生产装配；workflow/runtime 与 queue 分工                                                  |
| packages/plugins / packages/database | 受信任插件与目录 / Prisma 模型与迁移                                                                                 |

run 内部区分 status、result 与 recovery，跨职责 API 留在 Workflow 根目录。已实现模块按领域归类，不按技术类型机械拆分，不保留重复入口。`packages/context` 仍为空入口。
