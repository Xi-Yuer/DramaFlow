# 开发指南

按 README 初始化环境，根任务自动加载根目录 .env。前端端口 3000，API 3001；直接启动单个应用时需自行传入环境变量，不复制秘密文件。不提交真实凭证及本地环境文件，密钥规则见 [认证与安全](authentication.md)。

已实现能力与目录职责见 [当前架构](architecture.md)，平台设计边界见 [平台核心模型](platform-model.md)，当前阶段与下一步见 [分步设计与实施方案](implementation-plan.md)。开始新模块前对照当轮具体范围，不自动恢复旧业务或一次性实施整个路线图。

共享包通过 dist 暴露；根 Turbo 任务先构建依赖。前后端业务目录保留 .gitkeep，加入实际文件后可删除该占位文件。空包入口只标识预留结构，不可当作可用功能。

修改基础服务后运行相关 typecheck、lint、build；需要真实基础设施时运行 pnpm test:storage 或 pnpm test:integration。contracts / workflow 的 Manifest、四类 Binding、联合 DAG、值校验、快照及泛型 LangGraph 适配，以及 web 的整图转换和 renderer 测试接入 pnpm test；pnpm check 同时检查源码与测试的类型。没有测试的空业务包不设置虚假的通过测试任务。

工作流基础开发先阅读 [Runtime 架构](runtime-architecture.md)。复用 LangGraph 的 StateGraph、Checkpoint、Interrupt / Resume、Send 和条件路由，使用真实 LangGraph 测试编译适配；MemorySaver 仅显式用于测试，不作为未接入生产持久化的兜底。普通节点操作的值校验测试与图执行测试分开，不能用单节点成功证明整个 WorkflowDefinition 已可执行。

节点类型开发对照 [Node 模型](node-model.md) 与 [Manifest 实施说明](node-type-implementation.md)。分别验证纯 JSON Manifest 的配置类型 / 默认值、服务端三组 Zod 与声明字段一致、精确类型版本注册以及 listManifests 的白名单与数据隔离。Preset 只测试配置模板行为，不作为 Registry 身份；保留 transform 和默认值不回写定义的回归。

正式 WorkflowDefinition 测试检查四类 Binding、引用、自连接及控制 / 数据联合 DAG；通用 factory 继续用独立自定义 Schema 测试，不强加正式 Node 协议。静态成功不证明端口存在、真实值有效或资产可访问，assetId / versionId 只是明确版本的引用声明。

React Flow 测试检查 data / control 边派生、按 Manifest 校验端口和静态类型后的单目标绑定更新、过期断连不误删、临时字段剔除、类型版本匹配与 GenericWorkflowNode 的 Handle / 不可用状态。目录 API 使用真实默认鉴权与 no-store，前端处理加载、错误与空态；生产 Registry 为空，不用假类型填充。实际画布尚无添加、图编辑与工作流保存，项目保存继续只处理名称、视口和 revision。

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

按改动选择 contracts 的数据 / 节点协议测试、workflow 的 Registry / 编译包装测试，以及相关 API / Web 类型检查和定向用例。DataType / RuntimeValue / Artifact / Asset 的结构测试不代表已有内容持久化；Codec / Resolver / Executor 的接口不代表已运行整条管线。避免例行全量测试和浏览器测试，不因修改共享类型而重跑无关存储、认证或部署检查。
