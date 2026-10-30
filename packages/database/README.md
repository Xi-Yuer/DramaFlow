# @dramaflow/database

当前 canonical ORM schema 位于 `prisma/schema.prisma`；Foundation v1 单一 baseline 从空库直接创建 ORM 结构与数据库级 CHECK / trigger / function。正式部署后只追加 migration。

`test/foundation-baseline.test.ts` 通过正式 Prisma deploy 在随机空数据库验证 schema、完整 catalog 与身份 / 生命周期 / 权限归属约束。入口为根 `pnpm test:migrations`，也纳入 integration；默认单元测试不连接数据库。

初始化、开发重置与 Checkpointer 边界见[部署与数据](../../docs/deployment.md)。
