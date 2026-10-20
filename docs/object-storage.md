# RustFS 对象存储基础

统一采用 RustFS 官方固定版本 rustfs/rustfs:1.0.1，使用私有 S3 桶。Compose 配置数据卷、日志卷和健康检查；没有附带监控服务。当前单节点无数据冗余，需要独立备份。

pnpm env:init 为新环境生成随机凭证，已有环境只补齐缺少的存储变量；pnpm infra:up 启动后使用官方 AWS SDK 幂等创建桶。初始化发生权限或网络错误时直接失败。

- S3 API：http://localhost:9000
- 控制台：http://localhost:9001/rustfs/console/
- 登录凭证：本机 .env 的 S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY
- 本机应用端点：http://localhost:9000；Docker 内部：http://rustfs:9000

`packages/server/src/storage/storage.service.ts` 提供 ping、put、get、head、delete 和 signedGetUrl 基础操作，不包含素材业务、权限或版本化逻辑，不提供本地存储回退。StorageModule 在 API / Worker 各应用中共享同一个服务与连接。

signedGetUrl 使用 AWS SDK v3 官方 presigner，访问权限有效 900 秒。S3_ACCESS_ENDPOINT 可显式设置访问方能够到达的 S3 地址；未设置时使用 S3_ENDPOINT，Compose 默认仍为内部地址 http://rustfs:9000。需要供容器外的客户端或供应商访问时，部署者须设置可达地址并配置对应 HTTPS 代理，不能生成签名后再替换 URL 的 host。签名 URL 仅返回业务资源，不保存为 Artifact 身份，不写入 State / NodeRun 快照或日志。[官方签名接口](https://docs.aws.amazon.com/AWSJavaScriptSDK/v3/latest/Package/-aws-sdk-s3-request-presigner/)。

Artifact 的生产读写在 packages/server/src/artifacts：PostgreSQL 保存来源、类型、JSON / blob 编码、私有 storageKey、大小及 SHA-256；实际内容写入 RustFS。JSON 解析校验大小与摘要，二进制解析先 HEAD 确认对象和元数据，再返回临时 MediaResource。媒体输出使用业务 BinaryContent `{ bytes: Uint8Array, mimeType }`；不自动抓取任意远端 URL。当前写入使用内存字节与单次 PUT，未实现大文件流式 / multipart 上传。

写入先登记 writing，PUT 成功后确认 ready，只有 ready 可解析。PUT 失败补偿删除专属 key，并记录 failed / cleanupRequired；补偿或失败记录不可用时，异常保留全部原因。数据库确认失败可能已提交，保留 writing 或真实 ready 记录及对象，不返回引用，也不盲删对象。进程中途退出保留 writing 和 key 供核对；尚无自动对账或垃圾回收。删除业务元数据不会自动清理对象，正式删除与保留策略仍需独立设计。

pnpm test:storage 使用真实 RustFS 随机测试桶验证二进制一致性、MIME、HEAD / 删除、15 分钟签名访问、对象缺失、匿名访问拒绝及配置缺失报错，结束后清理自己的测试对象。pnpm test:integration 中的 artifacts.e2e-spec 另验证真实 PostgreSQL、RustFS 与跨进程 checkpoint 的组合，仅清理自建对象，不清空业务桶。

不要通过删除 Docker 卷处理普通故障。备份可使用 S3 工具复制到独立存储，再在另一环境验证恢复。

官方文档：https://docs.rustfs.com/en/installation/container/docker
