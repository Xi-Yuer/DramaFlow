# C1：DramaFlow TypeScript AI Compatibility 方案确认

**GO，限本轮方案确认。** 推荐使用 Vercel AI SDK 的直接 Provider packages，作为现有受信任文本 Capability 实现内部的兼容依赖。真实 SDK 对 OpenAI / Anthropic 两种本地协议服务均完成 normal / 307 / 308 验证，每次只有一次 fetch、一次生成 POST，redirect target 为零。没有接入正式 Runtime，没有修改生产依赖、数据库、Workflow 或 UI。

证据见 [result.json](result.json)、[固定依赖](package-lock.json)和[源码核查](source-audit.json)。当前阶段与下一步仅维护在[实施方案](../../docs/implementation-plan.md#当前阶段)。LiteLLM / Bifrost 实验及文档保留，本轮不恢复 Gateway 路线，也不寻找其他独立 Gateway。

## 固定版本

2026-10-21 从 npm 官方 registry 核实的稳定版本，没有安装 beta、浮动版本或默认 latest：

| 包 / 运行时              | 固定版本 | 本轮用途                       |
| ------------------------ | -------- | ------------------------------ |
| `ai`                     | 7.0.148  | 统一 generateText              |
| `@ai-sdk/openai`         | 4.0.99   | 实际 adapter spike             |
| `@ai-sdk/anthropic`      | 4.0.85   | 实际 adapter spike             |
| `@ai-sdk/provider`       | 4.0.31   | 实际传递依赖，LanguageModel V4 |
| `@ai-sdk/provider-utils` | 5.0.65   | 实际 fetch / retry helper      |
| `zod`                    | 4.6.7    | 实验边界校验，与现有仓库一致   |
| Node                     | 24.22.0  | 与项目 Node 24 LTS 目标一致    |

安装隔离在本目录，未加入 pnpm workspace 或修改根 lockfile。`package-lock.json` 固定全部传递依赖及 integrity；[versions.lock.json](versions.lock.json)记录 registry 元数据。`@ai-sdk/openai-compatible@3.0.75`、DeepSeek `3.0.70`、Google `4.0.102` 只作正式能力调查，未安装或执行第三条 adapter。

本机默认 Node 是 22，实验实际使用单独下载、按官方 SHA-256 校验的 Node 24.22.0；版本与来源见 [runtime.lock.json](runtime.lock.json)。它只是本地测试运行时，不增加生产服务。SDK 包要求 Node >=22，与 Node 24 相容。

## SDK Provider 模型与调用边界

`createOpenAI({apiKey, baseURL, fetch})`、`createAnthropic({apiKey, baseURL, fetch})` 都是正式 Provider 实例工厂。API Key 属于实例配置，不是 generateText 顶层的跨 Provider apiKey 参数。按当前 invocation 创建轻量实例，并显式传入当前 Provider Instance 解密后的 credential，就能实现 BYOK；不改 process.env、不使用默认单例、不建立 SDK 用户配置数据库。

本次调用复用真实 `CapabilityInvocationContext` 的 TypeScript 类型；configuration、credentials、model、settings、signal 的形状无需改变。测试用六套合成 credential 作为本次实例凭证，oracle 对比实际认证头 fingerprint；未读取业务 DB 或真实密钥，也没有再次验证既有 AES/AAD 实现。

OpenAI 必须区分 API：本轮使用 `createOpenAI(options).chat(model)`，明确调用 Chat Completions；该固定版本默认 `provider(model)` 是 Responses。Anthropic 使用 `.messages(model)`。二者都把模型对象传给 generateText，不能复制官方首页的字符串 `model: "provider/model"` 示例：该字符串默认走 Vercel Gateway。

`ai` 的传递依赖包含 `@ai-sdk/gateway` 客户端包；本方案不使用它，不需要 Vercel Gateway 服务、账号、平台 key 或任何独立 Gateway。两种 Provider 包直接通过 provider-utils 调用注入 fetch，没有再套 OpenAI / Anthropic 官方 SDK 的重试层。

DeepSeek 的正式 `createDeepSeek` 和 Google 的正式 `createGoogle` 同样提供 apiKey / baseURL / fetch。Google v4 当前工厂名为 createGoogle，不能照搬旧版 createGoogleGenerativeAI 示例。这里只确认接口，没有宣称其他 Provider 已通过 DramaFlow 验收。

Provider-specific 参数通过 `providerOptions` 的命名空间表达，不能把所有厂商原始参数直接合并进 ModelConfiguration.settings。未来仍由 DramaFlow Schema 验证允许项，再作有限映射；SDK 返回不支持参数的 warnings 也不能静默忽略。

结构化输出已有统一 `generateText({output: Output.object({schema})})`，tool calling 有统一 tools / toolChoice 抽象，但功能取决于具体 Provider / model。它们本轮只作调查，不实施 Agent、工具循环或结构化节点，也不推断所有模型都支持。

## 六个实测案例

本地两个 HTTP server：source 提供真实协议响应及 307 / 308，target 是能够接收生成请求的独立 origin。SDK 只使用正式 fetch 注入口，包装器在最后覆盖 `redirect: 'manual'` 并调用 Node 原生 fetch；没有修改全局 fetch、私有 API、SDK 安装包或 transport。

URL allowlist 只检查 SDK 传入 fetch 的首次 URL；native fetch 自己跟随 Location 时不会再次经过该检查。因此 target 收到零次请求是 no-follow 的实测证据，不是靠 stub 拦截第二跳伪造结果。

| Provider / status | SDK fetch 次数 | source POST | target 请求 | 返回                     |
| ----------------- | -------------- | ----------- | ----------- | ------------------------ |
| OpenAI / 200      | 1              | 1           | 0           | 预期文本                 |
| OpenAI / 307      | 1              | 1           | 0           | APICallError，status=307 |
| OpenAI / 308      | 1              | 1           | 0           | APICallError，status=308 |
| Anthropic / 200   | 1              | 1           | 0           | 预期文本                 |
| Anthropic / 307   | 1              | 1           | 0           | APICallError，status=307 |
| Anthropic / 308   | 1              | 1           | 0           | APICallError，status=308 |

Oracle 在读取完整 body 后记录 fingerprint、路径、model、参数、body hash 和身份匹配布尔值，不记录密钥原文或完整 prompt：

- OpenAI 走 `/v1/chat/completions`，Authorization Bearer；Anthropic 走 `/v1/messages`，x-api-key 与 anthropic-version `2023-06-01`。
- 两条路径均收到本次明确选择的 model、maxOutputTokens=16 的厂商字段、temperature=0.2，以及正确的 system / user 输入，未启用 streaming。
- 307 / 308 的 Location 指向另一个本地端口；target 未收到 credential 或 body，因为没有第二跳请求。

这不是只测两个 OpenAI-compatible endpoint，也没有调用真实收费模型。fixture 的自定义 baseURL 只用于本地测试；普通用户的官方 Provider endpoint 仍应由平台预设。

## Retry 与错误边界

SDK 默认 maxRetries=2，必须显式设置 0。固定源码 prepareRetries 接受 0；provider-utils 在第一次错误后检查 maxRetries===0 并立即抛出，不再次执行生成函数。两种 doGenerate 都单次调用 postJsonToApi，该 helper 单次调用注入 fetch。固定源码与本次六个计数未发现不可关闭的 SDK 隐式 generation retry。

本轮没有完整 fault matrix，因此不把此结论推广为所有 Provider / 网络故障都已验证。没有工具、repair callback、自动切换或 fallback；显式 `isStepCount(1)` 限定文本调用。未来开启工具循环意味着可以有多轮生成，是另一个受控能力问题，不能以 maxRetries=0 宣称它永远只调用一次模型。

原始 APICallError 仍可能包含 URL、requestBodyValues、headers 等。实验只保存固定错误类型和数字 status，成功只返回校验后的 `{text}`；没有新增 observability 专项。示例显式关闭 telemetry、原始请求 / 响应收集，不能把 SDK 原始对象直接写入 NodeRun / WorkflowRun / API / 日志。正式集成仍需遵守现有安全错误与 outcome 协议；3xx 不能证明 Provider 未受理，不自动再次生成。

SDK 使用 statusCode，而当前 externalCapabilityError 只读取 status。后续文本实现必须在内部将其投影为现有 CapabilityError 的安全字段，不能直接抛原始 SDK error 并期待 Registry 自动保留分类。这是实现内的有限映射，不要求改 Run 领域模型。

## 结合当前代码的架构建议

推荐选择现有扩展点：**packages/plugins 内的文本 Capability compatibility implementation**。SDK 是它的普通依赖，不成为名称为 vercel_ai 的业务 Plugin；packages/server 继续负责权限、解密和装配。不能在 server 或 Workflow 旁另建一条绕过 Registry 的 SDK 调用链。

| 现有实现                                                                                         | 复用方式                                                                                                         |
| ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| [ProviderCapability.invoke](../../packages/plugins/src/provider-plugin.ts)                       | 内部使用 SDK，接收现有 invocation context，输出现有 text.generate 协议                                           |
| [PluginRegistry](../../packages/plugins/src/plugin-registry.ts)                                  | 保留版本绑定、配置 / credential / settings / 输入输出验证及安全错误边界                                          |
| [WorkflowCapabilitiesFactory](../../packages/server/src/models/workflow-capabilities.factory.ts) | 现有按 Run / project 授权、读取 ModelConfiguration、解密 credential 后交给 Registry 的流程不变                   |
| [ProviderPluginModule](../../packages/server/src/models/provider-plugin.module.ts)               | 仍是构建期受信任实现的注册点，不将 SDK 型号暴露为业务身份                                                        |
| [ModelProvider / ModelConfiguration](../../packages/database/prisma/schema.prisma)               | 继续保存固定插件版本、configuration JSON、encryptedCredentials、capability、model、settings，无第二份业务表      |
| [文本 Node](../../packages/workflow/src/node/text-generation.ts)                                 | 仍仅保存 modelConfigurationId 并调用 text.generate；不保存 SDK model、factory、Provider 实例或 vendor package 名 |

一个受信任文本实现可以内部选择多个 SDK Provider factory；这只是声明式选择与参数映射，不是 DramaFlow 自写各厂商 HTTP / 响应 Adapter。不原地更换旧 `openai_compatible@1` 的行为；正式切换应遵守现有实现版本与不可变绑定规则，本轮没有创建或注册新版本。

Provider Catalog 的最小建议是扩展**现有目录的只读预设投影**，不要创建第二套 Provider 注册系统或 ProviderDefinition 数据库。概念字段可为：

```ts
type ProviderPreset = {
  id: string; // 官方厂商身份，例如 openai、anthropic
  name: string;
  pluginId: string; // 稳定的能力实现身份，不是第三方 SDK 名
  pluginVersion: number;
  capabilities: readonly string[];
  configurationDefaults: Record<string, unknown>; // 含平台预设 endpoint / provider 选择
};
```

configSchema、credentialsSchema、modelSettingsSchema、capabilities 优先复用 Plugin / capability 已有定义；需要厂商差异时，由同一受信任实现里的静态描述生成或验证，不维护两份彼此独立的 Schema。createAdapter / SDK factory 是内部可执行绑定，不属于产品 DTO 或领域实体。

普通用户只提供 BYOK 和该厂商确需的少量字段；创建 Provider Instance 时，把选定预设的厂商身份与 endpoint 快照物化进已有 configuration JSON。ModelConfiguration 继续关联 Provider Instance，Workflow 的 modelConfigurationId 不变。当前 A4 的目录一条 Plugin 对一条条目；未来同 Plugin 多预设需要小幅调整目录投影，不能声称现有 UI 已支持，也不在 C1 实施。

**不需要新增持久领域抽象、SDK ID、Run 状态或数据库同步。** 只需要后续静态 Provider 预设描述与现有目录投影的有限扩展。Provider ≠ Plugin ≠ Capability ≠ NodeType，SDK 也不取代 Plugin System。

现有参考插件确实使用 LangChain ChatOpenAICompletions，AGENTS.md 也记录 LangChain 模型抽象约定。本建议会改变文本 Provider compatibility 的具体实现选择；本轮用户明确要求评估替代方案，因此记录该影响，未修改正式实现或协作约定。后续实施时应同步限定该约定，不为包一层 LangChain 而增加重复模型适配；LangGraph 图执行以及 Tool / Agent 选择不由 C1 改变。

## Custom OpenAI-Compatible 与工程复杂度

官方 `@ai-sdk/openai-compatible` 已提供 `createOpenAICompatible({name, apiKey, baseURL, fetch})`，自然适合作为单独高级路径。这里是正式能力调查，不是第三条 adapter spike；结构化输出、工具等仍取决于该自定义服务。现有直接兼容插件可继续独立存在。

与独立 Gateway 相比，调用可缩为 Worker → 受信任 Capability implementation → SDK Provider → 实际厂商。没有额外网络 hop、Gateway 平台认证、服务健康 / 重启 / DB、用户配置同步及第二份 Secret 传递边界。仍需维护 SDK 升级、Provider 预设、Schema、deadline 和安全投影；它减少兼容和部署工作，不消除平台边界责任。

本轮只验证 text/LLM。其他 Capability 按自身需要选 native Plugin / HTTP / async adapter，不设计万能 Adapter，不以本次 GO 授权媒体或其他节点。

## 复现与验证范围

需要 Node 24 和仓库开发工具，直接运行定向命令，不通过会读取项目 .env 的 task.mjs：

```sh
npm ci --prefix experiments/ai-sdk-c1 --ignore-scripts --no-audit --no-fund
pnpm exec tsc --project experiments/ai-sdk-c1/tsconfig.json
pnpm exec eslint experiments/ai-sdk-c1/*.ts
node experiments/ai-sdk-c1/run.ts
```

退出 0 表示本次六个验收全部通过。新结果写入 `.local/ai-sdk-c1/<batch>/result.json`，不会覆盖提交的证据；HTTP server 结束后关闭。本轮通过严格 TypeScript、ESLint、Prettier、六个真实 SDK 案例、版本 / fixture hash 及文档链接检查。

没有测试 RPS、资源、其他故障矩阵、模型发现、其他 Provider 实跑、完整 Catalog、A4 / A6、视频、生产 Queue / Run 链或真实收费模型。GO 仅确认此兼容实现方向适合现有领域边界，不表示生产接入已完成。
