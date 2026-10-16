# DramaFlow Web

中文创作工作台，使用官方 `create-next-app@16.4.2` 生成，保留 Next.js App Router 和 Tailwind 4 的工程结构。

脚手架命令：

```bash
pnpm dlx create-next-app@latest apps/web --ts --tailwind --eslint --app --src-dir --import-alias '@/*' --use-pnpm --skip-install --yes
```

前端在 monorepo 根目录统一安装依赖。Node.js 24，执行 `pnpm --filter @dramaflow/web dev` 后打开 `http://localhost:3000`。后端默认位于 `http://127.0.0.1:3001`；通过 `API_URL`（或 `API_INTERNAL_URL`）指定代理目标，需在 Next 启动或构建时传入。所有浏览器请求使用同源 `/api/v1` 与 `/api/auth`，密钥不会写入客户端环境变量。

## 模块和状态

- `features/auth`：Better Auth 会话与登录。账户由管理员配置，不开放公开注册。
- `features/workspaces`：工作空间、工作流列表、素材版本库与页面导航。
- `features/editor`：React Flow 适配层、节点库、Schema 配置、类型化输入绑定，以及独立 Zustand 编辑器状态。撤销/重做与服务端 Query 缓存分开。
- `features/plugins`：插件启停、服务端连接创建、手动选择插件版本/模型/凭证。
- `features/runs`：运行输入、SSE 事件、人工审核、结果收集、资产预览与主动重新生成。
- `features/conversations`：工作流和节点会话、显式选择的素材与运行上下文、预算和来源预览、配置建议差异与确认应用。
- `lib/api` / `lib/api-schemas`：同源请求和外部响应校验。平台契约来自 `@dramaflow/contracts`，第三方画布类型只存在于适配层。

## 编辑与运行语义

执行线与数据线分别编辑。图的执行边和数据绑定联合进行循环检测，最终以服务端发布校验为准。模型节点填写固定需求或绑定 `prompt`；上游资料绑定 `context`，不支持模板字符串插值。

修改先保存在草稿，发布后运行固定版本。按钮不会通过聊天自动触发生成。固定 JSON 值和运行输入在编辑后点击“应用 JSON”，界面再使用已应用的数据。人工审核使用幂等标识提交；重新生成创建新运行并保留历史产物。

`viewer` 界面只读，但后端仍需独立执行所有权限检查。凭证仅在创建连接时提交，不放入工作流定义、浏览器存储或导出内容。

## 验证

```bash
pnpm --filter @dramaflow/web typecheck
pnpm --filter @dramaflow/web lint
pnpm --filter @dramaflow/web test
pnpm --filter @dramaflow/web build
```

行为测试覆盖控制/数据联合循环、自环和混合端口拒绝、独立连线转换，以及撤销/重做、节点删除引用清理和保存基线。浏览器联调需真实 API、PostgreSQL、Redis 与已初始化团队；没有模型凭证时不能把真实供应商调用标为通过。

完整开发与部署说明见根 README 和 `docs`。
