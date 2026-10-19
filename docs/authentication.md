# 用户登录、鉴权与用户字段设计

## 当前能力与边界

基于 Better Auth 1.7.10，提供邮箱密码登录、退出、保持登录、个人资料、修改密码、查看登录设备及退出其他设备。公开注册关闭；部署管理员通过 CLI 创建账号。其他业务能力与权限实施现状见 [当前架构](architecture.md)。

未接入邮件服务，暂不提供自助找回密码、邮箱验证或更换登录邮箱；没有 OAuth、短信、MFA 或账号删除入口。数据库中的对应基础字段保留供以后按需要启用，不以假按钮或固定返回值冒充功能。

## 数据为何分开

| 表                | 当前字段与用途                                                                                                          | 后续扩展原则                                                                                 |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| auth_user         | 稳定 UUID、name、规范化唯一 email、emailVerified、可选 image、role、banned、banReason、banExpires、createdAt、updatedAt | 身份与账号生命周期。role 仅为平台 admin/user，不是工作空间成员角色。头像预留，尚无上传入口   |
| user_profile      | userId 一对一、bio、locale、timeZone、创建与更新时间                                                                    | 简介及偏好。时区用于设备与加入日期显示；locale 当前默认 zh-CN，未实现界面多语言切换          |
| auth_account      | providerId、accountId、userId、密码散列及 SDK 标准可选凭证字段                                                          | 密码不在 user 表，不保存明文；未来 OAuth 应按认证库支持方式接入，不把第三方凭证塞入资料 JSON |
| auth_session      | 用户外键、唯一会话 token、期限、IP、User-Agent、创建与更新时间、SDK 所需可选字段                                        | 可撤销的设备会话。IP/UA 是辅助展示信息，不作为身份真实性凭据                                 |
| auth_verification | 标识、验证值、期限与时间字段                                                                                            | 认证库验证机制的标准结构，当前没有开放发信流程                                               |
| auth_rate_limit   | 唯一 key、count、lastRequest                                                                                            | 认证组件原子的数据库限流，不依赖单进程内存                                                   |

资料表允许尚未创建：读取时使用明确的中文/上海时区与空简介默认值，首次修改时 upsert；CLI 开通账号会建立默认资料。昵称 1—80 字符，简介最多 280 字符，时区需通过 Intl 校验。用户 ID 不使用邮箱、昵称或未来可变账号名。

不提前添加手机号、生日、积分、套餐、订单、素材计数或工作流计数。将来团队权限新增独立成员关系，业务额度/计费使用独立模型；不复用平台 role 作为项目权限，不以任意 JSON 混装所有需求。

## 一次登录与受保护访问

1. 浏览器向同源 /api/auth/sign-in/email 提交邮箱、密码与保持登录选项，Next.js 转发到 NestJS。
2. 认证入口先检查允许的 HTTP 路径与 Origin，再交给 Better Auth 处理密码校验、账号停用、限流及 Cookie。
3. 会话持久化在 PostgreSQL，使用 HttpOnly、SameSite=Lax Cookie；HTTPS 站点自动启用 Secure。勾选保持登录时期限为 7 天，不勾选使用认证库的浏览器会话 Cookie 行为。业务资料读取不隐式刷新会话。
4. 后续业务 API 由全局 AuthGuard 默认保护，通过认证库解析会话，再读取当前 user 的停用状态与角色。会话无效返回 401，账号停用或角色不足返回 403。
5. /users/me 返回显式安全 DTO；设备摘要不返回会话 token。前端使用缓存查询管理用户状态，不向 localStorage 写登录凭证。Better Auth 原生认证协议的响应由其 SDK 处理。
6. 自定义写入接口校验 Origin，资料 Schema 严格拒绝额外字段。修改密码使用认证库，并通过 before hook 在服务端强制 revokeOtherSessions=true，不能由客户端参数关闭。

认证 UI 的加载态、服务不可达、登录错误和停用情况分别处理。登录后进入项目列表，账户菜单进入个人资料与安全页。

## 接口与代码入口

| 接口                                        | 权限/行为                                                |
| ------------------------------------------- | -------------------------------------------------------- |
| GET /api/v1/health                          | 显式公开，检查 PostgreSQL、Redis、RustFS                 |
| POST /api/auth/sign-in/email                | 同源登录；每 IP 每 60 秒最多 10 次                       |
| POST /api/auth/sign-out                     | 同源退出当前会话                                         |
| GET /api/auth/get-session                   | 认证库会话接口；停用账号不能绕过检查                     |
| POST /api/auth/change-password              | 当前会话与旧密码；每 60 秒最多 5 次；强制撤销其他会话    |
| GET /api/v1/users/me                        | 当前用户安全资料与当前会话标识                           |
| PATCH /api/v1/users/me                      | 仅允许 name、bio、timeZone                               |
| GET /api/v1/users/me/sessions               | 当前用户最近 100 条未过期会话摘要                        |
| POST /api/v1/users/me/revoke-other-sessions | 撤销当前用户其他会话，保留当前设备                       |
| GET /api/v1/users                           | 仅平台管理员；最近 100 个账号的安全目录，当前没有管理 UI |

NestJS 的鉴权与 Public/PlatformAdmin/Actor 装饰器在 apps/api/src/auth；用户资料服务在 users。认证 HTTP 入口通过白名单挂载；注册、管理插件、模拟登录、删除账号和未经授权的认证端点不公开。密码散列及 Cookie 处理复用认证库，不另建 JWT 系统。

## 业务权限与密钥边界

资料更新始终使用字段白名单，用户不能通过资料接口自助修改平台角色、停用状态或邮箱验证状态。所有业务读取和写入都要校验资源权限，前端隐藏按钮不能替代鉴权。当前项目按所有者隔离；将来引入工作空间后，还须检查相应成员权限，不能以平台角色替代。

后续接入的外部服务密钥仅在服务端加密保存，不进入客户端、工作流导出、模型上下文或日志。工作空间成员与插件凭证管理当前尚未实现，本节保留后续实施约束，不表示已有这些业务能力。

## 初始化与开通账号

先按 README 执行 env:init、infra:up、db:generate、db:migrate，然后：

```sh
pnpm auth:bootstrap
```

初始管理员邮箱、名称与密码读取 .env 的 ADMIN_EMAIL / ADMIN_NAME / ADMIN_PASSWORD。重复执行保留已有密码，不自动提升既有普通账号角色；修改环境文件中的密码不会重置已有账号。

新增普通账号：在受保护的本地环境文件中临时配置 NEW_USER_EMAIL、NEW_USER_NAME、NEW_USER_PASSWORD，运行 pnpm auth:create-user，完成后移除临时密码。账号创建使用服务端 SDK，不开放 HTTP 注册；不要通过命令行参数传密码或打印秘密。

当前没有自助重置密码；遗忘密码的管理流程需要后续接入邮件或明确的管理员重置功能，不能靠反复 bootstrap 改写密码。

## 部署与维护

BETTER_AUTH_URL 和 WEB_ORIGIN 设置为浏览器实际访问的站点，例如 HTTPS 域名。保管 BETTER_AUTH_SECRET，改变它会影响现有 Cookie；不要把秘密写进 NEXT_PUBLIC_*。

仅从实际反向代理接受客户端地址：Express 默认不信任转发头，部署可通过 TRUSTED_PROXY_CIDRS 指定实际代理地址/网段。入口覆盖客户端提交的 x-real-ip，不能依赖未经验证的转发头限流。经 Next.js 或 Docker 代理且未配置可信地址时，按代理出口聚合限流。需要按客户端地址区分时，应先确保入口代理覆盖或清洗客户端提交的转发头，再按实际拓扑配置可信代理；不要填入任意客户端所在的大网段。

定期维护已过期会话、验证记录和过期限流 key，按部署的数据保留策略清理；当前未提供自动清理作业。备份数据库和认证秘密，生产上线还需在实际 HTTPS/代理环境验证 Cookie、地址解析与访问策略。

认证迁移创建 auth_* 和 user_profile 表，不清空现有数据库或 RustFS。迁移影响与数据操作方式统一见 [部署与数据库](deployment.md)。

## 验证方式

pnpm check 覆盖静态检查、类型检查、现有单元测试和构建。pnpm test:integration 使用独立 dramaflow_test 数据库：创建随机账号，测试认证、角色、资料字段白名单、来源校验、设备撤销、停用、密码变更、过期与限流，然后删除自己的测试账号。不要直接对业务库运行此测试文件。

参考：[Better Auth 数据库](https://better-auth.com/docs/concepts/database)、[限流](https://better-auth.com/docs/concepts/rate-limit)、[Hooks](https://better-auth.com/docs/concepts/hooks)。
