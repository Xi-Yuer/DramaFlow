# 开发指南

启动见[根 README](../README.md)。根任务加载 `.env`，单独启动需自行传入；共享包从 dist 导出，Turbo 先构建依赖。按任务选读专题和相关代码，不通读 docs / experiments。

## 检查入口

| 命令                                                  | 范围                                                 |
| ----------------------------------------------------- | ---------------------------------------------------- |
| pnpm lint / typecheck / test / build                  | 全仓检查，可传 Turbo --filter                        |
| pnpm check                                            | 上述四项                                             |
| pnpm test:integration                                 | PostgreSQL / Redis / RustFS、真实 HTTP 和独立 Worker |
| pnpm test:storage                                     | RustFS 对象与签名访问                                |
| pnpm test:web:workflow / test:web:models              | 显式授权的浏览器验证                                 |
| node --test scripts/configure-model-provider.test.mjs | 模型 CLI 校验与脱敏                                  |

按变更执行相关检查；只改文档时验证格式、链接和现状一致性，无需业务测试。测试替身不能成为生产兜底。具体用例与隔离规则以 [集成入口](../scripts/integration.mjs)及测试代码为准，不在文档复制断言或执行流水。

## 测试与环境边界

集成测试使用独立 dramaflow_test、随机 dramaflow-test-* 队列前缀，应用现有迁移，只清理自建账号及其项目、模型、对象和 thread；禁止指向业务库或清空共享队列。MemorySaver 仅用于单元测试，Human Review 通过内存 Checkpointer 验证暂停、串行恢复、If 组合和审计生命周期，NodeRun 隔离 PostgreSQL 用例验证 occurrence 身份、各 occurrence 内并发 attempt 分配、审核复用和权限。独立[迁移用例](../packages/server/test/node-occurrence-migration.spec.ts)在 dramaflow_test 的随机 schema 重放旧 DDL 与新迁移，验证审计 / Artifact 保留及约束；该用例仅在显式 DRAMAFLOW_INTEGRATION=1 下运行。[ChildExecution 隔离 PostgreSQL 用例](../packages/server/test/iteration-item-runs.spec.ts)执行真实 Iteration 编译图，验证单 item 身份、并行失败、复用与 attempt 隔离、嵌套父链、权限及数据库不可变约束，同样要求 DRAMAFLOW_INTEGRATION=1 与本机 dramaflow_test。[运行树查询集成用例](../packages/server/test/execution-tree.integration.spec.ts)在同一隔离条件下验证真实外键、嵌套父链、独立状态、权限、分页和查询不改写审计；Contract / 通用查询单测另验证非 Iteration source、非法父链及边界投影。Web 单元 / 组件测试覆盖文本审批和恢复交互，真实浏览器仍需人工验收；本机协议替身不代表收费模型验收。

真实 Provider 调用只在操作者明确授权后运行 `pnpm test:ai:live`。凭证通过受保护环境提供，不写命令行、日志或文档；不会因本机已有 key 自动启用，也不自动重试。变量为 DRAMAFLOW_LIVE_AI_BASE_URL、DRAMAFLOW_LIVE_AI_MODEL、DRAMAFLOW_LIVE_AI_CREDENTIAL_ENV 及后者指向的凭证变量。该入口使用高级兼容插件，不代替普通 Provider 路径。

浏览器验证默认人工执行，只有明确要求时才运行现有 Playwright 脚本。它使用系统 Chrome、根 `.env`、本机基础设施及隔离库，在 3200 / 3201 启动服务；不与占用同一测试库或端口的检查并行。代理构建后可用 `pnpm build --filter=@dramaflow/web` 恢复常规配置。

离开保护、刷新 / 重启后的 invocation recovery、多 Tab storage event、Logout 后重新登录仍需真实浏览器人工验收；使用受控本地能力，避免重复收费。不把本机临时 Workflow、模型配置 ID 或运行内容写成仓库现状。

## AI 文本 Composite 人工验收

本机开发建数入口为 `pnpm fixture:ai-text <ownerId>`，需要现有账号与本项目本机 `dramaflow` 数据库。命令先构建，再通过正式 `ProjectsService.create` / `WorkflowService.updateDraft` / `getForProject` 创建并重载普通草稿，名称为「AI 文本处理 · Composite 验收」。它仅从测试 helper 实例化，不把 Entry 注册到生产 Catalog；模型留空，不创建 WorkflowVersion / WorkflowRun，不启动 Runtime / Worker / Outbox Pump。重复执行只读取并报告现有同名项目，不覆盖人工编辑。创建请求结果不明时先核对项目列表，勿盲目重放。

在 Web 项目列表打开该项目，检查外部 `text:string → result:string`，进入 SubWorkflow 检查 Zoom / Grow 下钻与 AI 文本生成节点。prompt 初始绑定局部 `workflow_input.text`，system 为摘要指令；通过现有正式模型选择器选择本地已有的 DeepSeek 配置。修改 prompt / config，返回父图保存并刷新，再次进入确认保留；然后由用户显式 Publish、选择该版本 Run 并输入一段普通文本。检查真实摘要、Workflow Result 与 Execution Tree 中父 NodeRun → SubWorkflow ChildExecution → AI NodeRun 的归属、状态和输出。真实输出与动效需人工确认，fake Provider 自动测试不代表此项通过；不运行 Browser E2E。

## 前端职责目录

按业务入口组织 feature，再按实际职责划分内部目录，不把大文件机械切成同层碎片，也不按行数统一拆分。当前画布与检查器的目录边界如下。

| 目录                                                       | 职责                                                                                                       |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `workflow/canvas/adapter/`                                 | 纯转换与领域编辑：节点 / 边序列化、投影、Handle 校验、连接 / 删除 / 重连；不弹窗或持有 React 状态          |
| `workflow/canvas/editing/`                                 | 用户编辑操作：确认来源替换 / 候选、输入输出边界弹窗、Context 操作装配；领域修改调用 adapter 或已有领域工具 |
| `workflow/canvas/view/`                                    | 选择、测量、Inspector 模式等会话状态，隔离 React Flow 视图事件与可持久化修改                               |
| `workflow/canvas/rendering/`                               | 节点 / 连线渲染、呈现规则与相邻 CSS Module                                                                 |
| `workflow/inspector/design/`                               | 节点配置与草稿输入编辑                                                                                     |
| `workflow/inspector/runtime/`                              | NodeRun / attempt、运行值与审批呈现，不修改草稿                                                            |
| `workflow/inputs/definitions/`                             | 通用 Graph Input 定义、校验、类型选项与 Root / Body 共用编辑控件                                           |
| `workflow/inputs/bindings/`                                | 通用图输入 binding 的写入、重命名及兼容性清理，不依赖 Iteration                                            |
| `workflow/iteration/inputs/`                               | Iteration composite、Body / 不变输入及映射；依赖通用 Input 能力                                            |
| `models/settings/`、`catalog/`、`shared/`                  | 设置会话与目录展示；`shared/` 放配置摘要和供应商 / 模型配置共用的 Schema 字段表单                          |
| `models/providers/`、`configurations/`                     | 分别维护供应商及凭证表单、模型配置表单与列表；提交和密钥清理就近保留                                       |
| `workflow/model-selection/selection/`                      | 选择 Context、用户级查询、恢复会话与选项推导，不持有凭证                                                   |
| `workflow/model-selection/presentation/`、`configuration/` | 选项展示与明确的添加配置操作                                                                               |

Canvas 与 Inspector 根目录保留装配入口及共享类型 / 样式。内部模块直接依赖职责明确的文件；需要兼容调用方的适配导出集中在 `react-flow-adapter.ts`，不为每个搬移的组件增加转发文件。迁移目录时同步更新静态引用、测试 mock 和文档链接；重构优先运行现有行为测试，覆盖投影不持久化、过期删除 / 重连、显式替换确认、导航与运行上下文。

## 文档维护

- AGENTS.md：稳定边界和按任务阅读入口；README：启动与导航。
- architecture.md：已实现能力及入口；implementation-plan.md：当前工作与待决策。
- 专题：协议与失败边界；包 README：职责与链接。相同事实只保留一个权威位置，精确字段以代码为准。
- 原地替换过时内容，删除重复流水并修复引用。历史交给 Git；实验只保留结论、复现入口与隔离边界，不默认加载。
