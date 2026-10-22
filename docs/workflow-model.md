# Workflow 协议

定义与版本协议见 contracts；节点见 [Node](node-model.md)，值与引用见[数据模型](data-model.md)，执行见 [Runtime](runtime-architecture.md)，接口与 Web 能力见[架构](architecture.md)。

```text
Workflow（身份、元数据、draft）
  → publish → WorkflowVersion（完整不可变快照，不执行）
  → Start → WorkflowRun（绑定指定版本）
```

每项目一张画布、一个逻辑 Workflow。Definition 为 inputs / nodes / edges / outputs；edges 是连线的唯一来源，Node.inputs 保存 constant / workflow_input / template / asset。ui.position 只管布局，React Flow 临时状态不进入定义。Project.revision、Workflow.revision 和发布 version 分别管理项目、草稿与版本，不得混用。

## 输入与输出

inputs / outputs 各自名称唯一，节点 ID 唯一；端口名称以英文字母开头，只含字母、数字、下划线，并拒绝原型保留名。

Workflow Input 为 `{ name, type, required }`。required 缺省读取为 true，不回写已有不可变版本；false 允许省略 key，nullable 用 DataType union 表达。无默认值；null / false / 0 / 空字符串不算 missing。发布时 optional 来源只能绑定 Manifest 与实际 Schema 均允许省略的节点输入；模板中的 workflow_input 必须 required 且可赋给 string，不自动补空文本。

Submission 在创建 Run / Outbox 前调用独立 WorkflowInvocationContractValidator，按固定版本拒绝 missing、未知 key、类型标签不兼容和非法 inline 内容，不用转换 / 默认值改写输入。inline 同时检查实际标签和声明类型，named 必须注册真实 Schema；reference 只校验类型兼容，内容与授权留给执行时 Resolver。

Workflow Output 为 `{ name, type, source: { nodeId, outputKey } }`，没有 required，也不直接引用 workflow_input。Definition Schema 拒绝不存在的节点；Publish 按精确 Manifest 检查 port 和 `isTypeAssignable(port.dataType, output.type)`。最后节点不自动成为结果。

完成时按声明名称收集 RuntimeValue，缺失或类型不符失败，不能用其他结果补齐；`outputs: []` 合法并得到 `{}`。保存 Draft 的新 output 声明不会改变已发布版本或既有 Run。持久化和查询行为见 [Runtime 最终输出](runtime-architecture.md#最终输出)。

## Start invocation 身份

invocationKey 标识一次逻辑调用，由调用方在首次 POST 前生成并持有；服务端不补 key。数据库 UNIQUE(workflowId, invocationKey)，不以版本为作用域，不设 TTL，终态仍占用。相同调用的重试复用 key，明确再次运行用新 key。

公共 Submission 先校验固定版本和 inputs，再由 Repository 原子创建 Run / start Outbox 或读取唯一竞争胜者。领域层比较 workflowId、workflowVersionId 和完整 RuntimeValues：对象键顺序无关，数组顺序、缺失与 null、type、value / reference 均参与，不读取引用内容。差异为 WORKFLOW_INVOCATION_CONFLICT（409）；等价则返回原 Run，终态不重跑。

Repository 不判断等价性；运行身份与 inputs 不可改写。lookup 只找已有记录，不执行或重试。Web 持久恢复只保存身份 metadata，规则见[架构](architecture.md#web-invocation-identity-recovery)。

## 版本

保存 / 发布携带 expectedRevision，过期为 WORKFLOW_REVISION_CONFLICT。同一 workflowId / sourceRevision 只能发布一次，重复为 WORKFLOW_REVISION_ALREADY_PUBLISHED。发布冻结完整定义，不改草稿 revision，不调用模型；失败不消耗版本号。

运行只能绑定明确 WorkflowVersion，不能读 draft / latest。凭证不进定义或版本，绑定后来失效时明确失败，不自动替换插件或模型。

## 运行

状态转换为 pending → running，running → waiting / completed / failed / cancelled，waiting → running / cancelled；终态不可更新。首次进入 running 写 startedAt，恢复不改；终态写 completedAt。threadId 必填且独立于 Run.id，不从缺省值猜测。

inputs / outputs 为 RuntimeValue map，error 仅含安全 stage / 可选 code / message。提交只保存 pending 与 start 意图，恢复只建当前 waiting 周期的唯一意图；执行时 claim。resume 使用原 Run / version / thread 和不透明 value，不创建新 invocation，非 waiting 明确拒绝。

## 图与组合

Data Edge 提供值，Control Edge 提供先后，不自动互相补齐。每个数据输入至多一条 Data Edge，且不能与静态绑定并存；数组不表示多连接聚合。控制边不占输入，可有多个上游。Data / Control / Template node_output 合并后必须无环，普通上游按节点对去重后 [ALL Join](runtime-architecture.md#普通确定性依赖的-all-join)。

条件、Batch、SubWorkflow 和 Human Review 待独立任务。子流程应绑定对方固定版本，不隐式获得其他项目权限或以调用递归绕过无环约束；不据协议声明预建实现。
