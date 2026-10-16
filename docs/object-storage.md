# RustFS 对象存储

## 决策与边界

按用户选型，图片、视频、音频和其他素材统一写入 RustFS；通过标准 S3 SDK 接入。PostgreSQL 只保存资产元数据、版本和对象标识，API 负责工作空间权限。对象桶保持私有，不依赖匿名访问。

Compose 固定官方镜像 `rustfs/rustfs:1.0.1`，不使用 latest。不附带 Grafana、Prometheus 或其他观测服务。版本升级需先备份并在测试环境验证 SDK 读写，不自动追随镜像发布。

当前采用单节点单卷部署，降低部署复杂度。单节点没有磁盘故障冗余，需要异机备份；不能用同一物理盘上的多个目录冒充多盘容错。镜像体积、空闲内存和上传峰值需要分别评估，不能由镜像大小推断运行所需内存。

## 启动与配置

```sh
pnpm env:init
pnpm infra:up
```

`infra:up` 启动 PostgreSQL、Redis 和 RustFS，等待健康，然后使用 API 已锁定的 AWS SDK 幂等创建素材桶。凭证错误或服务不可达会明确失败，不能被当作桶不存在。完整 Docker 部署时由 `storage-init` 一次性服务完成同样操作，API 等它成功后才启动。

- S3 API：http://localhost:9000
- 控制台：http://localhost:9001/rustfs/console/
- 控制台登录：查看本机 `.env` 的 `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY`，不要提交或分享。
- `S3_BUCKET=dramaflow`，`S3_REGION=us-east-1`。
- 本机应用：`S3_ENDPOINT=http://localhost:9000`；Compose 内覆盖为 `http://rustfs:9000`。
- `STORAGE_DRIVER=s3`；缺少配置会在启动时失败，不回退本地。只有隔离测试或历史部署才显式使用 local。

命名卷 `rustfs-data` 保存对象，`rustfs-logs` 保存服务日志。宿主端口仅绑定 127.0.0.1；跨机访问使用 HTTPS 反向代理或安全隧道。不要用 `docker compose down -v` 排障，该操作会删除所有卷。

## 已有环境切换

`pnpm env:init` 只补齐缺失变量，不改已有驱动、密码和自定义端点。已有环境需把 `.env` 的 `STORAGE_DRIVER` 改为 s3，运行 `pnpm infra:up`，再重启 API 和 worker；当前开发环境已执行此切换。

保留原 `STORAGE_PATH` 和 assets 卷，数据库中 `storageType=local` 的历史引用仍从原目录读取，新素材写入 RustFS。此兼容不代表已迁移旧文件。不要先删除旧目录或直接把数据库 storageType 批量改为 s3。

若需要把历史素材全部迁入 RustFS，应安排独立迁移：按资产版本读取源文件，上传并核对长度和 SHA-256，再事务更新该版本的存储引用；每条记录可恢复，保留源文件直到完成验收和备份。这轮没有自动搬迁或删除历史文件。

目前资产入口仍保留原有 25 MiB 限制，切换对象存储不会自动解除 API 的上传限制。大视频需要后续单独实现授权分片上传及流式读取，不能把“RustFS 可存大文件”当作平台已支持大视频上传。

## 验证与备份

```sh
pnpm storage:init
pnpm test:storage
pnpm test:integration
docker compose ps
docker stats --no-stream dramaflow-rustfs-1
```

`test:storage` 在真实 RustFS 中创建随机测试桶，验证平台 StorageService 二进制读写、MIME、匿名读取拒绝、旧本地文件读取和配置缺失报错，然后删除自己的测试数据。不会读取或清理业务桶。`test:integration` 使用独立 dramaflow_test 数据库、Redis DB1 和 dramaflow-test 桶，覆盖 HTTP 资产及模型产物存储。

容器持久化验证：上传独立测试文件，记录对象引用；执行 `docker compose up -d --force-recreate --wait rustfs`，核对相同引用读取的 SHA-256 后清理测试对象。此操作会短暂中断 RustFS，勿在运行中的生产任务期间执行。

备份需同时包含 PostgreSQL、RustFS 对象及模型凭证加密主密钥。可使用 S3 工具把私有桶复制到独立备份存储；不要依赖运行中直接复制底层卷获得一致快照。定期验证在另一环境恢复后，资产引用能与对象一一对应。

官方参考：[Docker 部署](https://docs.rustfs.com/en/installation/container/docker)。
