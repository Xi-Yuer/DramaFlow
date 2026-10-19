# 当前架构与目录职责

DramaFlow 是面向团队自部署的 AI 视频生产工作流平台，漫剧优先。顶层概念见 [平台模型](platform-model.md)，定义与运行见 [Workflow](workflow-model.md)，节点见 [Node](node-model.md)，技术职责见 [Runtime 架构](runtime-architecture.md)，下一步见 [实施方案](implementation-plan.md)。本文只维护实际能力与目录边界。

## 已实现的基础工程

应用已有登录、平台鉴权、账户中心、项目管理和 React Flow 画布。画布注册通用节点 renderer 并查询真实节点目录，目前目录为空；没有添加节点、图编辑保存、模型生成、工作流运行或业务对话。

Next.js 使用 App Router、Ant Design 深色主题和 TanStack Query。认证通过同源代理接入 NestJS Better Auth 白名单入口，业务 API 默认受真实全局 AuthGuard 保护。PostgreSQL / Prisma 保存身份、资料、凭证、会话、认证限流及基础项目；Redis 与 RustFS 提供基础服务。会话与角色边界见 [认证实施](authentication.md)。

每项目恰好一张画布。项目保存所有者、名称、视口、revision 和时间，不保存节点、绑定或 WorkflowDefinition；读取与写入按所有者隔离，列表游标分页，原子更新检查 revision，冲突返回 409。目录与渲染器接入没有改变这个协议或数据库。

项目 API 为 GET / POST /api/v1/projects、GET / PUT /api/v1/projects/:id。新增 GET /api/v1/workflow/node-types 默认认证，响应 Cache-Control: no-store。NodeTypesModule 导出服务端 Registry 供后续显式注册；当前返回真实空数组，没有注册占位 LLM / 视频类型。

worker 仍是仅复用基础设施的独立 NestJS 应用上下文，不消费业务队列；plugins、context 保留空入口。LangGraph 普通节点适配在基础库验证，未接入运行 API / worker，LangChain 模型调用与供应商适配未实现。

## Workflow 基础库

contracts 的 workflow.ts 保留元数据、版本 / 运行元数据、六种运行状态、输出来源与显式 createWorkflowSchemas 工厂。调用方提供 DataType、Node、Edge Schema，组合器检查顶层字段、名称 / 节点 ID 唯一及最终输出来源节点；不强迫通用调用方采用具体节点协议。

workflow-definition.ts 的正式 workflowDefinitionSchema 使用当前 DataType、NodeDefinition 与 ControlEdgeDefinition 组合，保留 inputs / nodes / edges / outputs。它检查控制边 ID 唯一、来源 / 目标节点、connection 来源节点、workflow_input 名称、自连接与控制加数据依赖的联合 DAG。

正式静态校验不访问 Registry，因此不判断 outputKey、sourcePort、类型端口或配置契约是否存在，不做类型兼容、资源权限或资产访问，也不解析运行值。完整发布 / 执行校验尚未接入。

workflow 包已有 parseWorkflowInputs、collectWorkflowOutputs、createWorkflowVersionSnapshot、assertWorkflowRunVersion：按显式 Zod 契约校验值、按声明来源收集最终结果、复制并冻结 JSON 快照、检查运行版本身份。这些函数不发布版本或创建运行；快照只保证内存隔离，不替代数据库不可变性、权限与并发控制。

## Node 基础库

contracts/node.ts 提供四类 InputBinding、NodeDefinition、ControlEdgeDefinition、配置模板 Preset 与 NodeRun。Node.inputs 是安全端口键 record，connection / constant / workflow_input / asset 是唯一数据来源声明；constant 仅 JSON，asset 仅 assetId，尚无资产读取、权限或版本解析。实例固定 type / typeVersion，ui.position 必填。

contracts/node-type.ts 提供纯 JSON NodeTypeManifest、八类 metadata 分类、输入输出端口、四种 ConfigFieldDefinition、FieldUI 及能力需求。配置默认值按类型、范围和选项校验；控件只声明提示。端口无默认值，multiple 尚未启用多绑定。公开 Manifest 不含 Zod、JSON Schema、编译器或实际配置。

DataType 支持 any / json / file、基础媒体、domain 和递归 array。isDataTypeAssignable 允许 any 双向静态匹配，其余同种类、同领域名或递归数组匹配；json、file 不构成其他类型的基类，不执行媒体转换或真实值校验。

服务端 NodeType 持 manifest、inputSchema、outputSchema、configSchema 和 compile。NodeRegistry 按 type / version 精确 register / get / compile；listManifests 白名单校验并返回独立 JSON，拒绝重复或不可用版本，不回退最新版。assertNodeSchemas 检查声明与三组 Zod 的字段集合及公开默认值，不推断完整类型等价。

parseNodeDefinition 检查类型版本、目标输入端口和实际配置；applyNodePreset 只合并同类型版本模板与实例配置，不改变 Runtime 身份。invokeNodeOperation 校验并隔离 inputs / config / outputs，透传 RunnableConfig，不解析 Binding、不调度、不自动重试。配置的 transform / 默认值不回写定义。

createOperationNodeType 保留泛型普通操作适配：编译产物可加入真实 StateGraph，CompileContext 只负责输入读取与输出更新边界，不给节点全图 builder。当前没有具体 WorkflowState、四类 Binding 求值器、完整 DSL Compiler、持久 checkpointer 或运行事件投影。

createWorkflowRunConfig 检查 Run / Version 身份，绑定根 Run.id 为 LangGraph thread_id 并保留并发、取消等配置；不创建运行、检查权限、加载版本或选择 checkpointer。真实 LangGraph 测试保留原生执行、interrupt / Command、Send / reducer 及并发验证，MemorySaver 与测试类型不代表生产恢复或真实生成。

NodeRun 只校验 JSON 输入输出、八种业务状态、code / message 错误和 ISO 时间，不驱动图调度或提供持久化。类型与编译边界见 [Manifest 实施说明](node-type-implementation.md)。

## React Flow 数据适配

react-flow-adapter.ts 提供整图转换与节点白名单映射。React Flow type 使用 workflowNode renderer，领域类型版本在 data.nodeType / data.typeVersion，位置对应必填 ui.position；selected、dragging、measured 不回写 DSL。

Node.inputs.connection 派生 data.kind=data 的可视化边，Workflow.edges 独立转换为 data.kind=control 的边。新增连接只替换目标端口 Binding；断连检查当前来源与完整旧快照，避免过期事件误删新连接，不生成持久化数据边。连接辅助函数只检查静态定义，不做 Manifest 端口或运行值校验。

GenericWorkflowNode 根据精确类型版本 Manifest 自动生成 Handle、显示端口类型与配置摘要；缺失版本显示不可用，图标采用受控映射。画布已注册 renderer、加载目录并处理加载 / 错误 / 空态；当前没有添加节点或图编辑 / 保存。项目保存按钮仍只处理名称、视口及 revision。

## 目录与依赖

| 目录               | 当前职责                                             | 后续边界                               |
| ------------------ | ---------------------------------------------------- | -------------------------------------- |
| apps/web           | 身份、账户、项目画布、目录查询、通用 renderer 与适配 | 创作交互，不加载服务端插件或密钥       |
| apps/api           | 认证、资料、项目、节点目录和基础设施                 | 模块化业务入口、权限与应用服务         |
| apps/worker        | 仅基础设施的 NestJS 上下文                           | 独立执行进程，不自建图调度语义         |
| packages/contracts | 中立 JSON 协议和静态校验                             | 不依赖前端、数据库或 Runtime 框架      |
| packages/database  | Prisma 与身份、基础项目持久化                        | 模型、迁移按实际业务增加               |
| packages/workflow  | 值契约、快照、NodeType / Registry 与 LangGraph 适配  | 先确定 State，再实现领域编译与执行接入 |
| packages/plugins   | 空入口，保留模型 SDK                                 | 受信任外部能力，无隐式供应商选择       |
| packages/context   | 空入口                                               | 独立构建明确选择的上下文               |

不为附件目录示意重命名为 common / client，不为未来概念建立空壳执行器。API 与 worker 通过服务和契约协作；第三方类型在适配层转换，不进入 contracts。

LangGraph 是核心 Runtime，平台不再建设图调度、Checkpoint 或暂停恢复状态机。Queue / Worker 后续处理长异步作业、跨运行与供应商限流，不决定图中下一个节点。一个项目一个逻辑 Workflow 的边界不变，子流程只引用其他项目固定版本；当前没有对应持久化、发布或运行应用接口。
