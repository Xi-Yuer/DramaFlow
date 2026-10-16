# 部署、迁移与数据

开发环境运行 pnpm infra:up 启动 PostgreSQL/pgvector、Redis 和 RustFS，并初始化存储桶；pnpm dev 启动前后端及基础 worker。完整容器部署使用 pnpm stack:up。

端口使用默认 5432、6379、9000、9001，应用前端 3000。宿主仅监听 127.0.0.1，对外访问需要 HTTPS 反向代理。Docker 内部通过 postgres、redis、rustfs 服务名访问，不使用宿主 localhost。

当前 Prisma 迁移基线仅创建 vector 扩展，不包含用户、工作空间、工作流或其他业务表。旧环境的数据库表、Redis 数据和对象不会因删除代码而自动清空；它们当前没有业务入口，也不会由 worker 消费。

若后续需要从空库开始，在确认 DATABASE_URL 只指向本项目开发库后，运行 pnpm --filter @dramaflow/database exec prisma migrate reset --force（自行加载根 .env）。这会清空目标数据库中的 schema，请勿指向其他项目或生产库。当前清理没有执行该重置，也没有删除数据卷。

Compose 的 migrate 服务只执行 db:migrate，不再初始化管理员。storage-init 初始化 RustFS 桶。API 等迁移与存储初始化成功后启动；worker 和 web 等 API 健康后启动。

持久化卷保留 PostgreSQL、Redis、RustFS 数据及日志。不要使用 down -v 排障。备份应覆盖 PostgreSQL、RustFS 对象和需要保留的秘密，恢复应先在独立环境验证。旧版本本地 assets 卷若存在，不会自动删除，当前代码已无本地素材兼容逻辑。

排障入口：docker compose ps、docker compose logs --tail=100 postgres redis rustfs，以及 API /api/v1/health。源码清理后需重新构建镜像，旧镜像仍可能包含旧代码。
