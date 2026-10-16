# RustFS 对象存储基础

统一采用 RustFS 官方固定版本 rustfs/rustfs:1.0.1，使用私有 S3 桶。Compose 配置数据卷、日志卷和健康检查；没有附带监控服务。当前单节点无数据冗余，需要独立备份。

pnpm env:init 为新环境生成随机凭证，已有环境只补齐缺少的存储变量；pnpm infra:up 启动后使用官方 AWS SDK 幂等创建桶。初始化发生权限或网络错误时直接失败。

- S3 API：http://localhost:9000
- 控制台：http://localhost:9001/rustfs/console/
- 登录凭证：本机 .env 的 S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY
- 本机应用端点：http://localhost:9000；Docker 内部：http://rustfs:9000

apps/api/src/infrastructure/storage.service.ts 仅提供 ping、put 和 get 基础操作，不包含素材业务、权限或版本化逻辑；不再提供本地存储兼容。已有对象及旧本地文件未删除。

pnpm test:storage 使用真实 RustFS 随机测试桶验证二进制一致性、MIME、对象缺失、匿名访问拒绝及配置缺失报错，结束后清理自己的测试对象。不会清空业务桶。

不要通过删除 Docker 卷处理普通故障。备份可使用 S3 工具复制到独立存储，再在另一环境验证恢复。

官方文档：https://docs.rustfs.com/en/installation/container/docker
