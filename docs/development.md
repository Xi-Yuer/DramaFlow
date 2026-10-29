# 开发指南

启动见[根 README](../README.md)。根任务加载 `.env`，单独启动需自行传入；共享包从 dist 导出，Turbo 先构建依赖。按任务选读专题和相关代码。

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

## 测试并发与日常筛选

`pnpm test` 仍运行全仓单元 / 组件测试，默认 Turbo 同时测试 1 个包，各包共享 Vitest 配置、最多 2 个 workers，避免包级并发与 CPU 自动扩张叠加。数据库 / HTTP / 存储专项继续保持已有显式入口和隔离要求，不默认运行浏览器或真实 Provider。没有提高超时、自动重试或减少测试覆盖。

日常修改优先按包或文件运行；单文件参数前不再隐含追加整个 test 目录：

```sh
# 构建依赖后，只测一个包
pnpm test --filter=@dramaflow/workflow
# 构建依赖后，只测指定文件
pnpm test --filter=@dramaflow/workflow -- test/run/workflow-resume.test.ts
# 依赖已构建时，直接启动单文件 watch
pnpm --filter @dramaflow/workflow exec vitest test/run/workflow-resume.test.ts
# 资源充足时显式调高包级并发；Vitest workers 也可通过 CLI 覆盖
pnpm test --concurrency=2 -- --maxWorkers=2
```

`config/testing/vitest.shared.mjs` 是默认配置来源，Web alias、API globals 和专项串行 / timeout 配置保留在各包中。测试结果继续不使用 Turbo 缓存。

## 测试与环境边界

`pnpm test:integration` 先构建并迁移本机独立 `dramaflow_test`，初始化官方 Checkpointer，再执行 API HTTP / Worker e2e（排除真实 AI）、Server、Database 和真实存储测试。它使用随机 `dramaflow-test-*` 队列前缀和每轮独立 S3 测试桶，退出时只清理本轮测试桶。用例只清理自己创建的账号、项目、模型、对象和 thread。禁止指向业务库或清空共享队列。需要数据库的用例只在 `DRAMAFLOW_INTEGRATION=1` 且目标为 `dramaflow_test` 时运行。MemorySaver 只用于单元测试。测试装配里绕过 Publish 或 capability 检查不能代替正式发布准入。协议替身不代表收费模型验收。

真实 Provider 调用只在操作者明确授权后运行 `pnpm test:ai:live`。凭证通过受保护环境提供，不写命令行、日志或文档；不会因本机已有 key 自动启用，也不自动重试。变量为 DRAMAFLOW_LIVE_AI_BASE_URL、DRAMAFLOW_LIVE_AI_MODEL、DRAMAFLOW_LIVE_AI_CREDENTIAL_ENV 及后者指向的凭证变量。该入口使用高级兼容插件，不代替普通 Provider 路径。

浏览器验证默认人工执行，只有明确要求时才运行现有 Playwright 脚本。它使用系统 Chrome、根 `.env`、本机基础设施及隔离库，在 3200 / 3201 启动服务；不与占用同一测试库或端口的检查并行。代理构建后可用 `pnpm build --filter=@dramaflow/web` 恢复常规配置。

离开保护、刷新 / 重启后的 invocation recovery、多 Tab storage event、Logout 后重新登录仍需真实浏览器人工确认；使用受控本地能力，避免重复收费。不把本机临时 Workflow、模型配置 ID 或运行内容写成仓库现状。

`pnpm fixture:ai-text <ownerId>` 在本机 `dramaflow` 库为已有账号创建普通草稿，名称是「AI 文本处理 · Composite 验收」。它从测试 helper 实例化，不注册生产 Catalog，不创建版本或运行。重复执行只报告已有同名项目。结果不明时先核对项目列表，不要盲目重放。

## 前端职责目录

按业务入口组织 feature，再按实际职责划分内部目录，不把大文件机械切成同层碎片，也不按行数统一拆分。当前画布与检查器的目录边界如下。

| 目录                                                       | 职责                                                                                                          |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `workflow/runtime/projection/`                             | Graph Execution Projection 的解析、查询缓存与按 Definition Location 保存的 execution selection；不负责状态 UI |
| `workflow/runtime/presentation/`                           | Canvas 状态图标、徽标、投影提示及样式；只消费共享 projection / runtime context                                |
| `workflow/runtime/runtime-status.ts`                       | Canvas / Inspector 共用的节点运行态计算与 Provider，保留为模块边界                                            |
| `workflow/run/history/`                                    | 历史 Run 列表及其样式，不复制执行查看器或维护第二套 projection                                                |
| `workflow/canvas/adapter/`                                 | 纯转换与领域编辑：节点 / 边序列化、投影、Handle 校验、连接 / 删除 / 重连；不弹窗或持有 React 状态             |
| `workflow/canvas/editing/`                                 | 用户编辑操作：确认来源替换 / 候选、输入输出边界弹窗、Context 操作装配；领域修改调用 adapter 或已有领域工具    |
| `workflow/canvas/view/`                                    | 选择、测量、Inspector 模式等会话状态，隔离 React Flow 视图事件与可持久化修改                                  |
| `workflow/canvas/rendering/`                               | 节点 / 连线渲染、呈现规则与相邻 CSS Module                                                                    |
| `workflow/inspector/design/`                               | 节点配置与草稿输入编辑                                                                                        |
| `workflow/inspector/runtime/`                              | NodeRun / attempt、运行值与审批呈现，不修改草稿                                                               |
| `workflow/inputs/definitions/`                             | 通用 Graph Input 定义、校验、类型选项与 Root / Body 共用编辑控件                                              |
| `workflow/inputs/bindings/`                                | 通用图输入 binding 的写入、重命名及兼容性清理，不依赖 Iteration                                               |
| `workflow/iteration/inputs/`                               | Iteration composite、Body / 不变输入及映射；依赖通用 Input 能力                                               |
| `models/settings/`、`catalog/`、`shared/`                  | 设置会话与目录展示；`shared/` 放配置摘要和供应商 / 模型配置共用的 Schema 字段表单                             |
| `models/providers/`、`configurations/`                     | 分别维护供应商及凭证表单、模型配置表单与列表；提交和密钥清理就近保留                                          |
| `workflow/model-selection/selection/`                      | 选择 Context、用户级查询、恢复会话与选项推导，不持有凭证                                                      |
| `workflow/model-selection/presentation/`、`configuration/` | 选项展示与明确的添加配置操作                                                                                  |

Canvas 与 Inspector 根目录保留装配入口及共享类型 / 样式。内部模块直接依赖职责明确的文件；需要兼容调用方的适配导出集中在 `react-flow-adapter.ts`。

## Server 测试与共享配置目录

`packages/server/test/` 按被测模块组织，单元 / 集成性质继续由文件名和既有环境 gate 表达，不另建一套平行模块树：

| 目录                                                                              | 职责                                                 |
| --------------------------------------------------------------------------------- | ---------------------------------------------------- |
| `workflow/run/cancellation/`、`workflow/run/history/`、`workflow/run/repository/` | Run 取消闸门、历史查询与版本读取                     |
| `workflow/runtime/execution/`                                                     | ChildExecution 生命周期、Iteration 与组合 checkpoint |
| `workflow/execution-tree/`、`workflow/queue/`、`workflow/node/`                   | 执行树、投递命令与 Catalog 实例化                    |
| `models/`、`artifacts/`、`storage/`、`secrets/`                                   | 模型权限、执行数据、对象存储和密钥服务               |
| `migrations/`                                                                     | 隔离 schema 的无损迁移与数据库约束验证               |
| `fixtures/`                                                                       | 供多个测试使用的数据样例，不注册到生产 Catalog       |

Web 的执行投影测试对应 `test/workflow/runtime/`；历史、状态、恢复、结果和执行树测试分别放入 `test/workflow/run/` 的同名职责子目录。Run 创建 / 表单测试留在该目录入口层，不混放 nested projection 测试。普通 Vitest 与专项配置沿用递归 include，移动测试不减少覆盖。

仓库级共享测试配置与其类型声明位于 `config/testing/`；各包根目录只保留 Vitest 约定入口，引用同一默认值。脚本的包级并发控制仍由 `scripts/task.mjs` 负责。

## 文档维护

- AGENTS.md：稳定边界和按任务阅读入口；README：启动与导航。
- architecture.md：已实现能力及入口。平台边界、协议、认证、部署、存储和前端规范各自只描述自己的事实。
- 包 README：目录职责与链接。相同事实只保留一个权威位置，精确字段以代码为准。
- 原地替换过时内容，删除重复说明并修复引用。历史交给 Git。
