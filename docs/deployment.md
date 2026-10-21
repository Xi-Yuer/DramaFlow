# 部署、迁移与数据

开发环境运行 pnpm infra:up 启动 PostgreSQL/pgvector、Redis 和 RustFS，并初始化存储桶；pnpm dev 启动前后端及基础 worker。完整容器部署使用 pnpm stack:up。

向量检索继续使用 PostgreSQL pgvector，不增加独立向量数据库。PostgreSQL 与 Redis 由 Docker Compose 管理；对象存储使用 RustFS 官方固定版本镜像及持久化卷，具体配置见 [RustFS 存储](object-storage.md)。

端口使用默认 5432、6379、9000、9001，应用前端 3000。宿主仅监听 127.0.0.1，对外访问需要 HTTPS 反向代理。Docker 内部通过 postgres、redis、rustfs 服务名访问，不使用宿主 localhost。

Prisma 迁移保留 vector 扩展及用户身份、资料、凭证、会话、限流、基础项目、Workflow / WorkflowVersion、运行记录、Artifact metadata 及模型 Provider / 配置表，不包含工作空间。当前 canvas_project 保存项目所有者、名称、视口、revision 及时间字段。

NodeRun 的[初始化迁移](../packages/database/prisma/migrations/20261020000000_node_runs/migration.sql)和[字段 / 索引迁移](../packages/database/prisma/migrations/20261020010000_node_run_boundary/migration.sql)建立 node_run，关联现有项目。status 使用 String，并保留数据库三状态校验；字段调整把已有状态转为 text，保留记录与唯一约束，补充 workflowRunId、workflowRunId / nodeId 索引。数据库约束 workflowRunId + nodeId + attempt 唯一、attempt 为正数、输入输出为 JSON 对象及终态字段一致性。Repository 在事务锁内原子分配 attempt；事务级锁随提交或回滚释放，见 [PostgreSQL 官方说明](https://www.postgresql.org/docs/17/explicit-locking.html#ADVISORY-LOCKS)。

[WorkflowRun 迁移](../packages/database/prisma/migrations/20261020020000_workflow_runs/migration.sql)建立 workflow_run，关联项目并保存显式逻辑 workflowId / workflowVersionId。threadId 唯一，状态和时间 / 结果字段一致性由数据库约束；更新触发器保护身份 / 版本 / 输入及合法转换。node_run 通过 workflowRunId / projectId 复合外键关联同项目父运行，父运行删除时级联清理节点记录。为建立真实外键，该迁移会删除没有匹配父运行的旧开发 NodeRun，不补造版本或运行记录；项目、账号、Redis 与对象存储不受影响。新增迁移不重写旧迁移，也无需 reset 或删除卷。

[Workflow / WorkflowVersion 迁移](../packages/database/prisma/migrations/20261020030000_workflow_versions/migration.sql)新增表、索引、外键与版本不可更新触发器，不删除或回填现有业务数据。workflow.projectId 唯一并关联项目；workflow_version 关联 Workflow，以 workflowId / version 唯一，每条保存完整 definition JSON，父级删除时级联。revision / version 要求正数，draft / definition 要求 JSON 对象；完整 DSL 在发布和 Repository 读取边界校验。数据库禁止更新已创建版本，不提供差量拼接。Run 的两个逻辑 ID 保持不变。

[发布来源修订迁移](../packages/database/prisma/migrations/20261020040000_workflow_publish_revision/migration.sql)增加必填、正数 sourceRevision 及 workflowId / sourceRevision 唯一约束；既有不可更新触发器同时保护来源修订。迁移不猜测历史版本来源、不用版本号或当前草稿修订回填；存在缺少真实来源信息的旧开发版本时，应先核对范围并按开发数据授权清理，不能伪造来源。本机空版本表可直接执行 db:migrate，无需 reset。WorkflowService 用原子条件更新实现草稿乐观锁，以事务行锁串行化发布序列；数据库唯一约束是最终防线，不承担正常版本分配。

[Artifact 迁移](../packages/database/prisma/migrations/20261020060000_artifacts/migration.sql)新增 artifact 表与索引，使用项目 / WorkflowRun / 可选 NodeRun 复合外键保证来源一致，并增加 NodeRun 复合唯一索引。不删除或重写现有数据。writing / ready / failed 及终态字段受约束，触发器禁止改写内容身份和覆盖终态；对象本体不进入数据库。写入记录与 RustFS 不能跨库原子提交，失败补偿、未确认记录和对象保留规则见 [对象存储](object-storage.md)。备份须同时覆盖业务库、langgraph schema 与私有对象桶；Prisma 级联删除 metadata 不等于对象清理。

[模型 Provider 迁移](../packages/database/prisma/migrations/20261020070000_model_providers/migration.sql)新增 model_provider 与 model_configuration，不重写现有数据。Provider 所属项目、插件精确版本与 configuration，以及模型配置的 Provider / capability / model / settings，创建后受触发器保护。enabled 可调整，encryptedCredentials 可经明确授权的服务操作轮换；更换模型、参数或 endpoint 应创建新配置。复合外键保证模型配置与 Provider 同属项目。Provider 删除和项目删除按数据库 FK 级联清理配置，不能将其解释为已有配置删除产品入口。

[项目基础迁移](../packages/database/prisma/migrations/20261019000000_project_foundation/migration.sql) 删除 canvas_project 的 definition、nodeCount 列及 plugin_installation 表。尚未应用该迁移的环境执行时会清除旧节点、连线、数据绑定及插件安装记录，包括其中的配置与加密凭证；保留项目基础信息与身份数据，不操作 Redis、RustFS 或其他数据卷。当前协议不兼容这些旧业务字段。

执行迁移前核对本机 DATABASE_URL 的宿主、端口和库名，确认属于本项目开发环境，然后运行 pnpm db:generate、pnpm db:migrate。当前基础迁移无需 prisma migrate reset 或删除卷；检查入口及适用范围见 [开发指南](development.md)。

Compose 的 migrate 服务执行 db:migrate 和幂等 auth:bootstrap，创建初始管理员。storage-init 初始化 RustFS 桶。API 等迁移与存储初始化成功后启动；worker 和 web 等 API 健康后启动。

## LangGraph PostgreSQL Checkpointer

API 与 Worker 的 InfrastructureModule 在 Nest 启动期间创建应用级 WorkflowCheckpointerService，使用 DATABASE_URL 和官方 PostgresSaver 的独立 pg 连接池。相同数据库中的 langgraph schema 是共享 checkpoint store；不同进程不需要共享 JS 对象。不要把 Prisma Client 传给 saver，也不要在 start / resume 中初始化池。

初始化先用事务级 advisory lock 串行化官方 setup()，再用 getTuple() 验证读取；成功后应用才可就绪，失败报告 WORKFLOW_CHECKPOINT_UNAVAILABLE 并关闭连接。API 健康接口同时检查官方 checkpoint 读取路径；正常关闭通过 end() 释放池。连接池上限为每进程 10，连接超时 5 秒、单条 SQL 超时 10 秒，多实例部署需计入 PostgreSQL 总连接预算。

官方 setup() 管理独立 schema 内的 checkpoint_migrations、checkpoints、checkpoint_blobs、checkpoint_writes，不由 Prisma schema / migration 管理，也没有自定义 workflow_checkpoints 表。启动数据库角色须有创建该 schema、表和索引及后续读写权限。升级官方包时需在独立环境验证其 setup / 数据兼容性；不要把 checkpoint 初始化放到用户首次运行请求。

备份和恢复必须同时覆盖业务表与 langgraph schema。仅恢复 WorkflowRun 或仅保留 threadId 不能恢复图；checkpoint 表也不替代业务运行历史。API / Worker 重启后，用原 WorkflowVersion / threadId 连接同一库即可读取已有 checkpoint。跨进程测试使用隔离 dramaflow_test；真实业务删除的 checkpoint 保留 / 清理策略暂未实现，不依赖 Prisma 级联自动删除原生 checkpoint。

## Workflow 执行队列

[Outbox 迁移](../packages/database/prisma/migrations/20261020050000_workflow_execution_outbox/migration.sql)仅新增 workflow_execution_outbox 和内部 waitingRevision，不删除既有 Run、版本或素材，不重建旧迁移。Run 与 start 命令同事务提交；恢复意图按 waiting 周期唯一。新增数据库触发器保护意图身份 / payload，并在 running → waiting 时递增内部周期。

BullMQ 6.3.18 使用既有 REDIS_URL，队列名 workflow-execution；连接独立于业务 RedisService，不使用 Prisma 冒充 Queue。Compose 已启用 Redis AOF 和 noeviction，端口仍为 6379。所有 API / Worker 实例必须使用相同数据库、Redis 和 WORKFLOW_QUEUE_PREFIX（默认 dramaflow-workflow）；同一前缀不能连接两个不同的业务数据库。运行隔离测试使用随机 dramaflow-test-* 前缀，不清生产 Redis。

Worker 并发由 WORKFLOW_WORKER_CONCURRENCY 配置（默认 4，1—64）。WORKFLOW_OUTBOX_INTERVAL_MS 默认 1000、最小 100；WORKFLOW_QUEUE_LOCK_DURATION_MS / WORKFLOW_QUEUE_STALLED_INTERVAL_MS 默认 30000、最小 1000，生产调整前须按事件循环负载验证，不能靠减小锁期限恢复业务副作用。Consumer 关闭时等待活跃任务，OutboxPump 停止扫描后关闭连接；强制退出依赖 BullMQ stalled 重投。

投递失败在 Outbox 记录 attempts、指数退避至最多 30 秒；Consumer 对 claim 前已识别基础设施故障最多执行 5 次投递尝试，业务失败不自动重跑。Redis 完成 Job 保留最多 1 天 / 10000 条，失败 Job 最多 7 天 / 10000 条；PostgreSQL 意图记录继续作为持久去重依据。队列记录不保存业务 outputs，不依赖 Redis 完成记录保留来保证正确性。

API 在 enqueue 确认前不返回成功受理，Redis 不可用返回 WORKFLOW_QUEUE_UNAVAILABLE / 503，Run / Outbox 仍已持久保存，后续可能继续执行。不要因 503 或连接中断盲目重提收费生成。Worker 在 claim 后死亡或基础设施结果不明时，将意图记为 recovery_required，原 Run 保持 running；若已有 completed / 下一 waiting 记录则只补记意图完成。不实现自动重跑或人工恢复入口。核查须同时查看 Run / NodeRun / Outbox / 官方 checkpoint，不能只删除 Job 或把 running 改回 pending。

部署时保持 Worker 常驻运行，否则 API 可以受理入队但无法执行；只运行 API 不会隐式执行 Graph。备份覆盖 PostgreSQL 业务与 checkpoint、Redis AOF；Outbox 本身没有独立的清理任务，业务 Run 删除按 FK 清理其意图。检查入口见 [开发指南](development.md)。

## 文本模型 Provider 配置

新增 [Provider / 模型配置迁移](../packages/database/prisma/migrations/20261020070000_model_providers/migration.sql)，分别保存 Provider 实例和能力 / 模型绑定；同项目复合外键阻止身份拼接，触发器固定插件版本、endpoint、模型和参数。迁移只新增表、索引与约束，不重置既有数据；本机开发库与隔离测试库均已部署。凭证密文和 enabled 状态可按明确服务操作更新，不改变旧 WorkflowVersion 的模型选择。

API 与 Worker 装配 ModelProviderModule，正式节点目录提供 `ai.text_generate@1`；Node config 只接受 modelConfigurationId。模型配置没有 HTTP / UI 管理入口，服务端可用以下 CLI 创建明确选择的 Provider 与模型配置：

```sh
pnpm build
pnpm model:configure /受保护目录/model-provider.json
```

配置文件只保存非秘密配置与环境变量名称，示例中的身份、endpoint、模型名须替换为实际选择，不存在默认厂商或默认模型：

```json
{
  "ownerId": "项目所有者 ID",
  "projectId": "项目 UUID",
  "name": "自选文本服务",
  "pluginId": "openai_compatible",
  "pluginVersion": 1,
  "configuration": {
    "baseURL": "https://models.example.com/v1",
    "timeoutMs": 60000
  },
  "credentialsEnv": { "apiKey": "DRAMAFLOW_MODEL_API_KEY" },
  "model": {
    "capability": "text.generate",
    "model": "明确选择的模型名",
    "settings": { "temperature": 0.7, "maxOutputTokens": 2048 }
  }
}
```

先在受保护的服务器环境中提供对应 API Key 及 CREDENTIAL_ENCRYPTION_KEY；CLI 自动加载根 .env，但不得提交该文件或把密钥写入命令行、JSON 或日志。工具在写库前验证插件、模型参数与凭证结构，校验项目归属，只输出 providerId / modelConfigurationId，不调用模型；错误输出不打印原始异常。配置文件中的 credentialsEnv 只是环境变量名映射，WorkflowDefinition 则只保存返回的 modelConfigurationId。当前 CLI 每次创建新配置，不执行更新或自动去重；两次数据库创建不是跨表原子发布，模型配置写入失败时 Provider 可能已经存在，不能将工具报错视为完全未写入。

OpenAI-compatible 只是一个受信任的参考插件，可配置符合该协议的不同服务；ProviderPlugin 可声明多个 capability。新增适配器需随服务端代码部署并注册精确版本，不能通过 URL 下载代码或动态安装 npm 包。endpoint 允许显式 HTTP(S)，拒绝 URL 内凭证、查询参数和 fragment；不自动跟随重定向。自部署本地 HTTP 模型可用，对外调用应使用 HTTPS。API / Worker 的加密主密钥必须一致，否则 Worker 无法解密 API 创建的凭证。

调用超时默认 60 秒，可显式配置 100 毫秒至 180 秒；模型参数仅支持有界 temperature / maxOutputTokens。LangChain 与 SDK 重试关闭，SDK 日志与自动 tracing 隔离，LANGCHAIN_VERBOSE=true 时拒绝调用，避免泄漏供应商原始异常。不要用调试开关观测收费请求内容；超时、连接故障或 5xx 不代表未受理，不能据此盲目重提 Run。模型输出沿 NodeRun / WorkflowRun 原有安全错误与最终输出链记录。

## 开发数据变更与授权

当前开发阶段不要求兼容旧数据、表结构、字段或业务协议。优先保持领域模型和代码清晰，不为临时开发数据增加兼容层、双写或历史迁移逻辑。

用户已授权：为落实本项目开发中的不兼容变更，可以直接清空本项目开发环境的数据并重新初始化，无需为同一授权重复确认。授权不包含生产、外部共享环境或其他项目的数据。

重置必须服务于当前变更。操作前核对目标环境，以及数据库、桶或卷的范围；只清理确有必要重置的数据，在交付说明中如实记录，不因已有授权而例行删除数据。

确定开发环境可以整体重建时，允许同步重建数据库迁移基线；不得擅自重写已被生产或外部共享环境使用的迁移记录。实施重置或基线重建时，同步更新对应的重置方式与初始化步骤。本节是数据变更授权与边界，不表示每轮实施都需要重置环境。

## 数据保留与排障

持久化卷保留 PostgreSQL、Redis、RustFS 数据及日志。不要使用 down -v 排障。备份应覆盖 PostgreSQL、RustFS 对象和需要保留的秘密，恢复应先在独立环境验证。

排障入口：docker compose ps、docker compose logs --tail=100 postgres redis rustfs，以及 API /api/v1/health。认证配置、HTTPS、反向代理和账号初始化见 [认证部署说明](authentication.md)。更新源码后需重新构建并部署镜像才能生效。
