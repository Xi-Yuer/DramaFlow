# 工作流领域与执行适配器

`catalog` 和 `validation` 子路径可以供浏览器使用。根入口还导出 LangGraph 运行时，仅供服务端宿主加载。节点配置、执行连线和输入绑定使用 `@dramaflow/contracts`，不持久化 React Flow 的内部运行对象。

## 静态依赖与条件激活

`validateWorkflow` 检查节点版本、配置、端口、插件能力以及执行边与数据引用的联合依赖环。执行连线负责激活，绑定负责传值；数据引用本身不会激活节点。

编译器为每个节点生成一个包装器，对其全部控制与数据依赖生成唯一一条数组形式的 AND barrier。判断节点记录选中出口，未选中分支的包装器继续执行并产生 `skipped`，但不会解析业务必需输入、调用插件或暂停审核。这样所有静态依赖都会完成，汇合节点不会等待一个永远未被调度的分支。此处的“一次”是逻辑激活，不是外部调用 exactly-once。

激活节点若读取必需的 skipped 输入，会产生结构化失败。`optional` 可以省略缺值；`merge.mode=selected` 是显式条件合流，要求恰好一个可用候选。业务失败使后继 `blocked`，独立分支可以完成。Output 是收集并透传节点，可继续接下游；内部 finalizer 等待所有静态叶子完成后结束运行。

## 宿主职责

`RuntimeHost` 负责操作幂等、凭证解密、ContextBuilder、插件调用、资产存储、节点记录、人工任务和取消检查。每次模型请求使用稳定的 `runId:attemptId:nodeId:itemId` 操作标识。恢复继续同一标识；主动重生成必须使用新 run 或 attempt。插件只接收明确构造的需求与绑定输入，无法访问全部运行状态。

生产必须注入 PostgreSQL 等持久化 checkpointer。`invoke` 首次开始，`recover` 从现有检查点恢复，`resume` 以准确的 interrupt ID 回复人工任务。宿主应串行驱动同一运行，人工响应持久化后再唤醒 worker；`createHumanTask` 和 `recordNodeResult` 必须幂等。LangGraph 的部分并行恢复可能保留已完成兄弟任务的旧 interrupt 元数据，适配器按 snapshot.next 过滤，避免重新创建已回复任务。

## 批量边界

Batch 对一个有界输入数组执行文本或图片能力，是单个父图逻辑节点。内部 per-invocation 子图用 `Send` 扇出，以条目索引构建稳定操作 ID，限制并发并按原顺序收集。空数组直接进入收集节点。条目只接收自己的 `item` 和节点配置，不接收兄弟条目的数据或全图状态。

崩溃恢复复用宿主已有操作结果；主动重生成 Batch 创建新 attempt，并重新生成整批。当前不提供任意循环、任意嵌套用户子图、单个历史条目替换后自动继续其下游。

## 验证

`pnpm --filter @dramaflow/workflow test` 覆盖分支跳过、数据引用不激活、混合类型 Output 及其后继、多个并行人工任务、跨实例恢复、崩溃窗口幂等、空批量和批量并发限制。测试宿主仅存在于 test 目录，不作为生产兜底。
