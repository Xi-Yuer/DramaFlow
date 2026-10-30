# 身份、安全与凭证

基于 Better Auth 1.7.10，提供邮箱密码登录、退出、保持登录、个人资料、修改密码、查看登录设备及退出其他设备。公开注册关闭，管理员通过 CLI 创建账号。业务分层见[架构](architecture.md)。

未接入邮件服务，没有自助找回密码、邮箱验证、更换登录邮箱、OAuth、短信、MFA 或账号删除。数据库中的对应字段保留，不提供这些功能的产品入口。

## 账号数据

身份在 auth_user：稳定 UUID、昵称、规范化唯一邮箱、角色和停用状态。role 只表示平台 admin / user，不是项目或工作空间成员角色。密码散列在 auth_account，不在用户表，不保存明文。会话在 auth_session，可撤销；IP 和 User-Agent 只用于展示。user_profile 保存简介、locale 和时区，允许尚未创建：读取时使用中文、上海时区和空简介，首次修改时 upsert。

昵称 1—80 字符，简介最多 280 字符，时区须通过 Intl 校验。用户 ID 不使用邮箱或昵称。资料接口不能修改角色、停用状态或邮箱验证状态。

## 登录与受保护访问

浏览器向同源 `/api/auth/sign-in/email` 提交邮箱、密码和保持登录选项，Next.js 转发到 NestJS。入口先检查路径与 Origin，再由认证库处理密码、停用、限流和 Cookie。会话放在 PostgreSQL，使用 HttpOnly、SameSite=Lax Cookie；HTTPS 自动启用 Secure。勾选保持登录时期限为 7 天。业务读取不隐式刷新会话。

业务 API 默认由 AuthGuard 保护。会话无效返回 401，停用或角色不足返回 403。前端不把登录凭证写入 localStorage。

| 接口                                        | 行为                                                    |
| ------------------------------------------- | ------------------------------------------------------- |
| GET /api/v1/health                          | 公开。检查 PostgreSQL、Checkpointer、Redis、RustFS      |
| POST /api/auth/sign-in/email                | 同源登录。每 IP 每 60 秒最多 10 次                      |
| POST /api/auth/sign-out                     | 退出当前会话                                            |
| GET /api/auth/get-session                   | 停用账号不能绕过                                        |
| POST /api/auth/change-password              | 当前会话和旧密码。每 60 秒最多 5 次，并强制撤销其他会话 |
| GET / PATCH /api/v1/users/me                | 安全资料。只允许修改 name、bio、timeZone                |
| GET /api/v1/users/me/sessions               | 最近 100 条未过期会话摘要，不含 token                   |
| POST /api/v1/users/me/revoke-other-sessions | 保留当前设备                                            |
| GET /api/v1/users                           | 仅平台管理员，最近 100 个账号；没有管理 UI              |

注册、管理插件、模拟登录和删除账号的认证端点不公开。不另建 JWT。项目、Workflow、版本与 Run 都在服务端重新校验所有者；越权资源不因猜中 ID 而可见。运行查询与恢复见[Execution](execution.md)。

## 业务权限与密钥边界

所有业务读写在服务端校验资源权限。当前项目按所有者隔离。将来的工作空间成员关系独立建模，不能用平台 role 代替。

Provider 凭证由服务端用 AES-256-GCM 加密，Provider 所有者的用户 ID 作为 AAD，数据库只保存密文。CREDENTIAL_ENCRYPTION_KEY 是 32 字节密钥的 64 字符十六进制，只放在服务端，并与数据库备份分开保管。丢失或更换后，既有密文不可解密，不自动切换凭证或 Provider。

Workflow / Version 只引用模型配置 UUID。NodeRun、Outbox、checkpoint 和自动 tracing 不保存 Provider 凭证。读取接口不回填明文或密文；Web 不把 Secret 放入表单存储、Query 缓存、URL 或浏览器存储。模型管理、轮换和调用时的授权见 [能力装配](architecture.md#provider-与能力装配)。

Plugin Registry 只加载随部署注册的代码，没有远程安装或沙箱。已经配置的出站地址可以是明确的本地 HTTP；对外调用应使用 HTTPS。endpoint 不允许 userinfo、query 或 fragment。普通 Provider 的地址来自预设，自定义 baseURL 只属于 Custom OpenAI-Compatible。外部错误只保留安全摘要。受理结果不明时禁止盲目重试。

## 开通账号

先按 README 完成环境、基础设施和迁移，然后：

```sh
pnpm auth:bootstrap
```

初始管理员读取 `.env` 的 ADMIN_EMAIL / ADMIN_NAME / ADMIN_PASSWORD。重复执行保留已有密码，不提升既有普通账号，修改环境文件中的密码也不会重置已有账号。

新增普通账号时，在受保护的环境文件中临时配置 NEW_USER_EMAIL、NEW_USER_NAME、NEW_USER_PASSWORD，运行 `pnpm auth:create-user`，完成后移除临时密码。不要通过命令行参数传递或打印密码。没有自助重置密码，不能靠反复 bootstrap 改写密码。

## 部署注意

BETTER_AUTH_URL 和 WEB_ORIGIN 设置为浏览器实际访问的站点。BETTER_AUTH_SECRET 变化会使现有 Cookie 失效，不要写入 NEXT_PUBLIC_*。

Express 默认不信任转发头。只有实际反向代理所在地址才能写入 TRUSTED_PROXY_CIDRS；入口应覆盖客户端提交的 x-real-ip。未配置可信代理时，经 Next.js 或 Docker 的请求按代理出口聚合限流。

过期会话、验证记录和限流 key 目前没有自动清理。账号和资料表由统一 Foundation baseline 创建，数据操作见[部署](deployment.md)。集成测试使用独立 dramaflow_test，并只删除自己创建的账号。
