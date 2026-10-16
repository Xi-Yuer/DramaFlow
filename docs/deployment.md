# 部署、迁移与备份

## 两种启动方式

开发：`pnpm infra:up` 启动 PostgreSQL/pgvector、Redis 和 RustFS，并幂等初始化素材桶，应用由 `pnpm dev` 启动。部署：`pnpm stack:up` 使用 app profile，构建并运行完整服务。

Compose 保留 PostgreSQL 5432、Redis 6379 默认端口，仅绑定宿主 127.0.0.1；前端默认 3000。容器之间通过 postgres:5432、redis:6379、api:3001 通信。端口占用时先处理现有服务，不自动修改端口。

`postgres-data`、`redis-data`、`rustfs-data`、`rustfs-logs` 是持久化卷；`assets` 只用于保留历史本地素材。`down` 不删除这些卷；不要为排障执行 `down -v`，除非确实要清空所有数据。

## 初始化与配置

`pnpm env:init` 幂等生成 `.env`，为已有文件补齐缺少的 RustFS 变量，不覆盖已有配置。密码和密钥只保存在权限 0600 的本地文件，不打印到终端。迁移服务和素材桶初始化成功结束后 API 才启动，API 健康后 worker 和前端启动。

对外部署需要自己的 HTTPS 反向代理、域名、强管理员密码和密钥。`BETTER_AUTH_URL`、`WEB_ORIGIN` 使用浏览器访问的同一站点。模型服务地址通过受权限保护的连接配置管理。

当前应用镜像复用完整 monorepo 构建产物，确保 Prisma 迁移工具与共享包一致。它优先保证可复现；后续可在不改变领域协议的前提下分别裁剪 web/API/worker 镜像。

## RustFS 素材

默认使用 RustFS 的私有 S3 桶。宿主应用连接 `http://localhost:9000`，Compose 内应用连接 `http://rustfs:9000`。控制台为 `http://localhost:9001/rustfs/console/`，凭证保存在 `.env` 的 `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY`。这些端口仅绑定 127.0.0.1。素材通过资产接口授权读取，不向浏览器下发对象存储密钥。详见 [对象存储部署与迁移](object-storage.md)。

数据库中保存资产版本和存储引用；仅备份 PostgreSQL 不能恢复实际媒体文件，必须同时备份素材存储。

## 备份与恢复

数据库备份使用 `docker compose exec -T postgres pg_dump -U dramaflow -d dramaflow -Fc`，将标准输出重定向到你指定的备份文件。恢复前先备份目标环境，使用兼容版本的 pg_restore；不要把恢复直接覆盖到唯一数据副本。

同时备份 RustFS 对象（若有历史 local 素材，还需备份 assets 卷），以及用于解密模型连接的 `CREDENTIAL_ENCRYPTION_KEY`。该密钥丢失后无法从数据库恢复明文凭证。备份秘密和备份数据库分开保管。

升级前备份，执行已审查迁移，再部署对应版本。运行恢复要求保留原工作流和插件版本，不能仅部署新插件然后假定旧任务仍兼容。

## 健康与排障

```sh
docker compose ps
docker compose logs --tail=100 postgres redis rustfs
docker compose --profile app logs --tail=100 api worker web migrate
```

API 健康路径 `/api/v1/health`。运行失败先看结构化事件与 operation 状态；outcome_unknown 不能通过删除记录强制重试。日志或故障报告对外分享前检查是否包含用户提示词和素材，平台不会记录凭证。
