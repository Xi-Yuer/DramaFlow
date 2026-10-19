# @dramaflow/server

API 与 worker 共用的服务端基础设施：PostgreSQL、Redis、RustFS / S3 和凭证加密。不包含 HTTP 路由、认证或业务流程。

对象存储只提供连接探测和对象读写，素材版本与权限不在这里。凭证密文用所有者标识做附加认证数据。
