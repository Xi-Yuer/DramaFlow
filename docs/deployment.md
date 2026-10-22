# 部署、迁移与数据

开发环境用 `pnpm infra:up` 启动 PostgreSQL / pgvector、Redis 和 RustFS，用 `pnpm dev` 启动应用。完整容器环境用 `pnpm stack:up`。`experiments/` 由 `.dockerignore` 排除，不进入生产镜像。

向量检索使用 PostgreSQL pgvector，不增加独立向量数据库。端口保持 5432、6379、9000、9001，前端 3000。宿主只监听 127.0.0.1；Docker 内部通过 postgres、redis、rustfs 服务名访问。对象存储见 [RustFS](object-storage.md)。

Compose 先迁移并幂等创建初始管理员、初始化存储桶，再启动 API；Worker 和 Web 等 API 健康后启动。更新源码后需要重新构建镜像。

## 当前库约束

Prisma 迁移保存身份、资料、会话、项目、Workflow / WorkflowVersion、Run、NodeRun、Outbox、Artifact 元数据和模型 Provider / 配置。当前模型不含工作空间。完整 DSL 在发布和读取边界校验，不在数据库里拼接。

需要遵守的约束：

- 表名使用 lowercase snake_case。不使用 PascalCase、camelCase，也不靠双引号保留大小写。Prisma `@@map` 同样遵守。
- 每项目一个 Workflow。版本不可更新，workflowId / version 与 workflowId / sourceRevision 唯一。
- Run 的身份、invocationKey、版本和输入不可改写；状态转换由数据库约束保护。threadId 唯一，workflowId / invocationKey 唯一。Start key 随 Run 生命周期保留，新建无数据库默认 key。
- NodeRun 的 workflowRunId、nodeId、attempt 唯一，attempt 为正数，终态字段一致。
- Artifact 只有 writing / ready / failed；内容身份不可改，终态不可覆盖。对象本体不在数据库。
- Provider 的插件版本、configuration，以及模型的 Provider、capability、model、settings 创建后不可改。enabled 和凭证密文可以按服务操作更新。删除配置不是已交付的产品入口。
- Outbox 与 start 同事务写入；恢复意图按 waiting 周期唯一。running → waiting 时递增内部周期。

升级前审阅实际 Prisma migration SQL，确认可能删除的废弃开发表并备份；禁止重写已在生产或外部共享环境应用的迁移。缺少真实 sourceRevision 的旧开发版本不能伪造来源，只能按下方开发数据授权处理。

执行前核对 DATABASE_URL 属于本项目开发库，然后 `pnpm db:generate` 和 `pnpm db:migrate`。当前基础迁移不需要例行 reset 或删除卷。

## LangGraph PostgreSQL Checkpointer

API 与 Worker 用应用级 WorkflowCheckpointerService 和官方 PostgresSaver，连接同一 DATABASE_URL 的独立 pg 池。langgraph schema 由官方 setup() 管理，不进入 Prisma，也不在用户首次运行时初始化。

初始化用事务级 advisory lock 串行 setup()，再用 getTuple() 验证读取。失败报告 WORKFLOW_CHECKPOINT_UNAVAILABLE 并阻止就绪。每进程连接池上限 10，连接超时 5 秒，单条 SQL 超时 10 秒。数据库角色须能创建该 schema 及其中的表。

备份和恢复必须同时覆盖业务表与 langgraph schema。只恢复 Run 或 threadId 不能恢复图。业务删除不会级联清理官方 checkpoint，保留策略尚未实现。升级官方包前，在独立环境验证 setup 和数据兼容。

## Workflow 执行队列

BullMQ 使用既有 REDIS_URL，队列名 workflow-execution，并与业务 Redis 客户端分开。Compose 启用 Redis AOF 和 noeviction。所有 API / Worker 必须使用相同数据库、Redis 和 WORKFLOW_QUEUE_PREFIX（默认 dramaflow-workflow）。同一前缀不能连接两个业务库。集成测试使用随机 dramaflow-test-* 前缀。

WORKFLOW_WORKER_CONCURRENCY 默认 4，范围 1—64。Outbox 扫描间隔默认 1000 毫秒、最小 100。队列锁和 stalled 间隔默认 30000 毫秒、最小 1000。不能靠缩短锁期限掩盖业务副作用。

claim 前的投递失败按指数退避重试，最多约 30 秒，基础设施故障最多 5 次。业务失败不自动重跑。Redis 完成 Job 最多保留 1 天或 10000 条，失败 Job 最多 7 天或 10000 条。正确性依赖 PostgreSQL 意图，不依赖 Redis 记录一直存在。

入队未确认时返回 503，Run 和 Outbox 仍可能已经保存。claim 后进程退出或结果不明记 recovery_required，原 Run 保持真实状态；已有 completed 或下一次 waiting 时只补记意图。没有自动重跑或人工恢复入口。不要只删 Job 或把 running 改回 pending。

Worker 必须常驻，否则 API 可以受理但不会执行。Outbox 没有独立清理任务；删除 Run 会按外键清理其意图。

## 文本模型 Provider 配置

模型配置的 HTTP 见 [架构](architecture.md#plugin--provider--模型配置管理-http)。服务端也可以用 CLI 按当前插件 Schema 创建实例，每次都新建，不更新、不去重；Provider 与模型配置不是同一次原子写入。官方 OpenAI / Anthropic 由 `GET /api/v1/provider-catalog` 提供定义，创建实例时不手填 endpoint。这个 CLI 仍按插件 Schema 创建，下面的示例是高级 Custom OpenAI-Compatible，不是普通 Provider 的默认配置方式。

```sh
pnpm build
pnpm model:configure /受保护目录/model-provider.json
```

配置文件只保存非秘密项和凭证环境变量名，不存在默认厂商或默认模型：

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

先提供对应 API Key 和 CREDENTIAL_ENCRYPTION_KEY。CLI 可加载根 `.env`，但不得提交该文件，也不得把密钥写入命令行、JSON 或日志。工具只校验并写库，不调用模型，只输出 providerId / modelConfigurationId。API 与 Worker 的加密主密钥必须一致。调用参数、重试和错误投影见 [架构](architecture.md#文本-ai-与-provider-plugin)。

## 开发数据变更与授权

当前开发阶段不要求兼容旧数据、表结构或业务协议。不为临时开发数据增加兼容层、双写或历史迁移逻辑。

为落实本项目开发中的不兼容变更，可以直接清空本项目开发环境的数据并重新初始化，无需为同一授权重复确认。授权不包含生产、外部共享环境或其他项目的数据。

重置必须服务于当前变更。操作前核对目标环境以及数据库、桶或卷的范围，只清理确有必要的数据，并在交付说明中记录。确定开发环境可以整体重建时，允许重建迁移基线；不得重写已被生产或外部共享环境使用的迁移。本节不表示每轮都要重置。

## 数据保留与排障

持久化卷保留 PostgreSQL、Redis、RustFS 和日志。不要用 `down -v` 排障。备份覆盖数据库、langgraph schema、对象和需要保留的秘密，恢复先在独立环境验证。

入口：`docker compose ps`、`docker compose logs --tail=100 postgres redis rustfs`，以及 `/api/v1/health`。账号、HTTPS 和反向代理见 [认证](authentication.md)。
