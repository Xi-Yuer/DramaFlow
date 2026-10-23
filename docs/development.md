# 开发指南

启动见[根 README](../README.md)。根任务加载 `.env`，单独启动需自行传入；共享包从 dist 导出，Turbo 先构建依赖。按任务选读专题和相关代码，不通读 docs / experiments。

## 检查入口

| 命令                                                  | 范围                                                 |
| ----------------------------------------------------- | ---------------------------------------------------- |
| pnpm lint / typecheck / test / build                  | 全仓检查，可传 Turbo --filter                        |
| pnpm check                                            | 上述四项                                             |
| pnpm test:integration                                 | PostgreSQL / Redis / RustFS、真实 HTTP 和独立 Worker |
| pnpm test:storage                                     | RustFS 对象与签名访问                                |
| pnpm test:web:workflow / test:web:models              | 显式授权的浏览器验证                                 |
| node --test scripts/configure-model-provider.test.mjs | 模型 CLI 校验与脱敏                                  |

按变更执行相关检查；只改文档时验证格式、链接和现状一致性，无需业务测试。测试替身不能成为生产兜底。具体用例与隔离规则以 [集成入口](../scripts/integration.mjs)及测试代码为准，不在文档复制断言或执行流水。

## 测试与环境边界

集成测试使用独立 dramaflow_test、随机 dramaflow-test-* 队列前缀，应用现有迁移，只清理自建账号及其项目、模型、对象和 thread；禁止指向业务库或清空共享队列。MemorySaver 仅用于单元测试，原生 interrupt 夹具不代表 Human Review 已交付，本机协议替身不代表收费模型验收。

真实 Provider 调用只在操作者明确授权后运行 `pnpm test:ai:live`。凭证通过受保护环境提供，不写命令行、日志或文档；不会因本机已有 key 自动启用，也不自动重试。变量为 DRAMAFLOW_LIVE_AI_BASE_URL、DRAMAFLOW_LIVE_AI_MODEL、DRAMAFLOW_LIVE_AI_CREDENTIAL_ENV 及后者指向的凭证变量。该入口使用高级兼容插件，不代替普通 Provider 路径。

浏览器验证默认人工执行，只有明确要求时才运行现有 Playwright 脚本。它使用系统 Chrome、根 `.env`、本机基础设施及隔离库，在 3200 / 3201 启动服务；不与占用同一测试库或端口的检查并行。代理构建后可用 `pnpm build --filter=@dramaflow/web` 恢复常规配置。

离开保护、刷新 / 重启后的 invocation recovery、多 Tab storage event、Logout 后重新登录仍需真实浏览器人工验收；使用受控本地能力，避免重复收费。不把本机临时 Workflow、模型配置 ID 或运行内容写成仓库现状。

## 文档维护

- AGENTS.md：稳定边界和按任务阅读入口；README：启动与导航。
- architecture.md：已实现能力及入口；implementation-plan.md：当前工作与待决策。
- 专题：协议与失败边界；包 README：职责与链接。相同事实只保留一个权威位置，精确字段以代码为准。
- 原地替换过时内容，删除重复流水并修复引用。历史交给 Git；实验只保留结论、复现入口与隔离边界，不默认加载。
