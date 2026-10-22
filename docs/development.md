# 开发指南

启动命令见[根 README](../README.md)。根任务加载 `.env`，单独启动应用时需自行传入；共享包从 dist 导出，根 Turbo 任务先构建依赖。只读当前任务涉及的代码和专题，不通读全部文档。

## 检查入口

| 命令                                                  | 用途                                                            |
| ----------------------------------------------------- | --------------------------------------------------------------- |
| pnpm lint / typecheck / test / build                  | 静态检查、类型、单元测试与构建，可传 Turbo --filter             |
| pnpm check                                            | 上述四项完整检查                                                |
| pnpm test:integration                                 | PostgreSQL / Redis / RustFS 与正式 HTTP、队列、独立 Worker 集成 |
| pnpm test:storage                                     | 真实 RustFS 基础操作与签名访问                                  |
| pnpm test:web:workflow                                | Chrome 中验证草稿与模型管理                                     |
| pnpm test:web:models                                  | 只验证模型管理浏览器流程                                        |
| node --test scripts/configure-model-provider.test.mjs | 模型配置 CLI 输入与失败脱敏                                     |

按改动选择检查：协议 / Registry 使用相关包单元测试；执行 / 持久化使用定向集成；界面改动使用相关 Web 检查。仅改文档时检查格式、链接和现状一致性，无需例行重跑业务测试。失败边界应验证真实行为，测试替身不能成为生产兜底。

## 集成测试边界

`pnpm test:integration` 先构建，再使用独立 `dramaflow_test` 与随机 `dramaflow-test-*` 队列前缀，部署已有迁移。只清理自建账号、项目、对象和 thread，不清空开发库或共享队列。手动运行单个 e2e 时也必须满足测试文件的环境保护，不能直接指向业务库。

| 用例文件（apps/api/test）                                 | 验证重点                                              |
| --------------------------------------------------------- | ----------------------------------------------------- |
| auth、workflows、workflow-versions、workflow-editor-api   | 权限、字段、修订与发布并发、严格静态语义              |
| workflow-runs、workflow-runner、node-runs                 | 真实 Repository、状态转换、attempt 和并发 claim       |
| persistent-checkpoint、workflow-runtime、workflow-run-api | 跨进程持久恢复、API / Worker 装配和 HTTP              |
| workflow-invocation                                       | 调用 key 唯一竞争、六种状态复用、参数冲突和身份不可变 |
| workflow-queue                                            | Outbox 事务、SIGKILL / stalled 重投、结果不明不重跑   |
| artifacts                                                 | 真正 PostgreSQL / RustFS 内容写入、引用读取与故障补偿 |
| model-management、ai-text                                 | 管理 HTTP、安全凭证链、两种文本协议与正式 Worker 执行 |

原生 interrupt / 控制节点夹具只验证 LangGraph 适配，不能证明 Human Review 产品已实现；MemorySaver 只用于单元测试。文本本机协议服务使用真实 SDK，但不能替代真实收费模型验收。详细断言以测试代码为准，文档不复制每个用例的执行流水。

## 真实模型验收

默认不运行 `ai-text-live.e2e-spec.ts`。需要操作者明确提供 endpoint、模型和凭证来源，在受保护的环境设置：

- DRAMAFLOW_LIVE_AI_BASE_URL
- DRAMAFLOW_LIVE_AI_MODEL
- DRAMAFLOW_LIVE_AI_CREDENTIAL_ENV，以及该变量指向的凭证变量

构建应用并准备本机基础设施后运行 `pnpm test:ai:live`。当前 live 入口使用高级兼容插件 `openai_compatible@1`，用来验收明确指定的兼容地址；它不是普通 Provider 的产品路径。仅接受本项目本机数据库，改用隔离测试库与队列，经正式发布 / Worker 执行一次真实请求并清理自建记录。不会因本机存在 key 自动启用，也不自动重试；再次执行会产生新请求。凭证不得出现在命令行或断言输出。

## Web Workflow 浏览器验证

浏览器验证默认人工执行，不自动运行浏览器测试。下列现有脚本保留，仅在用户明确要求自动化浏览器验证时使用。

`pnpm test:web:workflow` / `pnpm test:web:models` 使用 Playwright 与系统 Google Chrome，不下载浏览器。需要 Node 24、根 `.env`、本机基础设施及已初始化的 dramaflow_test。

覆盖目录驱动的通用节点创建、incomplete 草稿保存刷新、视口坐标转换及目录失败禁用入口；负向网络拦截仅用于测试。

脚本构建 API / Web，在 3200 / 3201 启动服务，使用随机账号与隔离队列，结束清理本次测试数据。不要与其他占用同一测试库或端口的检查并行。失败截图在被忽略的 apps/web/test-results。测试代理构建结束后，常规开发可用 `pnpm build --filter=@dramaflow/web` 恢复代理配置。

## 模型管理验证

contracts / plugins / server 单元测试覆盖 Provider Catalog、Model Catalog 的 Schema、能力筛选与安全边界；model-management.e2e-spec 验证管理 HTTP，ai-text.e2e-spec 验证发布到独立 Worker 的正式链。后者保留旧兼容插件，并检查 OpenAI Chat Completions / Anthropic Messages 的实际本机请求、凭证轮换、权限和不重试行为。

## Web 模型管理验证

Web 包测试覆盖响应处理、Schema 表单与缓存边界；`pnpm test:web:models` 验证真实创建、刷新、启停、轮换和项目隔离，不调用外部模型。负向网络拦截只作测试，不是产品降级路径。

## 文档维护

- AGENTS.md 只保留稳定协作约束和按任务阅读入口。README 只放简介、启动和导航。
- architecture.md 是已实现能力与接口的唯一总览。implementation-plan.md 只放当前阶段、待决策项和路线结论。
- Workflow、Node、数据模型和 Runtime 只保留各自仍有效的协议与失败边界。认证、部署、存储和前端规范按任务读取。包 README 只说明目录职责并链接上述文档。
- 更新时原地替换过时内容，合并重复主题并修复链接。历史过程交给 Git。技术实验和已否决路线的评估放在 experiments，不进入默认阅读路径。
- 不在多份文档复制字段表、接口清单、逐用例报告或同一阶段状态。精确类型、参数和断言以代码为准。未验证的真实模型调用必须标明。
