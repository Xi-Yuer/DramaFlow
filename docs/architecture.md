# 当前架构与目录职责

DramaFlow 是面向团队自部署的 AI 视频生产工作流平台，漫剧优先。顶层概念见 [平台模型](platform-model.md)，定义与运行见 [Workflow](workflow-model.md)，节点见 [Node](node-model.md)，技术职责见 [Runtime 架构](runtime-architecture.md)，下一步见 [实施方案](implementation-plan.md)。本文只维护实际能力与目录边界。

## 已实现的基础工程

应用已有登录、平台鉴权、账户中心、项目管理和 React Flow 画布。画布注册通用节点 renderer 并查询真实节点目录，目前目录为空；没有添加节点、图编辑保存、模型生成、工作流运行或业务对话。

Next.js 使用 App Router、Ant Design 深色主题和 TanStack Query。认证通过同源代理接入 NestJS Better Auth 白名单入口，业务 API 默认受真实全局 AuthGuard 保护。PostgreSQL / Prisma 保存身份、资料、凭证、会话、认证限流及基础项目；Redis 与 RustFS 提供基础服务。会话与角色边界见 [认证实施](authentication.md)。

每项目恰好一张画布。项目保存所有者、名称、视口、revision 和时间，不保存节点、绑定或 WorkflowDefinition；读取与写入按所有者隔离。列表按更新时间与 id 倒序，游标保存毫秒精度更新时间和 id，并校验长度、编码与字段；相同更新时间用 id 确定边界。分页读取当前列表，不建立跨请求数据库快照。原子更新检查 revision，冲突返回 409。revision 是项目保存的修订号，不是工作流发布版本。目录与渲染器接入没有改变项目保存协议或数据库。

项目 API 为 GET / POST /api/v1/projects、GET / PUT /api/v1/projects/:id。新增 GET /api/v1/workflow/node-types 默认认证，响应 Cache-Control: no-store。NodeTypesModule 导出服务端 Registry 供后续显式注册；当前返回真实空数组，没有注册占位 LLM / 视频类型。

worker 仍是独立 NestJS 应用上下文，通过 `@dramaflow/server` 复用数据库、Redis 与对象存储，不消费业务队列；plugins、context 保留空入口。LangGraph 普通节点适配在基础库验证，未接入运行 API / worker，LangChain 模型调用与供应商适配未实现。

## Workflow 基础库

contracts 的 `workflow/metadata.ts` 保留元数据、版本 / 运行元数据、六种运行状态、输出来源与显式 createWorkflowSchemas 工厂。调用方提供 DataType、Node、Edge Schema，组合器检查顶层字段、名称 / 节点 ID 唯一及最终输出来源节点；不强迫通用调用方采用具体节点协议。

`workflow/definition.ts` 的正式 workflowDefinitionSchema 使用当前 DataType、NodeDefinition 与 ControlEdgeDefinition 组合，保留 inputs / nodes / edges / outputs。它检查控制边 ID 唯一、来源 / 目标节点、connection 来源节点、workflow_input 名称、自连接与控制加数据依赖的联合 DAG。

正式静态校验不访问 Registry，因此不判断 outputKey、类型端口或配置契约是否存在，不做类型兼容、资源权限或资产访问，也不解析运行值。控制边只保存节点到节点的关系，条件路由端口不在这条边上。完整发布 / 执行校验尚未接入。

workflow 包已有 parseWorkflowInputs、collectWorkflowOutputs、createWorkflowVersionSnapshot、assertWorkflowRunVersion：按显式 Zod 契约校验值、按声明来源收集最终结果、复制并冻结 JSON 快照、检查运行版本身份。这些函数不发布版本或创建运行；快照只保证内存隔离，不替代数据库不可变性、权限与并发控制。

## 数据与 Node 基础库

contracts/data 提供正式 DataType、builtin 类型常量、共享 isTypeAssignable、DataTypeManifest、RuntimeValue 与 DataReference。primitive / named / array / object / union / any 描述语义类型；inline / reference 描述运行值承载。数组元素用 itemType；兼容规则包含递归数组、Union 全来源覆盖和对象结构子集，any 仅放宽目标。

contracts/content 提供 Artifact 与版本化 Asset 的共享协议；Artifact 引用不可变产物 ID，AssetReference / AssetBinding 固定 versionId。没有对应数据库表、上传、Promote 或引用读取服务。详细类型与生命周期见 [数据模型](data-model.md)。

服务端 DataTypeRegistry 按名称注册 Manifest + Zod，拒绝重复及未知名称；schemaFor / parse 递归检查实际 JSON 值。目录只返回独立 Manifest 副本，未注册虚构媒体实现，也未接入类型目录 API。

NodeTypeManifest 增加必填 executionKind：action / control / composite / interaction。NodeType 改为 execute(input, config, context)，不再自行 compile。NodeRegistry 仍精确匹配 type / version，并固定实现读取的 Manifest；普通 action 提供 execute，其他种类声明由独立结构策略处理，生产目录仍为空。

createOperationNodeType 只组合 Manifest、三组 Zod 与 operation。parseNodeDefinition、applyNodePreset、invokeNodeOperation 保留独立值契约校验，Preset 不改变运行身份，转换与默认值不回写定义。assertNodeSchemas 检查字段集合和默认值，不证明任意 Schema 与语义类型完全等价。

ActionNodeCompilationStrategy 校验节点类型版本，复制定义并仅生成调用统一 NodeExecutor 的 LangGraph 包装。编译时不执行业务，不编译控制边，不管理调度或暂停恢复。完整 WorkflowCompiler 和结构策略尚未实现。

runtime/ 已有 WorkflowState、RuntimeValueCodec、BindingResolver、NodeExecutor、内容 Store 和 NodeRunRecorder 接口。State.outputs 正式使用 NodeOutputMap（RuntimeValue），execution 暂不启用控制字段；没有生产通道、reducer、绑定解析、内容持久化或完整执行服务实现，不提供内存 / 本地存储降级。

createWorkflowRunConfig 使用显式 Run.threadId，不从 Run.id 推断或允许其他配置覆盖，不创建运行或 checkpointer。NodeRun 保留 attempt、可选 JSON 快照、状态、结构化错误和 ISO 时间契约；业务记录、权限与持久化仍待接入。

## React Flow 数据适配

react-flow-adapter.ts 提供整图转换与节点白名单映射。React Flow type 使用 workflowNode renderer，领域类型版本在 data.nodeType / data.typeVersion，位置对应必填 ui.position；selected、dragging、measured 不回写 DSL。

Node.inputs.connection 派生 data.kind=data 的可视化边，Workflow.edges 独立转换为 data.kind=control 的边。新增连接只替换目标端口 Binding，并对照传入的 Manifest 检查精确类型版本、端口存在和静态类型；目录查询与显式连线共用目录 Schema，拒绝重复 type / version，避免按数组顺序选择冲突声明。断连检查当前来源与完整旧快照，避免过期事件误删新连接，不生成持久化数据边。连接辅助函数不做运行值校验。

GenericWorkflowNode 根据精确类型版本 Manifest 自动生成 Handle、显示端口类型与配置摘要；缺失版本显示不可用，图标采用受控映射。画布已注册 renderer、加载目录并处理加载 / 错误 / 空态；当前没有添加节点或图编辑 / 保存。项目保存按钮仍只处理名称、视口及 revision。

## 目录与依赖

| 目录               | 当前职责                                             | 后续边界                               |
| ------------------ | ---------------------------------------------------- | -------------------------------------- |
| apps/web           | 身份、账户、项目画布、目录查询、通用 renderer 与适配 | 创作交互，不加载服务端插件或密钥       |
| apps/api           | 认证、资料、项目和节点目录                           | 模块化业务入口、权限与应用服务         |
| apps/worker        | 独立进程，只接入共享基础设施                         | 独立执行进程，不自建图调度语义         |
| packages/server    | 数据库、Redis、对象存储和凭证加密                    | 不包含 HTTP、认证或业务流程            |
| packages/contracts | 身份、项目、Workflow 与 Node 的中立 JSON 协议        | 不依赖前端、数据库或 Runtime 框架      |
| packages/database  | Prisma 与身份、基础项目持久化                        | 模型、迁移按实际业务增加               |
| packages/workflow  | 值契约、数据 / 节点 Registry、运行接口及编译包装     | 先确定 Graph Model，再接入执行与持久化 |
| packages/plugins   | 空入口，保留模型 SDK                                 | 受信任外部能力，无隐式供应商选择       |
| packages/context   | 空入口                                               | 独立构建明确选择的上下文               |

不为附件目录示意重命名为 common / client，不为未来概念建立空壳执行器。API 与 worker 通过服务和契约协作；第三方类型在适配层转换，不进入 contracts。

contracts/src 的 identity.ts 与 project.ts 分别承载身份与项目协议，workflow/ 和 node/ 承载工作流与节点协议，data/ 和 content/ 承载值与内容协议。workflow/src 分为 definition/、data/、node/、runtime/、compiler/、run/；server/src 分为 database/、redis/、storage/、secrets/。API 的 health/ 与 http/ 保留 HTTP 职责，基础设施不反向依赖 API，worker 不再依赖 API 应用包。

LangGraph 是核心 Runtime，平台不再建设图调度、Checkpoint 或暂停恢复状态机。Queue / Worker 后续处理长异步作业、跨运行与供应商限流，不决定图中下一个节点。一个项目一个逻辑 Workflow 的边界不变，子流程只引用其他项目固定版本；当前没有对应持久化、发布或运行应用接口。
