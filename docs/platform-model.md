# 平台核心模型：① 平台是什么

本文记录重新建模的第一步：确定平台定位、一级概念及职责边界。它是后续设计的约束，不是已交付功能清单。当前代码能力见 [当前架构](architecture.md)，后续顺序见 [分步设计与实施方案](implementation-plan.md)。

## 平台定位

**DramaFlow 是面向 AI 视频内容生产的可编排工作流平台，以漫剧生产为核心场景，同时支持广告、产品宣传、口播等视频生产流程。**

产品围绕内容创作、素材预览、人工确认和长任务生产组织体验。漫剧提供首个深入落地的领域场景，工作流底座为不同视频生产流程提供共同能力。

平台面向团队自部署。首期规划支持 DAG、条件、并行、显式批量、人工确认及多结果收集；任意循环、公开 SaaS、商业计费、长期记忆和知识库仍不在首期范围内。成本记录用于生产过程的观察与控制，不意味着引入商业计费。

## 一级概念

下表定义职责，不规定数据库表、协议字段或类继承关系。

| 概念               | 职责                                                 | 边界                                                              |
| ------------------ | ---------------------------------------------------- | ----------------------------------------------------------------- |
| Project            | 一个内容创作项目，提供创作归属与管理边界             | 当前按所有者隔离；一个项目恰好一张画布，未来对应一个逻辑 Workflow |
| Canvas             | 使用 React Flow 的工作流可视化编辑视图               | 平移、缩放等编辑状态不决定执行语义；React Flow 类型留在前端适配层 |
| Workflow           | 管理流程身份、元数据及可编辑草稿                     | 草稿内容是静态 WorkflowDefinition，不包含一次运行的状态           |
| WorkflowDefinition | 描述节点、连接方式及整个流程的输入输出               | 包含 inputs、nodes、edges、outputs；不包含运行数据                |
| WorkflowVersion    | 发布后的完整定义快照                                 | 输入输出契约与图一起冻结，发布不触发执行                          |
| Node               | Workflow 中最小的可调度执行单元                      | Input → Execute → Output；不读取上下游、不自行调度整个工作流      |
| Node Preset        | 同一 Runtime 类型下的场景配置与有效契约选择          | 业务名称不直接等同于新 Runtime 类型，不复制相近业务执行器         |
| Edge               | Workflow 中的数据来源与显式执行先后关系              | 连接只保存在 Workflow.edges；Node.inputs 只保存非连线输入         |
| State              | 一次 WorkflowRun 的运行状态                          | 不成为跨项目共享状态、工作流定义或自动收集全部聊天的容器          |
| Runtime            | LangGraph 执行编译后的图，推进 State 并支持恢复      | 平台提供领域 DSL 与编译适配，不自建调度器或领域专用调度分支       |
| Capability         | 描述节点所需的能力类别，例如图像生成                 | 表达能力需求，不指定厂商；具体协议随 Node、Plugin 阶段设计        |
| Tool               | Node / Agent 可调用的操作                            | 本身不自动成为画布节点或独立的工作流调度单位                      |
| Plugin             | 接入外部模型、API 或平台能力的受信任适配单元         | 声明能力及配置；外部生成能力通过明确选择的插件、模型与凭证调用    |
| Middleware         | 执行过程的横切策略，如日志、权限、成本和受约束的重试 | 不定义领域生产步骤，也不替代入口鉴权、运行调度或节点业务          |
| Asset              | 可引用、可复用的生产资料及产物                       | 覆盖图片、音频、视频及角色等资料；二进制对象与领域元数据区分      |
| WorkflowRun        | Workflow 的一次实际运行                              | 绑定明确的不可变版本，承载本次 State、执行记录和产物引用          |
| Agent              | 在约束下使用模型、Tool 与上下文完成任务的能力        | 具体模型待第 ⑫ 步设计，不赋予隐式修改工作流或继续执行的权限       |
| Domain Template    | 漫剧、广告、产品、口播等场景的流程模板               | 组合通用底座与领域节点；不把专用流程写进 Runtime                  |

WorkflowDefinition、WorkflowVersion 与 WorkflowRun 的详细关系集中在 [Workflow 模型](workflow-model.md)，节点、有效类型契约和 Preset 集中在 [Node 模型](node-model.md)，技术栈与编译关系集中在 [Runtime 架构](runtime-architecture.md) 维护；本表只保留一级职责摘要。

## 核心职责分工

**Workflow 描述“怎么生产”，Node 描述“做什么”，Tool 描述“可以做什么操作”，Plugin 描述“外部能力由谁提供”，LangGraph Runtime 负责“怎么执行”。**

Capability 补充描述“需要哪一类能力”；Middleware 在调用边界应用横切策略；State 记录本次运行的推进情况；Asset 提供可持续引用的生产资料和结果。

这些概念不是一条必须逐级包含的树。Middleware 可以覆盖多种执行操作，Tool 可以是本地操作或使用插件提供的外部能力，插件也可以直接通过 SDK 或 HTTP 客户端访问供应商。普通 HTTP 客户端属于实现细节，不会因此自动变成供 Node / Agent 调用的平台 Tool。

### 项目、画布与工作流

```text
Project（创作归属与管理）
    └── 一张 Canvas（编辑视图）
            └── 一个逻辑 Workflow（未来的生产定义）
                    └── 多次 WorkflowRun（各自绑定不可变版本）
```

Project、Canvas、Workflow 的职责不同，不据此新增“项目 → 多画布 → 多工作流”的层级，也不要求它们使用相同标识或拆成独立数据表。实现现状统一见 [当前架构](architecture.md)。

现有 `revision` 只用于项目保存的并发检查，不能直接等同于不可变工作流版本。版本结构与输入输出契约见 [Workflow 模型](workflow-model.md)。流程组合引用另一个项目的固定版本，不改变每个项目一个逻辑 Workflow 的边界。

### 定义、运行与资料

Workflow 定义与 WorkflowRun / State 分离，草稿修改不能改变已有运行。State 以单次运行为边界；跨运行复用生产资料通过显式 Asset 引用表达，不能靠复用可变运行状态实现。

Workflow.edges 是节点间连接的唯一来源：Data Edge 声明输入值来源，Control Edge 声明显式执行先后，创建数据连接不自动补控制边。Node.inputs 只保存固定值、Workflow Input 与 Asset 等非连线输入。两类关系合并后必须无环；数据输入端口至多接收一条 Data Edge，数组值不隐含多连接聚合。Control Edge 不占用输入值，可有多个控制上游；普通节点对已确定的多个执行上游固定采用 [ALL Join](runtime-architecture.md#普通确定性依赖的-all-join)，条件候选分支不适用。Binding 运行求值、两类边的依赖分析及生产调度尚未接入。

所有新素材对象写入 RustFS，通过 S3 接口访问，不静默回退本地文件，存储实施说明见 [RustFS 存储](object-storage.md)。资产的领域元数据、版本、权限及生命周期在第 ⑩ 步设计。角色等生产资料不能简单等同于一张图片；其描述与媒体关联留到资产和领域模型阶段确定。

### 能力、工具与插件

节点声明所需能力，执行前必须校验用户选择的插件是否提供该能力，以及模型、参数、凭证与权限是否有效。缺少插件或配置时明确显示不可用，不能隐藏默认厂商或自动替换插件。

Tool 让一个操作可被 Node / Agent 调用；Plugin 对外部供应商做适配。两者可以协作，但不是固定的上下级：本地资料处理可使用本地 Tool，图像生成可通过 Capability 绑定插件。需要作为画布步骤编排的操作由 Node 承载，Tool 本身不负责激活下游。

插件声明能力、参数、版本及异步任务支持情况。浏览器只读取安全的插件声明，服务端适配器和密钥不进入客户端。此处只确定职责，不提前选择插件注册、工具注册或依赖注入方案。

### 执行、中间件与人工操作

React Flow 是可视化编辑器，平台保存自己的 WorkflowDefinition，经 Workflow Compiler、NodeRegistry / NodeCompilationStrategy 与 Edge Compiler 转换为 LangGraph StateGraph。LangGraph 是核心 Graph Runtime，负责图调度、State 更新、Checkpoint、Interrupt / Resume、Send 和条件路由；平台负责领域契约、Binding 适配、权限与业务记录。普通 NodeType 只 execute 自身业务，统一 NodeExecutor 负责输入输出管线与 State 更新，编译策略负责结构包装。

LangChain 提供模型、Tool、Agent、Message、Runnable 等抽象，外部能力仍经受信任 Plugin 适配。队列与 worker 承担长异步作业、跨运行和供应商配额控制及唤醒；Middleware 在相应边界应用策略。技术职责、恢复及并发边界统一见 [Runtime 架构](runtime-architecture.md)，不另建调度器。

重试必须区分可安全重试的操作与可能收费的生成副作用。供应商受理结果不明时记录 `outcome_unknown`，不能由通用重试中间件盲目重发。崩溃恢复与用户主动重生成分离，不承诺外部调用 exactly-once。

### 上下文与建议应用

ContextBuilder 承担独立的上下文构建服务职责，节点会话与当前工作流的全局会话隔离。只引入明确选择或绑定的上下文，不能把全部 State 和聊天自动加入提示词。原始聊天完整保存，摘要是派生数据；每次调用记录来源版本、预算和裁剪原因。

节点和全局对话只提出建议，建议自身携带基础工作流版本。用户确认应用时重新检查权限、Schema、版本与幂等性；人工审核、生成、运行和继续下游分别需要明确操作，不能因应用建议而自动触发生成或运行。Agent 同样遵守这些边界。

当前没有 ContextBuilder、业务对话、摘要或建议应用实现；以上是后续设计约束。资源权限与密钥规则集中见 [认证与安全边界](authentication.md#业务权限与密钥边界)。

## 一个概念示例：生成角色图

以下示例用于解释边界，不代表对应功能已经实现，也未指定实际供应商。

```text
Workflow：角色设定 → 角色图片生成 → 人工审核 → 分镜生成

Workflow Compiler 将“角色图片生成”Node 编译为 LangGraph 节点
    ↓
LangGraph 为本次 WorkflowRun 调度该节点
    ↓
Middleware 应用相应的日志、权限、成本等策略
    ↓
Node 执行器请求 ImageGeneration Capability
    ↓
使用用户明确配置的 Plugin / Model / Credential
    ↓
Plugin 通过供应商 SDK 或 HTTP 客户端访问外部服务
    ↓
Node 返回自身结果
    ↓
平台适配层校验输出并保存 Image Asset 元数据，LangGraph 应用 State 更新
```

如果此步骤需要可复用操作，可以调用 Tool。该示例不要求每次插件调用必须经过 Tool，也不允许 Tool 绕过插件直接提供外部生成能力。人工审核是后续独立步骤，不因图片生成成功而自动确认。

## 领域层与底座

漫剧、广告和口播分别由领域节点、资料结构与模板表达，例如：

- 漫剧：小说 → 剧集规划 → 人工确认 → 分集生产 → 剧本与分镜 → 素材生成 → 配音与合成。
- 广告 / 产品宣传：商品信息 → 卖点与创意 → 脚本与分镜 → 素材生成 → 配音与合成。
- 口播：主题 / 文档 → 内容提炼 → 口播稿 → 人工审核 → TTS / 数字人 → 字幕与合成。

这些是场景示意，不构成节点目录或实施承诺。图执行交给 LangGraph；“角色”“剧集”“商品卖点”等语义由领域层表达。

允许视频生产的 Node、Tool、Schema 和 Asset Type 专业化，例如图生视频、首尾帧生成、拼接、裁剪、音视频合成、字幕和抽帧。它们可以有专用输入输出与执行语义，不必强行合成万能节点；生成能力通过 Capability 和用户明确选择的 Plugin 接入，避免与单一厂商绑定。整体保持 Runtime 通用、视频领域 Capability 专业化、上层模板场景化，分层细节见 [Node 模型](node-model.md#视频领域能力与厂商边界)。

```text
Video Creation Platform
= LangGraph Runtime + Workflow Compiler + Node System
+ Tool System + Plugin System + Middleware System
+ Asset System + AI / Agent + Domain Templates
```

Workflow 与 Node 构成编排骨架，其余体系围绕它们服务。逻辑职责不等于独立应用、独立服务或独立 npm 包；继续采用模块化单体与独立 worker，按真实实施需求拆分。

## 设计范围与后续衔接

本文维护平台定位、概念职责、单项目单画布单逻辑工作流、定义与运行分离，以及领域层与执行底座的边界。仓库目录的承载关系见 [当前架构](architecture.md)，不为尚未确定的概念批量建立空包。

详细模型见 [Workflow 模型](workflow-model.md) 与 [Node 模型](node-model.md)，其余模型按 [分步设计与实施方案](implementation-plan.md) 逐层展开；当前阶段、下一步与待决策项只在该方案中维护。平台边界随已确认的新决策原地修订，不保留相互矛盾的旧结论。
