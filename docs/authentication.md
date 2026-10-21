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

| 接口                                        | 权限/行为                                                        |
| ------------------------------------------- | ---------------------------------------------------------------- |
| GET /api/v1/health                          | 显式公开，检查 PostgreSQL、持久 Checkpointer、Redis、RustFS      |
| POST /api/auth/sign-in/email                | 同源登录；每 IP 每 60 秒最多 10 次                               |
| POST /api/auth/sign-out                     | 同源退出当前会话                                                 |
| GET /api/auth/get-session                   | 认证库会话接口；停用账号不能绕过检查                             |
| POST /api/auth/change-password              | 当前会话与旧密码；每 60 秒最多 5 次；强制撤销其他会话            |
| GET /api/v1/users/me                        | 当前用户安全资料与当前会话标识                                   |
| PATCH /api/v1/users/me                      | 仅允许 name、bio、timeZone                                       |
| GET /api/v1/users/me/sessions               | 当前用户最近 100 条未过期会话摘要                                |
| POST /api/v1/users/me/revoke-other-sessions | 撤销当前用户其他会话，保留当前设备                               |
| GET /api/v1/users                           | 仅平台管理员；最近 100 个账号的安全目录，当前没有管理 UI         |
| POST /api/v1/projects/:projectId/workflow   | 仅项目所有者可显式初始化默认 Workflow；重复初始化不改写已有内容  |
| GET /api/v1/projects/:projectId/workflow    | 仅项目所有者可读取 Workflow 与草稿；读取不隐式初始化             |
| PUT /api/v1/workflows/:workflowId/draft     | 按当前所有者与 Workflow expectedRevision 保存草稿，过期 409      |
| POST /api/v1/workflows/:workflowId/publish  | 当前项目所有者按 expectedRevision 发布，严格静态校验；不执行模型 |
| GET /api/v1/workflows/:workflowId/versions  | 当前项目所有者读取版本摘要，按版本号有界分页                     |
| GET /api/v1/workflow-versions/:versionId    | 当前项目所有者读取明确版本完整快照                               |
| POST /api/v1/workflow-runs                  | 登录后反查版本归属，仅接受版本 ID / inputs；确认入队后 202       |
| GET /api/v1/workflow-runs/:runId            | 仅运行所属项目的所有者可见，响应不包含 threadId                  |
| POST /api/v1/workflow-runs/:runId/resume    | 检查项目所有者后提交恢复意图并确认入队；同等待周期重复 409       |

NestJS 的鉴权与 Public/PlatformAdmin/Actor 装饰器在 apps/api/src/auth；用户资料服务在 users。认证 HTTP 入口通过白名单挂载；注册、管理插件、模拟登录、删除账号和未经授权的认证端点不公开。密码散列及 Cookie 处理复用认证库，不另建 JWT 系统。

Run HTTP 的资源缺失 / 无权访问统一为 404，不向其他用户泄漏 Version / Run 是否存在；请求字段严格校验，执行身份从数据库派生。完整契约与测试边界见 [Run API](architecture.md#workflow-run-http-api)。

Workflow 编辑 HTTP 同样将资源缺失与无权访问统一为 404；初始化不接受客户端指定身份，保存不接受 ownerId / projectId / 发布字段。Project 与 Workflow 的修订独立，保存草稿不发布或执行；细节见 [Workflow 编辑 API](architecture.md#workflow-编辑-http-api)。

发布在同一事务核验模型配置 / Provider 的项目归属、enabled、插件版本、能力及非秘密参数；不读取密文或探活。旧版本读取不因配置后来停用而重写或隐藏快照，执行仍重新检查配置和凭证，见[发布边界](architecture.md#workflow-发布与版本-http-api)。

## 业务权限与密钥边界

资料更新始终使用字段白名单，用户不能通过资料接口自助修改平台角色、停用状态或邮箱验证状态。所有业务读取和写入都要校验资源权限，前端隐藏按钮不能替代鉴权。当前项目按所有者隔离；将来引入工作空间后，还须检查相应成员权限，不能以平台角色替代。

模型 Provider 凭证已通过服务端 ModelProviderService 管理：凭证经 SecretsService 使用 AES-256-GCM 加密，当前项目 ownerId 作为 AAD；数据库只保存 encryptedCredentials。CREDENTIAL_ENCRYPTION_KEY 是 32 字节密钥的 64 字符十六进制表示，仅配置在服务端并与数据库备份分开保管；丢失或更换该值后，既有密文不可解密，不自动切换凭证或 Provider。

Provider 与 ModelConfiguration 按项目隔离，创建、列表、读取、启停与显式凭证轮换重新校验项目所有者。模型配置引用同项目 Provider；Worker 的 CapabilityInvoker 还会核验当前 running Run、项目 / 所有者、配置 enabled 与能力匹配，再解密调用。跨项目、跨所有者、失效配置和坏密文明确失败，不能仅凭 modelConfigurationId 使用其他项目凭证。模型配置 DTO 不返回明文或密文；Workflow / Version 只引用模型配置 UUID，NodeRun、Outbox、checkpoint 与自动 tracing 不保存 Provider 凭证。

模型配置已有按项目所有者隔离的[正式管理 HTTP](architecture.md#plugin--provider--模型配置管理-http)，CLI 继续可用；尚无凭证管理 UI 或工作空间成员权限。用户选择的供应商 API Key 只通过创建 / 轮换请求提交，永不通过读取接口回填；服务端加密主密钥仍只从服务器环境变量读取，不通过 API 或配置 JSON 提交。CLI 操作方式见 [部署说明](deployment.md#文本模型-provider-配置)。Plugin Registry 只加载随部署注册的受信任代码，现有实现没有远程安装或沙箱。允许明确配置的本地 HTTP 模型 endpoint；对外模型调用应使用 HTTPS，endpoint 不允许 userinfo、query 或 fragment。

模型管理请求拒绝原始校验 issues 回显，并对前置 JSON 解析错误脱敏；读取投影不含凭证密文，失败响应和日志不复制请求凭证。

外部调用的 SDK 日志关闭，自动 tracing 与父级 callback 隔离；LANGCHAIN_VERBOSE=true 时适配器拒绝执行。持久错误只保存安全阶段摘要，不复制供应商错误正文、cause 或 stack。外部受理结果不明时禁止盲目重试；这不构成对第三方供应商的数据保留或日志行为保证。

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
