# 开发指南

环境初始化见[README](../README.md)，服务与持久化配置见[部署](deployment.md)。需要 Node.js 24、pnpm 10.7 和 Docker Compose。根任务加载 `.env`；共享包从 dist 导出，由 Turbo 先构建依赖。

## 编码与模块规范

TypeScript 使用严格模式，外部输入在边界校验；不用无依据的 any、忽略检查或空 catch 隐藏错误。代码标识符使用英文，界面与文档使用中文。格式遵循根 Prettier / ESLint 配置。

按职责组织实现；公开入口只装配模块，内部直接依赖具体职责文件。不为小文件创建层层转发，不因文件长而机械拆分。contracts 保持框架无关；运行、存储和 HTTP 不进入业务 Action。

实现业务前先判断是产品 Node / Plugin，还是新的通用控制语义，遵守[业务解耦](architecture.md#业务解耦)。API 默认认证，读写在服务端重检权限，配置与生成保持明确操作边界。测试替身只存在于测试装配，不能成为生产兜底。

## 常用命令

| 命令                                                     | 长期职责                                 |
| -------------------------------------------------------- | ---------------------------------------- |
| `pnpm dev`                                               | 启动 workspace 开发进程                  |
| `pnpm build`                                             | 构建应用和共享包                         |
| `pnpm typecheck` / `pnpm lint` / `pnpm test`             | 类型、静态检查和默认单元 / 组件测试      |
| `pnpm format` / `pnpm format:check`                      | 写入或检查统一格式                       |
| `pnpm check`                                             | lint → typecheck → 默认测试 → build      |
| `pnpm env:init`                                          | 创建受保护环境文件，或补齐缺少的配置     |
| `pnpm infra:up` / `pnpm infra:down`                      | 启停依赖服务；up 并初始化存储桶          |
| `pnpm stack:up` / `pnpm stack:down`                      | 启停完整容器部署                         |
| `pnpm db:generate` / `pnpm db:migrate` / `pnpm db:reset` | 客户端生成、部署迁移、受限本机重置       |
| `pnpm storage:init`                                      | 幂等初始化私有桶                         |
| `pnpm auth:bootstrap` / `pnpm auth:create-user`          | 初始化管理员或开通成员账号               |
| `pnpm model:configure <配置文件>`                        | 服务端创建明确指定的 Provider / 模型绑定 |

可以按包或文件筛选，避免不相关的重复验证：

```sh
pnpm test --filter=@dramaflow/workflow
pnpm test --filter=@dramaflow/workflow -- test/run/workflow-resume.test.ts
# 依赖已构建时进行交互式开发
pnpm --filter @dramaflow/workflow exec vitest test/run/workflow-resume.test.ts
```

默认 Turbo 同时测试一个包，每个 Vitest 最多两个 workers。共享配置位于 `config/testing/`，各包保留自己的 alias、globals 与专项串行设置。测试不使用 Turbo 结果缓存。

## 测试策略

| 入口                                                    | 覆盖与前置条件                                                         |
| ------------------------------------------------------- | ---------------------------------------------------------------------- |
| `pnpm test`                                             | 默认单元 / 组件行为；基础设施用例按门禁跳过，不把 skipped 计为 passed  |
| `pnpm test:integration`                                 | 本机 PostgreSQL、Redis、RustFS，真实 HTTP 和独立 Worker；不调用真实 AI |
| `pnpm test:migrations`                                  | 随机空数据库正式 deploy，ORM drift、完整 SQL catalog 和关键不变量      |
| `pnpm test:storage`                                     | 独立运行 RustFS 对象和签名访问测试，使用自建随机桶                     |
| `pnpm test:browser [spec文件]`                          | 系统 Chrome 上的 Playwright Workflow / 模型管理交互回归                |
| `pnpm test:ai:live`                                     | 使用显式配置的真实兼容 Provider 验证实际文本调用，可能产生费用         |
| `node --test scripts/configure-model-provider.test.mjs` | 模型 CLI 参数校验和错误脱敏                                            |

[集成入口](../scripts/integration.mjs)构建应用，准备 `dramaflow_test` 并应用迁移，初始化官方 Checkpointer，然后执行 API e2e、Server、Database 和真实存储测试。队列前缀与 S3 桶按测试进程随机隔离；只清理自己创建的账号、项目、模型、对象和 thread，退出只删除自己的桶。禁止清空共享队列或开发素材桶。

数据库用例需要 `DRAMAFLOW_INTEGRATION=1` 且目标为本机 `dramaflow_test`。迁移测试再创建随机 `dramaflow_test_baseline_*` 空库并在结束时删除；不依赖已有 ledger 或测试数据。MemorySaver 用于单元测试，正式持久化恢复由 PostgreSQL 用例验证。内部装配绕过 Publish 的故障用例不能代表产品准入。

浏览器工具使用根 `.env` 和隔离测试库 / 队列，在 3200 / 3201 启动 Web / API，建立测试账号并清理自己的数据。不要与占用相同测试库或端口的验证并行。它会用测试代理地址构建 Web；恢复日常代理配置可重新 `pnpm build --filter=@dramaflow/web`。运行单一模型管理套件使用 `pnpm test:browser model-settings.spec.ts`。

真实 Provider 测试不因本机已有 key 自动启用，也不自动重试。先构建应用，通过受保护环境提供 DRAMAFLOW_LIVE_AI_BASE_URL、DRAMAFLOW_LIVE_AI_MODEL、DRAMAFLOW_LIVE_AI_CREDENTIAL_ENV 及其指向的凭证变量。命令只测试高级兼容路径，不代表官方目录的所有模型都可用。凭证不写入命令行或日志。

## 数据库开发

唯一 ORM schema 位于 `packages/database/prisma/schema.prisma`。Foundation v1 使用单一 baseline；SQL 中的 CHECK、trigger / function 与复合外键也是架构契约，不能仅从 Prisma model 生成后覆盖。正式部署后，后续变化使用 append-only migration，不重写已部署历史。

创建结构变更时在本机按 Prisma `migrate dev` 流程生成新迁移，审阅 SQL 并补齐数据库约束测试；部署使用 `pnpm db:migrate`。不要手工修改 ledger。官方 `langgraph` schema 归 Saver 管理，不混入 Prisma 迁移。

本机开发数据可重建。先停止 API / Worker，核对根 `.env` 仅指向本项目本机库：

```sh
pnpm db:reset
pnpm auth:bootstrap
pnpm db:reset --test
```

reset 不可逆清除目标库的 public 数据与 langgraph checkpoint，通过正式 Prisma reset / deploy 重建。脚本只允许本机 dramaflow / dramaflow_test，拒绝 production 模式，不清空 Redis、对象存储或其他数据库。破坏性 CLI 操作需要操作者明确同意，不将授权环境变量保存到共享配置。初始化不会恢复业务或测试数据。

## Provider 配置工具

普通模型配置使用 Web 供应商目录。`model:configure` 是服务端部署 / 运维入口，按配置文件声明的 ownerId、插件版本、configuration、credentialsEnv 和 model 创建新实例；不更新、不去重，Provider 与模型创建不构成单一事务。

配置中的 `credentialsEnv` 只保存环境变量名，凭证在服务端读取；文件格式及校验以 [CLI](../scripts/configure-model-provider.mjs)为准。工具不调用模型，只输出创建身份。账号工具读取 ADMIN_* 或 NEW_USER_*；开通和密钥规则见[安全](security.md#开通账号)。

## 文档维护

README 是项目入口；product 区分当前产品与方向，architecture 描述分层，workflow / execution / data / frontend / security 分别维护对应规则，development / deployment 描述工程操作。包 README 只说明包职责与代码导航。

长期文档不保存任务提示、实施流水、测试通过数量、人工检查记录、一次性修复或完成清单。变更原地更新对应事实并修复链接，历史追溯使用 Git。行为与边界以代码和正式测试为准，文档不把 fixture 或设计蓝图当成交付能力。
