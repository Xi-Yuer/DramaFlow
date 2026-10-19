# 部署、迁移与数据

开发环境运行 pnpm infra:up 启动 PostgreSQL/pgvector、Redis 和 RustFS，并初始化存储桶；pnpm dev 启动前后端及基础 worker。完整容器部署使用 pnpm stack:up。

端口使用默认 5432、6379、9000、9001，应用前端 3000。宿主仅监听 127.0.0.1，对外访问需要 HTTPS 反向代理。Docker 内部通过 postgres、redis、rustfs 服务名访问，不使用宿主 localhost。

Prisma 迁移保留 vector 扩展及用户身份、资料、凭证、会话、限流和基础项目表，不包含工作空间或运行模型。当前 canvas_project 保存项目所有者、名称、视口、revision 及时间字段。

本轮新增清理迁移，删除 canvas_project 的 definition、nodeCount 列及 plugin_installation 表。应用迁移会清除旧节点、连线、数据绑定和插件安装记录（包括其中保存的配置和加密凭证），保留项目记录、名称、视口、revision 及全部身份数据。迁移不操作 Redis、RustFS 或其他数据卷；不再提供旧工作流协议兼容入口。

执行迁移前核对本机 DATABASE_URL 的宿主、端口和库名，确认属于本项目开发环境，然后运行 pnpm db:generate、pnpm db:migrate。清理不需要 prisma migrate reset 或删除卷；本轮实际执行记录与验证状态见 [当前验证范围](verification.md)。生产或外部共享环境不属于开发数据清理授权范围。

2026-10-19 已核对并在 localhost:5432/dramaflow 本项目开发库成功应用新增迁移 `20261019000000_project_foundation`，未重写历史迁移。迁移前有 2 个用户、11 个项目，其中 2 个项目含旧节点，另有 1 条插件安装记录；本次仅清理上述已移除的定义、计数及插件安装数据，保留全部项目和身份记录，未重置数据库或删除卷。

Compose 的 migrate 服务执行 db:migrate 和幂等 auth:bootstrap，创建初始管理员。storage-init 初始化 RustFS 桶。API 等迁移与存储初始化成功后启动；worker 和 web 等 API 健康后启动。

持久化卷保留 PostgreSQL、Redis、RustFS 数据及日志。不要使用 down -v 排障。备份应覆盖 PostgreSQL、RustFS 对象和需要保留的秘密，恢复应先在独立环境验证。旧版本本地 assets 卷若存在，不会自动删除，当前代码已无本地素材兼容逻辑。

排障入口：docker compose ps、docker compose logs --tail=100 postgres redis rustfs，以及 API /api/v1/health。认证配置、HTTPS、反向代理和账号初始化见 [认证部署说明](authentication.md)。源码清理后需重新构建镜像，旧镜像仍可能包含旧代码。
