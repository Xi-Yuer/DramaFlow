# 开发指南

按 README 初始化环境，根任务自动加载根目录 .env。前端端口 3000，API 3001；直接启动单个应用时需自行传入环境变量，不复制秘密文件。不提交真实凭证及本地环境文件，密钥规则见 [认证与安全](authentication.md)。

已实现能力与目录职责见 [当前架构](architecture.md)，平台设计边界见 [平台核心模型](platform-model.md)，当前阶段与下一步见 [分步设计与实施方案](implementation-plan.md)。开始新模块前对照当轮具体范围，不自动恢复旧业务或一次性实施整个路线图。

共享包通过 dist 暴露；根 Turbo 任务先构建依赖。前后端业务目录保留 .gitkeep，加入实际文件后可删除该占位文件。空包入口只标识预留结构，不可当作可用功能。

修改基础服务后运行相关 typecheck、lint、build；需要真实基础设施时运行 pnpm test:storage 或 pnpm test:integration。contracts / workflow 的 Manifest、三类静态 Binding、Data / Control Edge 与联合 DAG、值校验、快照及泛型 LangGraph 适配，以及 web 的整图转换和 renderer 测试接入 pnpm test；pnpm check 同时检查源码与测试的类型。没有测试的空业务包不设置虚假的通过测试任务。

工作流基础开发先阅读 [Runtime 架构](runtime-architecture.md)。复用 LangGraph 的 StateGraph、Checkpoint、Interrupt / Resume、Send 和条件路由，使用真实 LangGraph 测试编译适配；MemorySaver 仅显式用于测试，不作为未接入生产持久化的兜底。普通节点操作的值校验测试与图执行测试分开，不能用单节点成功证明整个 WorkflowDefinition 已可执行。

普通确定性依赖编译须检查 Data / Control Edge 均计入依赖、按目标聚合与来源去重，同一节点对的混合边或不同数据端口不重复计数。验证原始边及 portKey 保持完整、依赖编译不读取端口；单上游生成字符串边、多上游只生成一条数组 Join Edge。使用真实 LangGraph 验证混合边去重后，两种上游完成顺序及不同长度路径下均等待全部完成且目标只执行一次，并覆盖上游失败。条件候选分支不套用此规则；这些测试不代表输入绑定、生产 WorkflowState、整图编译或真实模型调用已接入。

BindingResolver 测试使用真实静态转换实现，检查 Data Edge 端口映射、常量按目标声明 dataType 内联包装、workflow_input 原样复用 inline / reference，以及 asset 引用保留明确版本。上下文显式提供精确版本 Manifest，测试未知静态 / 数据目标端口报 INPUT_PORT_NOT_FOUND、缺失工作流输入报 WORKFLOW_INPUT_MISSING，并保留来源冲突、缺失上游输出及继承属性不可作为值的回归。覆盖空值 / 数组等常量、不做类型猜测或业务 Zod 校验、不同资产版本不互相改写、引用不被 decode、输入上下文不被修改及网络调用防护。静态校验的冲突 issue.params.code 与运行错误均使用 INPUT_SOURCE_CONFLICT。引用包装不证明资产存在、版本 / 权限可访问或完整 NodeExecutor 已接入。

RuntimeValueCodec 测试检查 inline 原样返回且不调用引用服务，reference 保留引用及 projectId / workflowRunId 后委托显式 DataReferenceResolver。验证媒体和领域对象原样返回、不执行业务 Schema、引用失败的 REFERENCE_RESOLUTION_FAILED / cause 与已有结构化错误原样传播，以及 decodeRecord 真正并行、乱序完成仍按原键返回、空 map 与任一引用失败时整体失败。批量解码只处理自有键且不污染对象原型。测试引用服务不证明真实存储、授权、signed URL 或完整 NodeExecutor 已接入。

节点类型开发对照 [Node 模型](node-model.md) 与 [Manifest 实施说明](node-type-implementation.md)。分别验证纯 JSON Manifest 的配置类型 / 默认值、服务端三组 Zod 与声明字段一致、精确类型版本注册以及 listManifests 的白名单与数据隔离。Preset 只测试配置模板行为，不作为 Registry 身份；保留 transform 和默认值不回写定义的回归。

正式 WorkflowDefinition 测试检查三类 StaticInputBinding、两类边引用与全局 ID 唯一、自连接及联合 DAG；Data Edge 另检查目标数据端口单连接与静态 Binding 冲突，Control Edge 不占用输入并允许多个控制上游。检查控制端口可省略或命名，拒绝旧 ConnectionBinding。通用 factory 继续用独立自定义 Schema 测试，不强加正式 Node 协议。静态成功不证明端口存在、真实值有效或资产可访问，也不替代独立依赖收集与运行输入绑定检查；assetId / versionId 只是明确版本的引用声明。

React Flow 测试检查两类边 ID / 端点往返、edge.data.kind 与控制 Handle 命名空间、控制端口省略与命名映射、跨类连线拒绝，以及删除 / 重连按边种类与完整快照防止误改。数据连线还检查精确版本 Manifest、共享 isTypeAssignable、目标单连接与数组输入不聚合、移除被显式替换的静态 Binding；节点转换检查临时字段剔除，renderer 检查数据端口 key、普通控制 Handle 与不可用状态。目录 API 使用真实默认鉴权与 no-store，前端处理加载、错误与空态；生产 Registry 为空，不用假类型填充。画布已接入两类边事件，但没有节点添加与 Workflow 持久化，项目保存继续只处理名称、视口和 revision。

数据库模型在 packages/database/prisma/schema.prisma 定义。执行迁移前核对 DATABASE_URL 仅指向本项目开发库，再运行 pnpm db:migrate。迁移影响范围与操作方式统一见 [部署与数据库](deployment.md)。

开发环境允许按需要重建数据，但不能把此授权用于其他项目或生产环境。新增迁移时审查 SQL，并同步文档；不要为已删除的开发业务增加历史协议兼容层。

认证相关开发先阅读 authentication.md。新增业务 API 默认受 AuthGuard 保护，公开接口需显式 Public；修改角色、停用或会话逻辑后执行隔离数据库集成测试。

项目接口或保存协议变更后，执行 pnpm check 和 pnpm test:integration，重点验证名称/视口边界、所有者隔离、分页、revision 冲突及旧节点/插件字段被拒绝；浏览器检查登录、新建项目、名称和视口保存、重新加载及账户中心。当前仅节点目录接入 API，项目接口不保存或执行节点；泛型 LangGraph 测试不覆盖 WorkflowState、Binding 求值、生产持久化、队列或真实模型。

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

按改动选择 contracts 的数据 / 节点协议测试、workflow 的 Registry / 编译包装 / 输入解析 / Decode 测试，以及相关 API / Web 类型检查和定向用例。DataType / RuntimeValue / Artifact / Asset 的结构测试不代表已有内容持久化；局部输入组装、解码委托与 Executor 接口不代表已运行整条管线。避免例行全量测试和浏览器测试，不因修改共享类型而重跑无关存储、认证或部署检查。
