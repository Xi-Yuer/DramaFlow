# 分步设计与实施方案

本文管理从平台边界到领域生产能力的设计顺序。顶层结论见 [平台核心模型](platform-model.md)，Workflow 层见 [Workflow 模型](workflow-model.md)，Node 层见 [Node 模型](node-model.md)，已实现能力见 [当前架构](architecture.md)。设计记录不代表功能交付。

## 当前阶段

2026-10-21：A3 / A4 已完成，实际能力见[当前架构](architecture.md#web-项目模型设置)。本轮完成 L2.1 Provider 出站 No-Redirect 验证，[128 个实测案例及调用链](../experiments/litellm-l2-1/README.md)确认 LiteLLM 1.104.5 的 301/302/303 产生第二个 GET、307/308 重发 POST，且 Anthropic x-api-key 跨 hostname、端口及 HTTPS downgrade 保留。正式 OpenAI session 注入仅修复 OpenAI；普通代理、CONNECT、HTTPX transport 切换均未解决双协议问题。结论仍为 **NO-GO**，L3 阻塞。正式 Runtime、Provider / Model Configuration、A4、部署和数据库均未修改。

**本轮停在 L2.1，不进入 L3～L9 或 A6～A10，不继续修补 LiteLLM。** 下一步需先选择并单独授权替代路线的固定版本准入 spike；[比较与建议](../experiments/litellm-l2-1/README.md#no-go-后的替代路线)优先考虑统一 TypeScript SDK 的公开 fetch 控制点，保留独立 Gateway 时另评估 Bifrost。L7 egress 是有额外安全边界和维护成本的架构选项，尚未验收，不能把普通 forward proxy 当作解决方案。Secret / 配置所有权与既有 Run 状态继续保留。

本文件是当前阶段、下一步与待决策项的唯一维护入口；推进时原地修订，不堆叠旧计划或逐轮交付流水。文档维护方式见 [开发指南](development.md#文档维护)。

## LiteLLM 集成任务拆解

L1 已完成，L2 / L2.1 已完成验证但准入未通过；L3～L9 暂停在准入边界，仍待单独授权。下表保留 LiteLLM 路线的依赖，不表示已决定增加代理或更换技术栈。配置所有权继续由 DramaFlow 持有，每步独立验证，路线图不构成整批实施许可。

| 任务                                       | 依赖                    | 最小交付                                                                                                                                 | 独立验收                                                                                                                                                   |
| ------------------------------------------ | ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| L1 固定版本 Gateway 可行性验证（已完成）   | 无                      | 固定镜像、独立实验与脱敏结果见[实验入口](../experiments/litellm-l1/README.md)                                                            | 实际结果和覆盖边界见[结果文件](../experiments/litellm-l1/result.json)；未调用收费模型                                                                      |
| L2 Secret 与故障协议验证（已验证，NO-GO）  | L1                      | [调用协议](litellm-call-protocol.md)、[独立实验与结果](../experiments/litellm-l2/README.md)                                              | 常规故障为 0 / 1 次；307 两协议均为 2 次，须先解决此准入阻塞                                                                                               |
| L2.1 Provider No-Redirect（已验证，NO-GO） | L2                      | [正式控制点、跨 origin / TLS 与代理对照](../experiments/litellm-l2-1/README.md)                                                          | 128 个案例；仅 OpenAI session 可阻止该路径跳转，Anthropic 仍重发并泄漏 x-api-key，不能进入 L3                                                              |
| L3 独立服务部署                            | L1、L2                  | Compose Gateway、独立环境变量及服务 Secret、只读配置、路由访问限制、固定镜像和无生成副作用健康检查                                       | 冷启动、重启、服务认证失败、网关停机验证；无宿主公开端口、无 DramaFlow DB / 加密主密钥注入；原 PostgreSQL / Redis / RustFS 默认端口不变                    |
| L4 接入档案与 Schema 解析                  | L1                      | 扩展受信任 Plugin 的配置描述；同插件多 Provider 档案、稳定 providerType、按配置解析凭证 / settings；复用现有业务表与不可变绑定           | 创建、轮换、模型创建、availability、发布、invoke 的 Schema 一致；跨项目隔离、未知字段拒绝；旧 `openai_compatible@1` 目录与验证不变；不依赖在线网关读取     |
| L5 LiteLLM 文本插件                        | L2、L3、L4              | 新增并注册 `litellm@1` 的 `text.generate`；双层认证、确定路由、标准参数映射、安全输出 / 错误、独立 deadline；继续使用 LangChain 模型抽象 | 正式插件经真实 Gateway 转换至少两种不同上游协议测试服务；参数不静默丢失、拒绝 / 截断 / 空输出明确失败；无直接 Provider 自动兜底                            |
| L6 正式运行链验收                          | L5                      | 复用 HTTP → 发布 → Outbox → BullMQ → 独立 Worker 的集成夹具；如需持久诊断，只增加受控错误摘要并单独测试                                  | 核验 NodeRun attempt、Run / Outbox 终态；停用 / 坏密文 / 跨项目不调用；Worker 在外部受理后退出不重跑；已有 completed 只补记；各记录和 checkpoint 无 Secret |
| L7 A4 接入体验调整                         | L4、L5、L6              | “接入方式”展示真实 Provider 档案，复用当前模型设置、扁平 Schema 表单与凭证组件；内部保留插件精确版本                                     | 浏览器真实 API 验证新增、刷新、多模型 / 同名不同参数、轮换、启停、旧实例展示；不暴露 Gateway 配置，不触发生成或模型发现，不丢画布未保存内容                |
| L8 受控接入与上线验证                      | L3～L7                  | 操作者明确选择厂商、凭证和模型后做最小真实调用；记录每种已验证渠道与限制；提供新建绑定、旧配置保留和部署回退说明                         | 至少验证选定渠道的真实文本输出与不泄密；没有凭证的渠道标注未验证。切换仅作用于明确新建的配置和新发布版本，不改历史绑定                                     |
| L9 可选 metadata 增强                      | L4、L7；不阻塞 L8 或 A6 | 从固定版本提取受控 Provider / 模型参考快照，补充建议和参数提示；按凭证远程发现若仍需要，另拆专项                                         | 目录 / 已配置 / 实际访问三者分开；缺失 metadata 可手填且不假报支持；升级不改已有绑定；`/v1/models` 不冒充当前用户权限列表                                  |

L1 已验证无 DB 认证、按请求 credential / endpoint、越界 endpoint 拒绝及无默认厂商凭证；任意未知参数的完整 allowlist 仍待后续验证，不能将 LiteLLM 视作 DramaFlow 的输入校验替代。API Key 之外的 Bedrock 临时凭证、Azure / Vertex 特定认证，只开放已验证档案；工作负载身份或 OAuth 刷新若需要新增生命周期管理，另行拆解，不并入 L4 的普通表单扩展。

如固定版本不满足上述要求，应先交付缺口证据并修订评估，不默认为网关永久存储全部用户凭证。L9 不含 A6、Variable / Context Selector 或自动模型探测；媒体、Agent、Human Review、Asset、Batch / SubWorkflow 和动态插件安装仍不在本次授权范围。

## 设计顺序

| 顺序 | 议题                                      | 本步需要回答的问题                               | 状态                                      |
| ---- | ----------------------------------------- | ------------------------------------------------ | ----------------------------------------- |
| ①    | 平台是什么                                | 平台定位、一级概念、领域层与执行底座             | 已记录顶层决策                            |
| ②    | Workflow 工作流模型                       | 静态定义、版本、输入输出及 WorkflowRun           | 已确定边界并实施基础库                    |
| ③    | Node 节点模型                             | Manifest、服务端实现、实例、端口、版本与编译边界 | 已实施基础设施与目录接入                  |
| ④    | State / 数据流模型                        | 单次状态、绑定求值、结果传递与并行隔离           | 普通 Action 增量与 outputs reducer 已明确 |
| ⑤    | Runtime 执行模型                          | LangGraph 编译与服务接入、持久化、恢复及事件投影 | 执行基础设施及 Artifact 内容通道已接入    |
| ⑥    | Tool 工具体系                             | 可调用操作、调用契约、权限及 Node / Agent 关系   | 待逐步设计                                |
| ⑦    | Plugin 外部能力体系                       | 能力声明、模型、凭证、版本与供应商适配           | 文本能力与受信任静态插件边界已实施        |
| ⑧    | Middleware 中间件体系                     | 日志、权限、成本、重试的介入边界                 | 待逐步设计                                |
| ⑨    | Human Review / Interrupt 人工介入         | 暂停、确认、恢复与生成副作用边界                 | 待逐步设计                                |
| ⑩    | Asset 资产体系                            | 生产资料、媒体引用、版本、归属与生命周期         | 待逐步设计                                |
| ⑪    | Batch / Parallel / SubWorkflow 长任务体系 | 显式批量、并行、结果收集及子流程生命周期         | 待逐步设计                                |
| ⑫    | Agent 智能体体系                          | 模型、工具、上下文与人工确认边界                 | 待逐步设计                                |
| ⑬    | 漫剧领域节点与模板                        | 在已确定底座上表达漫剧生产与领域资料             | 待逐步设计                                |
| ⑭    | 广告 / 产品 / 口播等扩展                  | 复用底座并补充领域节点和模板                     | 待逐步设计                                |

这是设计顺序，不要求逐个建设相互脱离的子系统；已经明确且能独立验证的内容同步落到代码。外部生成涉及的 Plugin、Asset、凭证和安全策略不能用占位实现跨过。后续路线不构成一次性实施授权。

Workflow 的可组合性与固定被调用版本原则已在 [Workflow 模型](workflow-model.md#workflow-组合与-subworkflow-边界) 确定。第 ⑪ 步继续细化父子运行与批量生命周期，不授权任意循环、递归调用或项目下多个独立画布 / 工作流。

## 待确定：恢复与生产运行接入

WorkflowRun 记录整次运行，NodeRun 记录节点历史，Checkpoint 负责原生图恢复。以下议题留待单独明确，不构成本轮实施范围：

1. 如何观测与核查 recovery_required，以及如何处理记录状态与 Checkpoint 不一致的基础设施故障？
2. 运行删除与 checkpoint 的保留 / 清理策略如何定义？
3. interaction 节点如何定义 waiting 并在 resume 时复用同一 NodeRun、不增加 attempt？

不提前实现 Retry、Human Review、Control Node 或完整生成流程。普通 Action 禁止主动 interrupt；原生控制异常保持穿透，已有 NodeRun 保持 running。Human Review 阶段再引入 NodeRun.waiting，明确 resume 复用同一 NodeRun、不增加 attempt；本轮不恢复关联，不靠 reducer 静默覆盖已有有效输出。

## 从设计进入代码

每一步记录职责、关系、失败边界、已决策项与待决策项；明确且能独立验证的部分随设计实施，不等待用户再次要求。未确定部分保留边界，不用占位实现冒充可用能力。

1. 对照现有代码和官方资料核实技术事实，明确当轮改变的行为与验收条件。
2. 在现有应用与包中实现必要契约和适配，不为概念清单预建框架或提前拆包。
3. 接口、执行语义或数据库改变时同步更新文档和必要行为测试；数据变更遵守 [协作规范](../AGENTS.md)，只在必要时重置本项目开发数据。
4. 执行相关检查，交付时区分已实现、已验证、未验证和待设计。缺少真实模型凭证时如实记录，不用测试适配器替代生产能力。

启动与检查入口见 [开发指南](development.md)。后续每步以真实新增能力更新架构和阶段，不把整张路线图当作开发授权。
