# Execution、审核与运行观测

执行使用不可变 [WorkflowVersion](workflow.md#definitiondraft-与-version)。LangGraph 负责调度和暂停恢复，业务数据库保存平台身份、权限与执行事实。

## 身份与生命周期

| 身份               | 含义                                                       |
| ------------------ | ---------------------------------------------------------- |
| WorkflowRun        | 指定版本与输入的一次运行；独立于 LangGraph threadId        |
| NodeOccurrence     | `(workflowRunId, scopeKey, nodeId)` 唯一的一次逻辑节点执行 |
| NodeRun            | occurrence 内的正整数 attempt；不等于函数重入次数          |
| ChildExecution     | 具体父 NodeRun attempt 发起的子图调用                      |
| Outbox executionId | start / resume 命令的持久投递身份，不是 child 调用身份     |

root scope 明确为 `root`。scopeKey 是受信任上下文提供的 opaque 身份，不能用作权限凭据、解析成 item index 或替代定义路径。当前没有独立 ExecutionScope 表。

Run 生命周期为 pending → running / cancelled，running → waiting / completed / failed / cancelled，waiting → running / cancelled。首次 running 写 startedAt，resume 不改；终态写 completedAt，且不可覆盖。取消尚未开始的 Run 不伪造 startedAt。

Run 的版本、thread、invocationKey 与输入不可改写。NodeOccurrence 的身份不可变，NodeRun 的 occurrence、child、attempt 和开始时间不可变；复合外键保护项目 / Run / nodeId 一致性。NodeRun 与 ChildExecution 有 running、completed、failed、cancelled 状态，不因下游状态推导或批量覆盖。

## 提交、去重与投递

调用方在首次 POST 前生成 invocationKey；同一次请求重试复用 key，明确再次运行用新 key。唯一键为 `(workflowId, invocationKey)`，不按版本分区、不设 TTL，终态仍占用。

Submission 先校验固定版本和输入，再原子创建 / 复用 Run 与 start Outbox。比较 workflow、version 和完整 RuntimeValues：对象键顺序无关，数组顺序、缺失 / null、类型和引用身份均参与，不读取引用内容。相同请求返回原 Run；不同请求返回 WORKFLOW_INVOCATION_CONFLICT，不重跑终态。

Server Repository 以同一 workflow / key 的事务 advisory lock 串行受理，可绑定外层事务；Submission Factory 提供 `inProjectStartTransaction` 复用原有受理服务，不复制创建规则。产品来源记录与 Run / Outbox 的事务组合见[产品工作流调用来源](architecture.md#产品工作流调用来源)，通用 Run、Runner 与 Execution Tree 不理解来源业务身份。

Dispatcher 投递持久化意图，Job 不复制定义、State 或 thread。Worker 验证 Job 与 Outbox payload 一致后原子 claim；只有 claim 胜者执行。claim 前基础设施故障可以重投，业务失败不自动重跑。claim 后失联或结果不明进入 recovery_required；已完成或已进入下一 waiting 周期时只结算对应意图，不重新 invoke。

入队未确认可返回 503 和已持久化的 Run ID / key。lookup 只读取，不创建或投递；查无结果不能证明原 POST 不会稍后提交。没有 recovery_required 人工处置或自动重放入口。

## Runner、State 与 Checkpoint

executeStart claim pending，读取固定版本、编译并初始化 State。executeResume claim waiting，保留 Run / version / thread，校验原 checkpoint 身份后恢复；缺失或不一致明确失败，不新建 State 或 thread。

State 包含不可变 run / inputs、当前 outputs、显式 variables 和内部 execution.controlResults。Action 只返回当前 nodeId 的 outputs 增量；非变异 reducer 合并，重复节点输出写入报错，不静默覆盖。State 不保存服务、日志、聊天或媒体字节。

Graph 返回后核对 checkpoint 的 next / tasks、错误和 interrupt；仍有任务则 waiting，否则解析声明输出并将 completed、outputs、completedAt 一起写入业务库。Checkpoint、Run、Outbox 与对象存储之间不承诺跨存储事务。

生产显式装配官方 PostgresSaver，使用原 thread；thread_id 不是权限。运行配置不能覆盖它。Compiler 不执行 setup，也不以内存 Saver 兜底。官方 schema 的初始化和备份见[部署](deployment.md#checkpoint-与数据库)。

## 嵌套执行

归属链为 Run → 父 occurrence → 父 NodeRun attempt → ChildExecution → 子 occurrences / attempts。NodeRun.childExecutionId 在 root 为空，在子图中必须明确提供。查询通过显式外键检查 scope 一致性，不按 scopeKey 反查 child，也不按全局 nodeId 猜归属。

ChildExecution 的调用权威是 `(parentNodeRunId, invocationKey)`。Iteration 使用 kind=`iteration_item`、`iteration-item:<index>`、metadata.index，并由数据库 typed index 校验一致性；SubWorkflow 使用 kind=`subworkflow`、`subworkflow:graph`。index 不等于 attempt，其他 kind 不要求 index。

子 scope 按父 scope、owner occurrence、具体父 attempt、slot 和 index / callKey 规范编码后哈希，恢复复用同一身份。新父 attempt 不复用旧 child；get/create 原子复用 running 记录并核对 parent、scope、kind 和 metadata，终态不重新创建。

父节点、child 和子节点各自记录真实状态。业务失败按策略结束直属 child 与父 NodeRun；原生 interrupt 保持 running；仓储故障不能伪装成业务失败。Iteration 保留专属聚合与失败策略，通用持久化不要求所有 Composite 采用同一种传播政策。

Definition Location 由固定版本与 nodeId / graphKey 路径表达，与执行 scope 分离。当前没有持久化 definitionRef、多 graph slot 解析或跨版本授权；支持范围以 [Composite 准入](workflow.md#iteration-与-subworkflow)为准。单 child Retry / Resume / Cancel 不属于产品操作。

## Human Review

人工审核是 `flow.human_review@1` interaction：输入 string content，可选静态 instruction，输出原 content、action 和 feedback。approve / reject 都是正常业务决策；reject 不是执行失败，也不是控制出口。生成副作用与审核节点分离。

策略在 interrupt 前获取 / 创建 occurrence 的 attempt 1 running 审计并记录输入。原生重入比较并复用原输入，不创建新 attempt；合法决策完成同一 NodeRun 后才写 State。不承诺副作用 exactly-once。

Pending 查询在授权 Run 行锁下读取原 thread 的 head checkpoint，适配 LangGraph 的 interrupt pending write，核对 Run / version，只接受文本 HumanReviewInterrupt V1。名称来自固定版本，不读取 Draft。只公开 opaque interruptId、waitingRevision、节点名称、文本、说明和 submissionStatus；不返回 thread、task、namespace 或完整 checkpoint。

恢复协议：

```json
{
  "interruptId": "opaque-token",
  "expectedWaitingRevision": 1,
  "value": { "action": "approve", "feedback": "可选反馈" }
}
```

服务核对 waiting、当前 revision 和目标 token，再原子写唯一 resume Outbox。陈旧周期冲突；已持久化的请求显示 submitted，不能修改或重复提交，投递未确认时只查询对账。HTTP 202 不代表已经 running。

Runner 使用明确 interrupt ID map 构造原生 Command.resume，不解释业务决策。内部原生单 interrupt 调用也按 ID 恢复，保留 false / 0 / null 的值语义。产品 HTTP 不接受裸 value。多个 pending、未知 kind 或损坏 payload 明确报不支持，不伪装成审核。

当前仅支持分支区域外的串行文本审核；并行 pending、分支区域内和嵌套 Human Review 均不开放。

## Cooperative cancellation

`cancellationRequestedAt` 与 status 正交，只记录首次取消意图。取消与 claim 争用 Run 行锁；pending / waiting 可直接结束，running 只受理请求，不宣称图已经停止。已有终态不被覆盖。

持久化 gate 阻止取消后 claim、创建新执行记录或投递未开始意图，不依赖移除 Redis Job。Worker 每 250ms 串行读取意图，以同一 RunnableConfig.signal 传入 LangGraph、Executor、Capability 和插件。短暂读取失败继续观察，不伪造取消。

取消是明确控制类型，不通过错误文本判断，也不作为审核 interrupt。每个 owner 收尾自己已创建的 NodeRun / ChildExecution，保留输入、写 completedAt，不写虚构输出或业务错误；未开始节点不创建假记录，已结束 sibling 保留原事实。迟到 Promise 不得覆盖终态。审计收尾失败仍是基础设施故障。

waiting 审核取消在同一事务收尾 Review 及其显式父链、Run 和未 claim Outbox，不产生 reject / feedback。Checkpoint 保留但不能绕过 cancelled Run 继续恢复。停止本地等待不保证撤销远端请求、费用、Artifact 上传或其他副作用。

取消核查复用 Outbox Pump，每轮有限扫描。宽限时间、Job 消失、lock 失效、stalled/recovered 或 Redis 不可读都不能证明执行已经停止，只能保守进入 recovery_required。它不新增 lease / heartbeat / 调度器，不批量终结 running 审计，不自动 replay。

读取投影为 none / requested / uncertain，与 Run status 分离。终态优先，requested 只表示已受理，uncertain 表示无法确认停止；没有将失联自动收敛成 cancelled 的保证。

## History 与 Execution Tree

Run History 按 Owner / Project / Workflow 过滤，以 `(createdAt, id)` 降序游标分页。版本不可用时保留真实版本 ID，版本号为 null。摘要不返回输入输出、invocationKey、thread、Job 或 checkpoint；详细结果另由 Run 查询取得。

Execution Tree 逐层读取明确 parent：workflow_run → root NodeRuns，node_run → ChildExecutions，child_execution → 直属 NodeRuns。各层使用实际稳定 ID、cursor 与独立记录状态，不从数组输出、DAG、日志或 scope 字符串推导树。NodeRun 的不同 attempt 不合并，waiting 审核不伪造为另一种持久 NodeRun 状态。

查询校验完整 parent 链与授权范围，不修复数据，不创建执行，不递归加载整树。每页具有自身事务快照，活动树不承诺跨页冻结。界面选择和图投影见[前端](frontend.md#运行投影与执行树)。

## HTTP 入口

业务路径统一以 `/api/v1` 为前缀并认证；写请求检查 Origin。具体 DTO 以 [Run Controller](../apps/api/src/workflow/runs/workflow-runs.controller.ts)和 [Contracts](../packages/contracts/src/workflow/run/workflow-run-api.ts)为准。

| 入口                                                                 | 职责                             |
| -------------------------------------------------------------------- | -------------------------------- |
| `POST /workflow-runs`                                                | 按版本、invocationKey 和输入受理 |
| `GET /workflow-runs/:runId`                                          | 安全状态、输出与取消投影         |
| `GET /workflow-runs/by-invocation/:workflowId/:invocationKey`        | 请求身份对账                     |
| `GET /workflow-runs/:runId/node-runs`                                | 节点执行记录                     |
| `GET /workflow-runs/:runId/pending-human-reviews`                    | 待审文本与 opaque token          |
| `POST /workflow-runs/:runId/resume`                                  | 提交审核决策                     |
| `GET /workflow-runs/:runId/execution-tree`                           | 单层执行树                       |
| `GET /projects/:projectId/workflows/:workflowId/runs`                | 运行历史                         |
| `POST /projects/:projectId/workflows/:workflowId/runs/:runId/cancel` | 受理取消，返回 outcome 与 Run    |
