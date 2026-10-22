# worker

独立进程消费执行队列并运行图。与 API 共用数据库、checkpoint、Redis 和对象存储。API 只提交，Worker 才执行。

边界见 [当前架构](../../docs/architecture.md)。启动与检查见 [根 README](../../README.md)。
