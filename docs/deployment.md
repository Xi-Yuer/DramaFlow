# 部署、迁移与数据

开发环境运行 pnpm infra:up 启动 PostgreSQL/pgvector、Redis 和 RustFS，并初始化存储桶；pnpm dev 启动前后端及基础 worker。完整容器部署使用 pnpm stack:up。

端口使用默认 5432、6379、9000、9001，应用前端 3000。宿主仅监听 127.0.0.1，对外访问需要 HTTPS 反向代理。Docker 内部通过 postgres、redis、rustfs 服务名访问，不使用宿主 localhost。

Prisma 迁移保留 vector 扩展及用户身份、资料、凭证、会话、限流和基础项目表，不包含工作空间或运行模型。当前 canvas_project 保存项目所有者、名称、视口、revision 及时间字段。

[项目基础迁移](../packages/database/prisma/migrations/20261019000000_project_foundation/migration.sql) 删除 canvas_project 的 definition、nodeCount 列及 plugin_installation 表。尚未应用该迁移的环境执行时会清除旧节点、连线、数据绑定及插件安装记录，包括其中的配置与加密凭证；保留项目基础信息与身份数据，不操作 Redis、RustFS 或其他数据卷。当前协议不兼容这些旧业务字段。

执行迁移前核对本机 DATABASE_URL 的宿主、端口和库名，确认属于本项目开发环境，然后运行 pnpm db:generate、pnpm db:migrate。清理不需要 prisma migrate reset 或删除卷；基础工程的检查入口及适用范围见 [开发指南](development.md)。生产或外部共享环境不属于开发数据清理授权范围。

Compose 的 migrate 服务执行 db:migrate 和幂等 auth:bootstrap，创建初始管理员。storage-init 初始化 RustFS 桶。API 等迁移与存储初始化成功后启动；worker 和 web 等 API 健康后启动。

持久化卷保留 PostgreSQL、Redis、RustFS 数据及日志。不要使用 down -v 排障。备份应覆盖 PostgreSQL、RustFS 对象和需要保留的秘密，恢复应先在独立环境验证。

排障入口：docker compose ps、docker compose logs --tail=100 postgres redis rustfs，以及 API /api/v1/health。认证配置、HTTPS、反向代理和账号初始化见 [认证部署说明](authentication.md)。更新源码后需重新构建并部署镜像才能生效。
