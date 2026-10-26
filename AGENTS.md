# DramaFlow 协作约定

适用于整个仓库；子目录规范可补充，不能弱化本文件。沟通、界面和文档使用中文，代码标识符使用英文。

## 工作方式

- 按用户当轮范围自主推进；明确且可验证的需求同步实施，不只写设计文档。路线图不代表全部功能已获实施授权，不自动恢复旧业务或顺带重构。
- 先核对相关代码，再按需读取下表中的文档；技术事实以代码和官方资料为准。发现冲突说明具体影响，遵循用户最新明确要求。
- 当前阶段与下一步只维护在实施方案，已实现能力只维护在架构说明；不要在本文件复制阶段状态、类型字段、接口清单或实施流水。

## 稳定边界

- 产品是团队自部署的 AI 视频生产工作流平台，漫剧优先；每项目一张画布、一个逻辑 Workflow。首期范围见平台模型，不因候选清单提前建设功能。
- Workflow / Compiler / Runtime / Execution / Binding 保持业务无关；业务能力通过 Node + Plugin + Contract 扩展，宏观业务流程通过 Node + Edge + Binding + Control Node 组合表达。实施前先判断是业务节点能力还是通用编排能力，新增业务不应要求修改 Workflow Engine；完整原则见[平台边界](docs/platform-model.md#workflow-通用性与业务解耦)。
- 数据基数不等于执行基数，数组输出不自动创建多次执行。Composite 的子图调用、执行归属、Run Tree、Retry / Resume 与观测应复用通用机制；专用字段进入通用 NodeRun / Runtime 前先审查是否属于通用 Execution 概念。具体控制语义留在对应 Strategy，业务节点允许业务化，不为尚未需要的能力预建抽象。
- React Flow 负责编辑，LangGraph 负责图执行。LangChain 在需要时提供 Tool / Agent 抽象。平台实现领域协议及编译适配，不自建画布引擎、图调度器或暂停恢复状态机。
- TypeScript 严格模式，外部数据在边界校验；不用无依据的 any、@ts-ignore、关闭检查或空 catch 隐藏问题。contracts 不依赖 React Flow、NestJS、Prisma 或 LangGraph；后端保持模块化单体与独立 worker。
- API 默认认证，业务读写在服务端校验权限；密钥仅服务端加密保存，不进入客户端、导出、模型上下文或日志，不提交真实凭证及本地环境文件。
- 外部生成能力通过受信任插件执行。用户明确选择 Provider、模型和凭证，不隐藏默认厂商或静默替换。插件和内部 SDK 不是用户可见的 Provider。AI 对话只提出建议；应用配置、生成及继续执行遵守明确操作边界。
- 运行绑定不可变版本，草稿修改不影响已有运行；生成副作用与人工审核分离。受理结果不明的收费请求不盲目重试，不承诺外部调用 exactly-once。
- 使用 PostgreSQL / pgvector、Redis 与 RustFS / S3，保持默认端口。所有新素材写对象存储，不静默回退本地文件；细则按需读取存储与部署文档。PostgreSQL 表名使用 lowercase snake_case，不使用 PascalCase、camelCase，也不靠双引号保留大小写；ORM 里显式指定的表名同样遵守。

## 按任务读取

仅加载当前任务需要的文档段落，不默认通读 docs 或 experiments；接口与字段先查代码。文档内仍有效的专题约束须遵守。

| 任务                              | 入口                                                                                                                                                 |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| 确认当前阶段 / 实现范围           | [实施方案](docs/implementation-plan.md) / [当前架构](docs/architecture.md)，按需选读                                                                 |
| 产品范围、上下文与建议            | [平台模型](docs/platform-model.md)                                                                                                                   |
| Workflow / Node / 数据 / Runtime  | 按问题选择 [Workflow](docs/workflow-model.md)、[Node](docs/node-model.md)、[数据模型](docs/data-model.md) 或 [Runtime](docs/runtime-architecture.md) |
| 页面与交互                        | [前端规范](docs/frontend-ui.md)，实施前必读；复用成熟组件                                                                                            |
| 身份、权限、会话与凭证            | [认证与安全](docs/authentication.md)                                                                                                                 |
| 数据库、部署、数据重置 / 对象存储 | [部署与数据](docs/deployment.md) / [RustFS](docs/object-storage.md)                                                                                  |
| 启动命令 / 检查与文档维护         | [README](README.md) / [开发指南](docs/development.md)                                                                                                |

## 数据与交付

- 开发数据无需兼容。为当前变更可按需重置本项目开发数据及重建迁移基线，无需重复确认；先核对环境与范围，只清必要数据并记录。此授权不含生产、外部共享环境或其他项目；已被这些环境使用的迁移不得重写。具体规则见部署文档。
- 执行与改动相关的检查，测试关注行为与失败边界。只改文档时检查格式、链接与一致性；测试替身不得成为生产兜底，不用占位结果或静默降级冒充完成。
- 每轮同步更新受影响文档，原地替换过时内容，必要时合并或删除并修复链接；历史过程交给 Git。交付说明实际完成、验证结果及剩余限制，未验证的真实模型调用如实标明。
