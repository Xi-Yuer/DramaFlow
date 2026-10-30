# 部署与运维

## 部署结构

支持本机源码开发和团队自部署。完整容器环境使用 `pnpm stack:up`；仅启动依赖服务使用 `pnpm infra:up`。Compose 的 migrate 服务应用 Prisma 迁移并幂等创建管理员，存储初始化服务创建桶，API 健康后启动 Worker 与 Web。修改源码后需要重建镜像。

| 服务                  | 本机端口    | 容器地址                      |
| --------------------- | ----------- | ----------------------------- |
| Web                   | 3000        | `web:3000`                    |
| API                   | 3001        | `api:3001`                    |
| PostgreSQL / pgvector | 5432        | `postgres:5432`               |
| Redis                 | 6379        | `redis:6379`                  |
| RustFS API / console  | 9000 / 9001 | `rustfs:9000` / `rustfs:9001` |

基础设施端口在宿主仅监听 127.0.0.1。数据使用独立持久卷；不要用 `down -v` 处理普通故障。当前 RustFS 为单节点，无数据冗余。

## 环境与秘密

`pnpm env:init` 创建权限为 0600 的根 `.env`，为新环境生成数据库、认证、加密和存储秘密；已有配置只补齐缺项。不要提交环境文件，也不依赖隐藏默认 Provider。

| 配置                                       | 用途                                    |
| ------------------------------------------ | --------------------------------------- |
| `DATABASE_URL`、`REDIS_URL`                | API / Worker 共用持久化服务             |
| `WORKFLOW_QUEUE_PREFIX`                    | 同一部署的执行队列 namespace            |
| `BETTER_AUTH_URL`、`WEB_ORIGIN`            | 浏览器实际站点与可信 Origin             |
| `BETTER_AUTH_SECRET`                       | 会话 Cookie 保护                        |
| `CREDENTIAL_ENCRYPTION_KEY`                | Provider 凭证加密主密钥，备份须分开保存 |
| `S3_ENDPOINT`、`S3_REGION`、`S3_BUCKET`    | 内部存储连接与私有桶                    |
| `S3_ACCESS_KEY_ID`、`S3_SECRET_ACCESS_KEY` | 服务端 S3 凭证                          |
| `S3_ACCESS_ENDPOINT`                       | 访问方可达的签名 URL 端点               |
| `TRUSTED_PROXY_CIDRS`                      | 明确信任的反向代理来源                  |

Next.js 同源代理使用 `API_INTERNAL_URL`，否则使用 `API_URL`。生产 HTTPS、Cookie、反向代理和账号开通见[安全](security.md)。服务端秘密不进入 NEXT_PUBLIC_*。

## 数据库迁移

`packages/database/prisma/schema.prisma` 是唯一 canonical ORM schema；空库按序应用 `20261030000000_foundation_v1_baseline` 和后续追加迁移。Baseline 还包含 Prisma 无法表达的 CHECK、trigger / function、身份与生命周期保护，不能仅从模型重新生成后覆盖。pgvector 由 baseline 初始化。

新环境依次运行 `pnpm db:generate`、`pnpm db:migrate`、`pnpm auth:bootstrap`。迁移 ledger 由 Prisma 管理，不手工修复。正式部署后的变更使用新的 append-only migration，不 rewrite / squash 已部署历史；部署前审阅 SQL、备份并验证升级，避免混用不同 schema 的写入器。

开发库重建是破坏性操作，规则和命令见[开发指南](development.md#数据库开发)。不要把开发 reset 用于生产或外部共享环境。

## Checkpoint 与数据库

API / Worker 使用官方 PostgresSaver，与业务表共用 DATABASE_URL、独立连接池和 `langgraph` schema。该 schema 由官方 setup 管理，不进入 Prisma baseline。应用启动时以事务 advisory lock 串行初始化，再以 getTuple 验证可读；失败阻止就绪，无 MemorySaver 回退。

连接池每进程上限 10，连接超时 5 秒，单条 SQL 超时 10 秒；数据库角色须能创建官方 schema。恢复须同时具备业务表、原 thread 的 checkpoint、对应版本与可用实现。升级官方依赖前在隔离环境验证恢复。

## 执行队列

BullMQ 使用同一 REDIS_URL、队列名 workflow-execution，与普通 Redis 客户端分开。Redis 启用 AOF 与 noeviction；同一 WORKFLOW_QUEUE_PREFIX 不能连接两个业务库。

`WORKFLOW_WORKER_CONCURRENCY` 默认 4，范围 1—64；Outbox 默认每 1000ms 扫描，最小 100ms。队列锁与 stalled 默认 30000ms，最小 1000ms。Worker 跨 Run 并发、图级 maxConcurrency 和供应商配额是不同限制，不可用缩短锁期限掩盖副作用。

claim 前基础设施故障采用有界指数退避，业务失败不自动重跑。完成 Job 最多保留 1 天或 10000 条，失败 Job 最多 7 天或 10000 条；正确性依赖数据库意图，不依赖 Job 永远存在。Worker 必须常驻。

recovery_required 没有自动重放或人工处置产品入口；不要删除 Job 后把 running 改回 pending。取消的 requested / uncertain 含义见[执行语义](execution.md#cooperative-cancellation)。

## 对象存储

RustFS 镜像固定为 `rustfs/rustfs:1.0.1`，S3 私有桶由 `storage:init` 使用官方 SDK 幂等创建。配置或网络故障直接失败，无本地文件回退。控制台在 `http://localhost:9001/rustfs/console/`，凭证来自受保护环境。

容器内部 S3_ENDPOINT 为 `http://rustfs:9000`。若客户端或 Provider 在容器外访问签名 URL，须显式配置其可达的 S3_ACCESS_ENDPOINT 和 HTTPS 代理；不能签名后替换 host。签名资源与内容生命周期见[数据](data.md#对象存储与生命周期)。

## 备份、恢复与排障

备份覆盖业务数据库、官方 langgraph schema、对象存储和需要保留的秘密；数据库备份与加密主密钥分开保管。在独立环境验证恢复，不能仅恢复 Run 或 threadId。对象可通过 S3 工具复制到独立存储。

删除项目服务会按登记 key、thread 与 Job 清理关联资源；失败明确报告。单独删除业务元数据不会自动清对象，系统没有通用垃圾回收或自动对账，不应把对象缺失或时间经过解释为执行已经停止。

基本入口：`docker compose ps`、`docker compose logs --tail=100 postgres redis rustfs`、`GET /api/v1/health`。健康检查覆盖 PostgreSQL、Checkpointer、Redis、RustFS，不等于真实 Provider 可用性测试。
