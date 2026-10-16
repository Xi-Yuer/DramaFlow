# API 与权限边界

业务前缀 `/api/v1`，Better Auth 使用 `/api/auth`。前端同源代理，浏览器使用 HttpOnly 会话 cookie。集合响应为 `{ items: [...] }`，失败响应包含 `code`、`message` 和可选细节。

| 入口                                                   | 行为                             |
| ------------------------------------------------------ | -------------------------------- |
| `/workspaces`                                          | 当前用户可访问的空间             |
| `/workspaces/:id/workflows`                            | 列出或创建工作流                 |
| `/workflows/:id`                                       | 读取/保存草稿，保存携带 revision |
| `/workflows/:id/validate`、`/publish`、`/versions`     | 校验、发布、不可变历史           |
| `/node-catalog`                                        | 系统节点目录与配置 Schema        |
| `/workspaces/:id/plugins`、`/connections`              | 插件启用与安全连接元数据         |
| `/workflows/:id/runs`                                  | 创建/查询运行，创建携带幂等键    |
| `/runs/:id`、`/events`、`/stream`                      | 状态、持久事件、SSE              |
| `/runs/:id/tasks`、`/tasks/:id/respond`                | 人工确认任务                     |
| `/runs/:id/cancel`、`/regenerate`                      | 显式取消和重新生成               |
| `/workflows/:id/conversations`                         | 节点/全局会话                    |
| `/conversations/:id/messages`、`/context-preview`      | 消息及本次上下文预览             |
| `/conversations/:id/proposals`、`/proposals/:id/apply` | 建议与确认应用                   |
| `/workspaces/:id/assets`、`/assets/:versionId/content` | 素材版本及授权读取               |

请求 Schema 和响应类型以 `packages/contracts` 为准。输入的任意 ID 都不构成授权，服务端从资源解析工作空间并校验成员身份。修改需要编辑权限，凭证和成员管理需要管理员权限。

保存草稿与应用建议使用乐观锁。启动、审核和重生成使用幂等键；同一键不能变成不同业务请求。SSE 事件有递增序号，客户端应以服务端状态和事件序号恢复，而不是把动画状态当作运行真相。

节点输出、运行和素材均由服务端写入；浏览器不能提交一个成功状态冒充执行结果。会话建议的允许操作由白名单解析，模型不能通过任意 JSON 属性访问内部服务。
