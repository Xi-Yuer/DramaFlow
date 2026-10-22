# Workflow 协议

流程身份、静态定义、输入输出契约、不可变版本和运行边界。节点内部见 [Node](node-model.md)，值与引用见 [数据模型](data-model.md)，执行见 [Runtime](runtime-architecture.md)，已实现接口见 [架构](architecture.md)。

```text
Workflow（身份、元数据、draft）
  └── WorkflowDefinition（inputs / nodes / edges / outputs）
        └── publish → WorkflowVersion（不可变快照，不执行）
              └── execute → WorkflowRun（绑定该版本的一次运行）
```

一个项目当前编辑其默认逻辑 Workflow。Workflow 身份不永久等于项目身份。Canvas 只是编辑视图。

edges 是节点间连接的唯一来源。Node.inputs 只保存 constant、workflow_input、asset，不保存连线。布局在 ui.position，不决定执行语义；React Flow 的临时交互状态不进入定义。

三套编号不能混用：Project.revision 管名称和视口，Workflow.revision 管草稿，发布 version 管不可变快照。项目名称与工作流名称独立。

## 输入与输出

运行输入以所选版本的契约为准，不依赖某种 Start Node。名称在输入、输出和来源键中唯一，须以英文字母开头，只含字母、数字、下划线，并拒绝原型保留名。

每个 Workflow Input 声明 name、type 和 required。required=true 表示调用应提供该 key，false 允许缺失；旧定义省略 required 时读取为 true，解析后的新定义显式保存该字段，不回写已有不可变版本。nullable 由 DataType union 表达，只允许显式 null，不等于允许 key 缺失。没有默认值，reference 的存在性规则与 inline 相同。Workflow Output 不含 required。

发布时，required 来源可绑定类型兼容的必填或可选节点输入；optional 来源只能绑定 Manifest 与实际输入 Schema 均允许省略的节点输入，否则报 INPUT_SOURCE_OPTIONAL。TemplateBinding 的 workflow_input 变量必须 required 且类型可赋给 string，optional 不自动替换为空文本。

WorkflowInvocationContractValidator 是独立的领域调用契约校验器。它按固定版本检查 required missing、未知参数、RuntimeValue.type 到声明类型的兼容性，再检查 inline 实际内容。optional missing 保持缺失，null / false / 0 / 空字符串不视为 missing，不应用默认值。Run Submission 加载并核对版本后调用它，通过后才创建 Run / Outbox；其他调用入口可复用同一校验器。

inline 内容同时检查运行值标签类型和 Workflow 声明类型，递归规则复用 DataTypeRegistry。named 类型必须注册真实 Schema；未注册时明确报 WORKFLOW_INVOCATION_TYPE_SCHEMA_UNAVAILABLE，不猜测结构或静默放行，包含该类型的复合 Schema 也采取相同规则。reference 只做类型兼容性检查，不查询资源、鉴权、读取内容或要求 named Schema。这些资源检查仍由执行时 Resolver 承担，Template 对 inline string 的消费限制也不在调用契约校验中处理。

媒体和资料使用可校验引用，不把二进制或服务器本地路径写入定义。静态兼容不代替真实值校验，类型规则见数据模型。

最后一个节点的输出不是 Workflow Output。输出显式声明 name、type，以及来源 nodeId 和 outputKey。来源必须存在且类型兼容。WorkflowRun.outputs 只按声明名称收集；缺失输出不能用空值或其他节点结果补齐。

## Start invocation 身份

invocationKey 标识调用方的一次逻辑 Workflow 调用，与 WorkflowRun 一同持久保存，并由数据库 UNIQUE(workflowId, invocationKey) 约束。不同 Workflow 可复用同名 key；版本不参与唯一作用域。同一次调用的网络重试复用 key，明确再次运行使用新 key。key 不自动生成、不设 TTL，Run 进入任何终态仍占用它。

公共 Submission 先加载固定版本并校验 invocation contract，再调用 Repository 原子创建或读取唯一约束的胜者。新建时 Run 与 start Outbox 同事务提交；复用时不创建第二条记录。等价性由领域层比较 workflowId、workflowVersionId 和完整 RuntimeValue inputs：递归对象键顺序无关，数组顺序、缺失键与 null、type、inline value 及 reference 描述均参与比较；不读取引用内容。差异抛 WORKFLOW_INVOCATION_CONFLICT，HTTP 映射 409；等价则返回原 Run，不要求其仍为 pending，不重跑终态。

Repository 只处理持久化与唯一竞争，不判断领域等价性。invocationKey 随 Run 身份不可改写；历史 Run 迁移时补独立 legacy key，不合并历史调用，也不为新请求保留数据库默认值。Agent、SubWorkflow、Batch 等未来调用方直接复用公共 Submission 的 key 语义。

## 版本

发布校验并冻结完整定义，不修改草稿 revision，不调用模型。保存草稿和发布都携带 expectedRevision。过期保存返回 WORKFLOW_REVISION_CONFLICT。同一 workflowId 与 sourceRevision 只能发布一次，重复请求返回 WORKFLOW_REVISION_ALREADY_PUBLISHED。失败不写版本、不消耗版本号。

运行只能绑定明确的 WorkflowVersion，不能在执行中读取草稿或“最新版”。密钥不进入定义或版本。能力后来失效时明确失败，不能自动换插件。

## 运行

状态为 pending、running、waiting、completed、failed、cancelled。合法转换：pending → running；running → waiting / completed / failed / cancelled；waiting → running / cancelled。waiting 恢复后若失败，必须先回到 running。终态不再更新。首次进入 running 写 startedAt，恢复不改它；终态写 completedAt。

threadId 必填，独立于 Run.id，不能在缺失时推断为相等。同一版本可以多次运行，彼此隔离，不回写定义。inputs / outputs 是 RuntimeValue；error 只保留 stage、可选 code 和 message。

提交只保存 pending 与 start 意图，或在 waiting 周期创建恢复意图，不 claim。恢复只接受 Run ID 和不透明 value，版本与 thread 取原运行。非 waiting 返回 WORKFLOW_RUN_NOT_WAITING。waiting 是业务投影；暂停和恢复使用 LangGraph interrupt / Command.resume，不另建状态机。

## 图与组合

Data Edge 声明值来源，Control Edge 声明显式先后；创建前者不自动补后者。目标数据端口至多一条 Data Edge，且不能与静态绑定并存。数组不表示多连接聚合。控制边不占输入，可以有多个控制上游。两类边与 template 的 node_output 引用合并后必须无环。普通确定性上游按节点对去重后 ALL Join，见 [Runtime](runtime-architecture.md#普通确定性依赖的-all-join)。命名控制端口、条件和分支尚未实现。

后续可以把另一个项目的固定 WorkflowVersion 当作子流程调用。调用关系随调用方版本固定，不允许用子流程递归绕过无环约束，也不能隐式访问其他项目。父子运行、等待和取消尚未实现。
