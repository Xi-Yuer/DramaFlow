# 开发指南

按 README 初始化环境，根任务自动加载根目录 .env。前端端口 3000，API 3001；直接启动单个应用时需自行传入环境变量，不复制秘密文件。

当前保留登录、账户中心、项目创建、所有者隔离、游标分页及 React Flow 空白画布；画布只保存名称、视口与 revision。节点 UI、连线、工作流定义、编排逻辑和模型插件实现已清除，等待用户重新规划。开始新模块前确认本轮具体范围，不自动恢复旧业务。

共享包通过 dist 暴露；根 Turbo 任务先构建依赖。前后端业务目录保留 .gitkeep，加入实际文件后可删除该占位文件。空包入口只标识预留结构，不可当作可用功能。

修改基础服务后运行相关 typecheck、lint、build；需要真实基础设施时运行 pnpm test:storage 或 pnpm test:integration。没有测试的空业务包不设置虚假的通过测试任务。

数据库模型在 packages/database/prisma/schema.prisma 定义。当前保留独立身份表、资料表与基础项目表。本轮通过新增迁移移除项目的 definition/nodeCount 及 plugin_installation 表，保留现有项目名称、视口、revision 和身份数据；无需整体重置数据库或数据卷。执行前核对 DATABASE_URL 仅指向本项目开发库，再运行 pnpm db:migrate。具体范围见 [部署与数据库](deployment.md)。

开发环境允许按需要重建数据，但不能把此授权用于其他项目或生产环境。新增迁移时审查 SQL，并同步文档；不要为已删除的开发业务增加历史协议兼容层。

认证相关开发先阅读 authentication.md。新增业务 API 默认受 AuthGuard 保护，公开接口需显式 Public；修改角色、停用或会话逻辑后执行隔离数据库集成测试。

项目接口或保存协议变更后，执行 pnpm check 和 pnpm test:integration，重点验证名称/视口边界、所有者隔离、分页、revision 冲突及旧节点/插件字段被拒绝；浏览器检查登录、新建项目、名称和视口保存、重新加载及账户中心。节点、模型调用和任务执行不在当前验证范围内。
