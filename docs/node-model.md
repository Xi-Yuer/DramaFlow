# Node 模型：③ 可调度执行单元

**Node 是 Workflow 中最小的可调度执行单元。** 它可以使用模型、领域能力、工具或控制逻辑，不等同于一次 AI 调用。本文承接 [Workflow 模型](workflow-model.md)，维护 Node 的当前边界；实现范围见 [当前架构](architecture.md#node-基础库)，阶段与下一步见 [实施方案](implementation-plan.md)。

## 统一原则

```text
WorkflowDefinition：NodeDefinition + Edge + InputBinding
                            │
                 Runtime 负责激活与组装输入
                            ▼
                     Input → Execute → Output
                            │
                 WorkflowRun 下的 NodeRun
```

Graph 表达关系，Runtime 组装输入，Node 执行器处理自身输入并返回自身结果。执行器不读取上游节点、整个 State、其他会话或完整图，也不调度下游。Definition 与 Run 分离；类型与 Preset 分层。

## 四个不同的对象

| 对象                 | 职责                                | 当前代码边界                                                                       |
| -------------------- | ----------------------------------- | ---------------------------------------------------------------------------------- |
| `NodeDefinition`     | 一个工作流内的静态节点实例          | 保存 id、type、name、inputs、config，以及可选 preset、position                     |
| `NodeTypeDefinition` | 执行侧有效的输入、输出、配置契约    | 显式提供三个 Zod 对象 Schema；type 标识 Runtime 类型，可选 preset 标识所选有效契约 |
| `NodePreset`         | 为某类 Runtime 节点提供场景配置     | 保存 id、type、name、description 和 config；不包含执行器                           |
| `NodeRun`            | 某次 WorkflowRun 中该节点的执行记录 | 保存输入、输出、结构化错误、时间与八种基础状态，不混入静态配置                     |

NodeDefinition 的 `config` 在序列化边界只接受 JSON 记录，随后必须通过所选类型的 `configSchema` 校验；不是把任意配置交给执行器。`position` 是编辑信息，不影响激活或节点业务语义。

当前 `NodeTypeDefinition` 持有执行侧 Zod 实例，不是浏览器 JSON 协议。输入输出对象的顶层字段声明端口；字段结构、可选性、约束与配置验证复用成熟 Schema 能力。前端安全声明、完整 DataType 和端口展示适配在相应步骤补齐，不把服务端执行器或 Schema 实例直接传给浏览器。

## InputBinding 与多上游

当前来源明确表示一个上游节点的输出键：

```ts
{
  target: 'characters',
  source: { nodeId: 'characters', outputKey: 'items' }
}
```

来源键统一使用既有 Workflow 输出协议的 `outputKey`，不同时保留 `output` 别名。一个节点可以分别把 script、characters、style 绑定到多个上游，不接收“全部上游数据”。同一 target 不接受重复绑定；多结果收集或集合值必须以明确的数组 / 对象契约表达，不能靠覆盖顺序或自动拼接猜测。

实例校验检查 target 是否属于有效输入契约；实际调用前检查已组装的输入值。上游引用存在性、输出键和类型兼容、绑定解析、就绪判定及失败传播在数据流模型中细化。缺少必填输入时调用边界拒绝执行，不隐式查询其他节点来补齐。

工作流输入、字面量、资产引用和子流程结果如何统一为来源，留到数据流步骤确定；本步不预设表达式语言或自动收集上下文。

## Edge 与绑定的关系

第一版 Edge 按完整端口映射保存：

```ts
{
  id: 'edge-script-storyboard',
  sourceNodeId: 'script',
  sourceHandle: 'text',
  targetNodeId: 'storyboard',
  targetHandle: 'script'
}
```

同一条可视化连线可以表达执行关系并携带数据映射，不要求现在拆成两套物理边结构。但两个职责仍要区分：执行关系决定是否激活，InputBinding 决定取哪个值。数据已经具备不意味着条件分支已经被选中，未选中分支仍须传播 `skipped`。

`inputBindingFromEdge` 已提供从连线提取数据映射的纯转换，不激活目标节点。Edge 和 Node.inputs 的编辑权威来源、派生与一致性检查在数据流步骤统一确定，不能长期维护两套可独立冲突的映射。当前结构校验不等于已实现完整图校验、就绪策略或调度。

## 单节点调用边界

```text
所选有效 NodeTypeDefinition
    ↓
校验已组装 inputs 与 config
    ↓
executor({ inputs, config })
    ↓
校验 outputs
    ↓
把自身结果交回 Runtime
```

`executeNode` 只接收有效契约、包含 inputs / config 的参数，以及显式传入的受信任执行函数。它拒绝额外图状态和未声明字段；输入、配置和输出必须是 JSON 对象，并分别通过对应 Schema。验证保留对象级约束，不以静默剥除字段隐藏错误。

输入和结果与调用方对象隔离，执行器修改局部值不能污染外部运行数据。执行异常直接传播，输出不合约时拒绝作为成功结果返回；不会自动重试、替换插件或从其他节点寻找替代结果。

该函数不解决图激活、绑定解析、权限、Middleware、NodeRun 持久化、状态转换、取消或恢复，也没有注册任何模型、代码、HTTP 或视频执行器。它是未来 Runtime 可调用的单节点边界，不是另一套调度框架。

## Runtime 类型与 Preset

故事、剧本、广告文案、角色设定、分镜描述和口播稿可能复用同一个 LLM Runtime 类型，通过 Prompt、输入输出约束和配置表达差异，不为每个文案场景创建新执行器。

`NodeTypeDefinition` 表示选定类型或 Preset 后的有效契约。相同 type 可以为不同 preset 提供不同输入输出 Schema，并复用同一执行机制；实例的 type / preset 必须与该有效契约匹配，不能找不到 Preset 时静默退回基础类型。

`applyNodePreset` 显式合并所选 Preset 配置与实例覆盖，再校验有效配置和目标端口。它不修改原对象、不自动执行、不选择厂商或凭证，也不是前端自动应用建议的授权。当前序列化 Preset 仅保存元数据与配置，有效 Schema 由调用方显式提供，尚无生产目录、安装或动态查找机制。

发布版本必须固定有效配置与输入输出契约，或绑定相应的不可变契约版本，不能运行时只按可变 Preset id 重新解析最新版。具体契约快照 / 版本引用协议随发布及数据模型补齐；现有内存快照函数不替代这一发布校验。

## NodeRun 与执行状态

基础状态为 `pending`、`ready`、`running`、`waiting`、`completed`、`failed`、`skipped`、`cancelled`。其中 ready 表示允许进入执行的就绪状态，不能只根据输入字段齐全就忽略控制激活；waiting 表示同一次节点执行等待外部条件，skipped 表示该路径没有执行。

当前 Schema 校验记录结构，输入输出为 JSON 记录，错误采用明确的 code / message，时间采用 ISO 字符串。不直接存原始 Error 或完整供应商响应，也不声称已经完成错误脱敏、状态机或恢复机制。实际值还须通过该节点契约，运行归属与版本关联由未来应用服务校验。

## 视频领域能力与厂商边界

允许 Node、Tool、Schema 和 Asset Type 与视频生产领域强相关，无需把所有能力压成万能节点。

| 层次           | 例子                                                   | 边界                                                                          |
| -------------- | ------------------------------------------------------ | ----------------------------------------------------------------------------- |
| 场景业务层     | 分镜生成、漫剧镜头生成、广告视频生成                   | 以业务模板、Preset 或确有独立语义的领域节点组合生产过程                       |
| 视频领域能力层 | ImageToVideo、TextToVideo、VideoCompose、TTS、Subtitle | 保留专业输入输出契约，不绑定单一厂商；是否独立成为 Runtime 类型按执行语义决定 |
| 基础设施层     | LLM、HTTP、Code、Storage、Queue                        | 提供基础机制，不定义漫剧或广告流程，也不能让 Queue 替代 LangGraph 调度        |

例如图生视频需要 ImageToVideo Capability，供应商通过用户明确配置的 Plugin 适配。抽帧、拼接、裁剪、音频混合等 Tool 可以专业化；模型生成仍遵守插件、模型和凭证显式选择的边界。

Start、End、LLM、Tool、Agent、Code、HTTP、If、Switch、Iteration、Batch、Join、HumanReview、SubWorkflow、Asset、Plugin 只是待评估候选，不是已确认的固定枚举或可用节点目录。Tool / Plugin / LLM / HTTP 的分类继续按后续职责设计判断；Iteration 仅考虑明确集合处理，不授权任意循环或递归。

目标是：**底层 Runtime 通用，视频领域 Capability 专业化，上层业务模板场景化。**
