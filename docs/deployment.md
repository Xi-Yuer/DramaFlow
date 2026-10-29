# 部署、迁移与数据

开发环境用 `pnpm infra:up` 启动 PostgreSQL / pgvector、Redis 和 RustFS，用 `pnpm dev` 启动应用。完整容器环境用 `pnpm stack:up`。`experiments/` 由 `.dockerignore` 排除，不进入生产镜像。

向量检索使用 PostgreSQL pgvector，不增加独立向量数据库。端口保持 5432、6379、9000、9001，前端 3000。宿主只监听 127.0.0.1；Docker 内部通过 postgres、redis、rustfs 服务名访问。对象存储见 [RustFS](object-storage.md)。

Compose 先迁移并幂等创建初始管理员、初始化存储桶，再启动 API；Worker 和 Web 等 API 健康后启动。更新源码后需要重新构建镜像。

## 当前库约束

Prisma 迁移保存身份、资料、会话、项目、Workflow / WorkflowVersion、Run、NodeRun、ChildExecution、Outbox、Artifact 元数据和模型 Provider / 配置。当前模型不含工作空间。完整 DSL 在发布和读取边界校验，不在数据库里拼接。

需要遵守的约束：

- 表名使用 lowercase snake_case。不使用 PascalCase、camelCase，也不靠双引号保留大小写。Prisma `@@map` 同样遵守。
- 每项目一个 Workflow。版本不可更新，workflowId / version 与 workflowId / sourceRevision 唯一。
- Run 的身份、invocationKey、版本和输入不可改写；状态转换由数据库约束保护。threadId 唯一，workflowId / invocationKey 唯一。Start key 随 Run 生命周期保留，新建无数据库默认 key。
- Run cancellationRequestedAt 只写首次请求；pending 取消保留 startedAt 为空，running 请求不改为 cancelled。升级需应用取消意图增量 migration 并同步 API / Worker；旧 Writer 不得与新状态机混用。未 claim 的 Outbox 新增 cancelled 正常终态，不删除执行历史或 checkpoint。
- 在途取消增量迁移为 NodeRun / ChildExecution 增加 cancelled 终态与终态写保护，不新增 Run status 或数据表。先停止旧 API / Worker 写入、应用迁移，再同步部署；旧 Writer 不得继续将取消投影为 failed。Worker 轮询现有数据库意图，不需要新的 Redis channel 或事件服务。
- NodeOccurrence 的 workflowRunId / scopeKey / nodeId 唯一；NodeRun 的 occurrenceId / attempt 唯一，attempt 为正数，复合外键保护项目 / Run / nodeId 归属，终态字段一致。
- ChildExecution 的父 NodeRun / invocationKey 唯一，Run / scopeKey 唯一；Iteration 额外保留父 / index 唯一、typed index 与 metadata.index / invocationKey 一致约束。Body NodeRun 通过 childExecutionId 显式关联，root 为 null；复合外键与触发器保护项目 / Run / nodeId / scope、不可变身份及终态，不按 scopeKey 反查 child。index 不等于 attempt，结束时间沿用 completedAt。
- Artifact 只有 writing / ready / failed；内容身份不可改，终态不可覆盖。对象本体不在数据库。删除项目时按已登记的 storageKey 删除对应对象。
- Provider / ModelConfiguration 归用户所有，两者 Owner 由复合外键保持一致；删除项目不删除模型资源。Provider 的插件版本、configuration，以及模型的 Provider、capability、model、settings 创建后不可改。enabled 和凭证密文可以按服务操作更新。删除配置不是已交付的产品入口。
- Outbox 与 start 同事务写入；恢复意图按 waiting 周期唯一。running → waiting 时由数据库递增 waitingRevision，也作为 Human Review 产品乐观锁返回；客户端只提交 expectedWaitingRevision，不能改写周期。targeted token / decision 复用现有 value JSON，未新增数据库字段或约束。

升级前审阅实际 Prisma migration SQL，确认可能删除的废弃开发表并备份；禁止重写已在生产或外部共享环境应用的迁移。缺少真实 sourceRevision 的旧开发版本不能伪造来源，只能按下方开发数据授权处理。

执行前核对 DATABASE_URL 属于本项目开发库，然后 `pnpm db:generate` 和 `pnpm db:migrate`。当前基础迁移不需要例行 reset 或删除卷。

## LangGraph PostgreSQL Checkpointer

API 与 Worker 用应用级 WorkflowCheckpointerService 和官方 PostgresSaver，连接同一 DATABASE_URL 的独立 pg 池。langgraph schema 由官方 setup() 管理，不进入 Prisma，也不在用户首次运行时初始化。

初始化用事务级 advisory lock 串行 setup()，再用 getTuple() 验证读取。失败报告 WORKFLOW_CHECKPOINT_UNAVAILABLE 并阻止就绪。每进程连接池上限 10，连接超时 5 秒，单条 SQL 超时 10 秒。数据库角色须能创建该 schema 及其中的表。

备份和恢复必须同时覆盖业务表与 langgraph schema。只恢复 Run 或 threadId 不能恢复图。删除项目时按该项目运行的 threadId 调用官方 deleteThread，并移除对应的执行队列任务；数据库外键不会自动清理 checkpoint。升级官方包前，在独立环境验证 setup 和数据兼容。

## Workflow 执行队列

BullMQ 使用既有 REDIS_URL，队列名 workflow-execution，并与业务 Redis 客户端分开。Compose 启用 Redis AOF 和 noeviction。所有 API / Worker 必须使用相同数据库、Redis 和 WORKFLOW_QUEUE_PREFIX（默认 dramaflow-workflow）。同一前缀不能连接两个业务库。集成测试使用随机 dramaflow-test-* 前缀。

WORKFLOW_WORKER_CONCURRENCY 默认 4，范围 1—64。Outbox 扫描间隔默认 1000 毫秒、最小 100。队列锁和 stalled 间隔默认 30000 毫秒、最小 1000。不能靠缩短锁期限掩盖业务副作用。

claim 前的投递失败按指数退避重试，最多约 30 秒，基础设施故障最多 5 次。业务失败不自动重跑。Redis 完成 Job 最多保留 1 天或 10000 条，失败 Job 最多 7 天或 10000 条。正确性依赖 PostgreSQL 意图，不依赖 Redis 记录一直存在。

入队未确认时返回 503，Run 和 Outbox 仍可能已经保存。claim 后进程退出或结果不明记 recovery_required，原 Run 保持真实状态；已有 completed 或下一次 waiting 时只补记意图。没有自动重跑或人工恢复入口。不要只删 Job 或把 running 改回 pending。

Worker 必须常驻，否则 API 可以受理但不会执行。Outbox 没有独立清理任务；删除 Run 会按外键清理其意图。

## 文本模型 Provider 配置

用户级模型迁移从原 Project.ownerId 回填 Owner，保留原 ID、加密凭证及所有重复配置，不合并、不重加密，也不改 Workflow 引用。按正常 Prisma migration 升级后，原模型可供同用户其他项目使用。

模型配置的 HTTP 见 [架构](architecture.md#plugin--provider--模型配置管理-http)。服务端也可以用 CLI 按当前插件 Schema 创建实例，每次都新建，不更新、不去重；Provider 与模型配置不是同一次原子写入。官方 OpenAI / Anthropic 由 `GET /api/v1/provider-catalog` 提供定义，创建实例时不手填 endpoint。这个 CLI 仍按插件 Schema 创建，下面的示例是高级 Custom OpenAI-Compatible，不是普通 Provider 的默认配置方式。

```sh
pnpm build
pnpm model:configure /受保护目录/model-provider.json
```

配置文件只保存非秘密项和凭证环境变量名，不存在默认厂商或默认模型：

```json
{
  "ownerId": "用户 ID",
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

先提供对应 API Key 和 CREDENTIAL_ENCRYPTION_KEY。CLI 可加载根 `.env`，但不得提交该文件，也不得把密钥写入命令行、JSON 或日志。工具只校验并写库，不调用模型，只输出 providerId / modelConfigurationId。API 与 Worker 的加密主密钥必须一致。调用参数、重试和错误投影见 [架构](architecture.md#文本-ai-与-provider-plugin)。

## 开发数据变更与授权

当前开发阶段不要求兼容旧数据、表结构或业务协议。不为临时开发数据增加兼容层、双写或历史迁移逻辑。

为落实本项目开发中的不兼容变更，可以直接清空本项目开发环境的数据并重新初始化，无需为同一授权重复确认。授权不包含生产、外部共享环境或其他项目的数据。

重置必须服务于当前变更。操作前核对目标环境以及数据库、桶或卷的范围，只清理确有必要的数据，并在交付说明中记录。确定开发环境可以整体重建时，允许重建迁移基线；不得重写已被生产或外部共享环境使用的迁移。本节不表示每轮都要重置。

## 数据保留与排障

Node occurrence 增量迁移保留已有节点审计：每组 workflowRunId / nodeId 的全部 attempt 映射到一个 root occurrence，原 NodeRun ID 与 Artifact 外键不变。部署时先停止旧 Worker 消费，再应用迁移并同步更新 API / Worker / Web；新写入要求 occurrenceId，不能与旧写入器混用，NodeRun DTO 新增必填身份，旧 Web 客户端需刷新。该迁移无需清空开发数据，也不重写历史迁移。

ChildExecution 增量迁移原地 rename iteration_item_run 与 NodeRun.iterationItemRunId，保留历史 ID / 归属 / index / 时间 / 状态 / 错误，补齐通用 kind、invocationKey 与 metadata；不清空 Run、Artifact 或 checkpoint。部署前停止旧 API / Worker 写入，备份业务表及 langgraph schema，再执行正常 migrate deploy 并同步更新 API / Worker；旧写入器不能与新表列混用。现有 Iteration checkpoint 私有字段名保持不变，已保存的 ID 继续指向原地迁移后的记录；缺失真实父 attempt / child 身份的更早快照仍不能按 index 自动恢复。

持久化卷保留 PostgreSQL、Redis、RustFS 和日志。不要用 `down -v` 排障。备份覆盖数据库、langgraph schema、对象和需要保留的秘密，恢复先在独立环境验证。

入口：`docker compose ps`、`docker compose logs --tail=100 postgres redis rustfs`，以及 `/api/v1/health`。账号、HTTPS 和反向代理见 [认证](authentication.md)。
