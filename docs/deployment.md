# 部署、迁移与数据

开发环境运行 pnpm infra:up 启动 PostgreSQL/pgvector、Redis 和 RustFS，并初始化存储桶；pnpm dev 启动前后端及基础 worker。完整容器部署使用 pnpm stack:up。

向量检索继续使用 PostgreSQL pgvector，不增加独立向量数据库。PostgreSQL 与 Redis 由 Docker Compose 管理；对象存储使用 RustFS 官方固定版本镜像及持久化卷，具体配置见 [RustFS 存储](object-storage.md)。

端口使用默认 5432、6379、9000、9001，应用前端 3000。宿主仅监听 127.0.0.1，对外访问需要 HTTPS 反向代理。Docker 内部通过 postgres、redis、rustfs 服务名访问，不使用宿主 localhost。

Prisma 迁移保留 vector 扩展及用户身份、资料、凭证、会话、限流和基础项目表，不包含工作空间或运行模型。当前 canvas_project 保存项目所有者、名称、视口、revision 及时间字段。

[项目基础迁移](../packages/database/prisma/migrations/20261019000000_project_foundation/migration.sql) 删除 canvas_project 的 definition、nodeCount 列及 plugin_installation 表。尚未应用该迁移的环境执行时会清除旧节点、连线、数据绑定及插件安装记录，包括其中的配置与加密凭证；保留项目基础信息与身份数据，不操作 Redis、RustFS 或其他数据卷。当前协议不兼容这些旧业务字段。

执行迁移前核对本机 DATABASE_URL 的宿主、端口和库名，确认属于本项目开发环境，然后运行 pnpm db:generate、pnpm db:migrate。当前基础迁移无需 prisma migrate reset 或删除卷；检查入口及适用范围见 [开发指南](development.md)。

Compose 的 migrate 服务执行 db:migrate 和幂等 auth:bootstrap，创建初始管理员。storage-init 初始化 RustFS 桶。API 等迁移与存储初始化成功后启动；worker 和 web 等 API 健康后启动。

## 开发数据变更与授权

当前开发阶段不要求兼容旧数据、表结构、字段或业务协议。优先保持领域模型和代码清晰，不为临时开发数据增加兼容层、双写或历史迁移逻辑。

用户已授权：为落实本项目开发中的不兼容变更，可以直接清空本项目开发环境的数据并重新初始化，无需为同一授权重复确认。授权不包含生产、外部共享环境或其他项目的数据。

重置必须服务于当前变更。操作前核对目标环境，以及数据库、桶或卷的范围；只清理确有必要重置的数据，在交付说明中如实记录，不因已有授权而例行删除数据。

确定开发环境可以整体重建时，允许同步重建数据库迁移基线；不得擅自重写已被生产或外部共享环境使用的迁移记录。实施重置或基线重建时，同步更新对应的重置方式与初始化步骤。本节是数据变更授权与边界，不表示每轮实施都需要重置环境。

## 数据保留与排障

持久化卷保留 PostgreSQL、Redis、RustFS 数据及日志。不要使用 down -v 排障。备份应覆盖 PostgreSQL、RustFS 对象和需要保留的秘密，恢复应先在独立环境验证。

排障入口：docker compose ps、docker compose logs --tail=100 postgres redis rustfs，以及 API /api/v1/health。认证配置、HTTPS、反向代理和账号初始化见 [认证部署说明](authentication.md)。更新源码后需重新构建并部署镜像才能生效。
