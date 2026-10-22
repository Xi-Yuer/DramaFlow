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

媒体和资料使用可校验引用，不把二进制或服务器本地路径写入定义。静态兼容不代替真实值校验，类型规则见数据模型。

最后一个节点的输出不是 Workflow Output。输出显式声明 name、type，以及来源 nodeId 和 outputKey。来源必须存在且类型兼容。WorkflowRun.outputs 只按声明名称收集；缺失输出不能用空值或其他节点结果补齐。

## 版本

发布校验并冻结完整定义，不修改草稿 revision，不调用模型。保存草稿和发布都携带 expectedRevision。过期保存返回 WORKFLOW_REVISION_CONFLICT。同一 workflowId 与 sourceRevision 只能发布一次，重复请求返回 WORKFLOW_REVISION_ALREADY_PUBLISHED。失败不写版本、不消耗版本号。

运行只能绑定明确的 WorkflowVersion，不能在执行中读取草稿或“最新版”。密钥不进入定义或版本。能力后来失效时明确失败，不能自动换插件。

## 运行

状态为 pending、running、waiting、completed、failed、cancelled。合法转换：pending → running；running → waiting / completed / failed / cancelled；waiting → running / cancelled。waiting 恢复后若失败，必须先回到 running。终态不再更新。首次进入 running 写 startedAt，恢复不改它；终态写 completedAt。

threadId 必填，独立于 Run.id，不能在缺失时推断为相等。同一版本可以多次运行，彼此隔离，不回写定义。inputs / outputs 是 RuntimeValue；error 只保留 stage、可选 code 和 message。

提交只保存 pending 与 start 意图，或在 waiting 周期创建恢复意图，不 claim。恢复只接受 Run ID 和不透明 value，版本与 thread 取原运行。非 waiting 返回 WORKFLOW_RUN_NOT_WAITING。waiting 是业务投影；暂停和恢复使用 LangGraph interrupt / Command.resume，不另建状态机。

## 图与组合

Data Edge 声明值来源，Control Edge 声明显式先后；创建前者不自动补后者。目标数据端口至多一条 Data Edge，且不能与静态绑定并存。数组不表示多连接聚合。控制边不占输入，可以有多个控制上游。两类边合并后必须无环。普通确定性上游按节点对去重后 ALL Join，见 [Runtime](runtime-architecture.md#普通确定性依赖的-all-join)。命名控制端口、条件和分支尚未实现。

后续可以把另一个项目的固定 WorkflowVersion 当作子流程调用。调用关系随调用方版本固定，不允许用子流程递归绕过无环约束，也不能隐式访问其他项目。父子运行、等待和取消尚未实现。
