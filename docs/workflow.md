# Workflow 定义、节点与编译

Workflow Foundation 保持[业务无关](architecture.md#业务解耦)。运行生命周期与 checkpoint 见[Execution](execution.md)，类型和运行值见[数据](data.md)。

## Definition、Draft 与 Version

一个项目拥有一个逻辑 Workflow。GraphDefinition 由 inputs、nodes、edges、outputs 组成；root 与局部图复用同一协议。Project.revision、Workflow.revision、发布 version 分别管理项目元数据、草稿与不可变版本。

保存与发布使用 expectedRevision；过期请求冲突。同一 workflowId / sourceRevision 只能发布一次。Publish 冻结完整快照，检查图语义、执行准入和 Owner 的能力绑定，不调用模型、不修改草稿 revision；失败不消耗版本号。运行只读取指定 WorkflowVersion，不读取 draft / latest。

输入输出名称各自唯一，节点 ID 唯一；端口名遵循 Contract 标识规则，拒绝原型保留名。

Graph Input 明确包含 name、type、required。省略与 null 分离，没有隐式默认值；false、0、空字符串均是提供了值。optional 来源只能供应允许省略的输入；模板中的 workflow_input 必须必填且可赋给 string。Submission 在创建 Run 前验证未知 key、missing、类型标签和 inline 内容，不用转换结果改写输入。

Graph Output 使用单 source，或互斥的 sources 候选列表；不直接引用 workflow_input，不自动选择最后节点。Draft 可保存零 / 单候选的修复状态，正式候选输出至少两个来源且不能重复。多来源须经简单 If 分析证明互斥与覆盖。单来源不能直接引用条件分支。

输出解析只检查声明来源在最终 State 中是否存在；候选必须恰有一个存在。零个、多个或类型不符均失败，不按优先级选择、不比较业务值、不 decode 引用。`outputs: []` 合法并产生空对象。

## Runtime NodeType、Catalog Entry 与实例

| 概念                | 身份与边界                                                                                        |
| ------------------- | ------------------------------------------------------------------------------------------------- |
| NodeType / Manifest | 精确 type + 整数 version；声明端口、配置、executionKind，服务端实现持有 Schema 与执行逻辑         |
| NodeCatalogEntry    | 独立产品 id、metadata、category、exposure、target 与纯数据 creation；多个条目可以指向同一类型版本 |
| NodeDefinition      | id、type、typeVersion、name、config、inputs、ui.position 与可选 composite；不保存 Entry 来源身份  |

Manifest 只传输 JSON，不携带 Zod、execute 或服务实例。Registry 精确匹配版本，拒绝重复、缺失或错误 executionKind，不猜测替代实现。action 提供三组严格 Schema 和 execute；control、composite、interaction 由各自策略解释。

`instantiateNodeCatalogEntry` 深复制 creation 并合并 Manifest 配置默认值，生成标准 NodeDefinition。创建后实例独立归 Draft 所有，Catalog 更新不改既有实例。Preset 只是类型内的配置合并工具，不提供第二种运行身份。

生产 Catalog 的 public 条目是文本生成、子流程、人工审批；条件分支为 advanced，Iteration 为 internal。普通 Picker 只显示 public，没有高级模式切换。Catalog 不参与 Compile / Runtime；已有节点仍按完整 Manifest 加载。测试专用 Action 不注册到生产 Registry。

## 端口、边与 Binding

Data Edge 提供值，Control Edge 限定先后，不相互补齐。业务节点之间的真实边统一保存在 edges；静态输入保存在 Node.inputs。每个输入至多一个 Data Edge 或一个静态绑定，数组不隐含多连接聚合。

静态绑定支持 constant、workflow_input、asset、template、candidate。template 使用显式变量映射引用 node_output / workflow_input，candidate 使用显式候选输出；二者的可视连线都是投影，不另存为 Data Edge。Binding 返回 RuntimeValue，不解码、不访问存储；细则见[数据](data.md#binding-与-codec)。

Data Handle 使用端口 key；默认控制 Handle 与数据 key 隔离，不写入领域 portKey。Manifest 的命名 controlOutputs 不携带 DataType；ControlEdge.source.portKey 必须引用精确 Manifest 的出口。当前不支持命名控制输入。

Data / Control / template / candidate 依赖的联合图必须无环。普通上游按节点对去重；多个上游使用一次原生 `addEdge([sources], target)` 表达 ALL join，不拆成多个独立触发。

## Compiler 与 Action Executor

[编译计划](../packages/workflow/src/compiler/graph/compilation-plan.ts)和 [compileGraph](../packages/workflow/src/compiler/graph/graph-compiler.ts)统一 root、Iteration.body 和 SubWorkflow.graph 的策略分发、依赖、START / END 与输出收口。静态 Definition Location 使用 nodeId / graphKey 路径，不包含 scope、item index 或 checkpoint namespace。

Compiler 冻结定义并检查精确版本、Schema 与能力门禁，不创建 Run / thread 或执行业务。调用方提供原生 StateGraph、reducers、执行上下文与入口 / 完成回调；共享编译器不映射父输入、不持久化审计、不安装 Saver。

Action Executor 的边界是：创建 occurrence / attempt → 解析绑定 → 记录 RuntimeValue 输入 → decode → 校验 input / config → execute → 校验 output → encode → 完成审计 → 写 State 增量。业务 execute 不读取全图、绑定、内容 Store 或 Checkpoint。

业务错误记录安全的 resolve_input、decode_input、validate_input、validate_config、execute、validate_output、encode_output 阶段。无占位输出或业务自动重试。仓储故障独立传播；完成记录失败不能反向记业务 failed。GraphInterrupt / ParentCommand 原样交回 LangGraph，不伪装业务失败。

Composite failure boundary 只委托原生执行；内部业务失败先结束直属 child 与所属父 NodeRun，再向外传播。Aggregate 中含控制流或未知错误时保守穿透；审计写失败保留原执行错误与记录错误。它不查询整树、不创建 retry 或部分结果。

## 简单 If 与直接汇聚

`flow.if@1` 是 control，输入为 string，使用 true / false 命名控制出口。If 不创建 Action NodeRun，不提供数据输出；只求值一次，结果存入内部 execution.controlResults，由原生 conditional edges 路由。

每个出口连接一个不同 Action entry。分支内允许串行、并行和 ALL join；来源只能在本 region 或 guaranteed-before 祖先中。分支 region 不交叉，不支持 nested If。未选分支不参与 END 的 ALL 等待。

直接汇聚要求同一 If 唯一共同前沿并覆盖两侧全部末端。编译器把依赖分成两个互斥 completion group：每组内部为本支依赖与全部普通必需上游的 ALL；两组为 alternatives。共同依赖不能单独触发目标。分析结果属于编译器内部，不写 Definition、State 或数据库。

candidate 输入在该边界恰有两个来源，分别来自 true / false region；来源参与依赖收集。普通 DataEdge / template 不能直接读取互斥分支值。多候选 Workflow Output 也必须来自同一 If 两侧各一个保证执行的 Action，可取不同深度；汇聚后保证执行的节点可以提供单来源输出。

无覆盖、绕行、多共同前沿、region 交叉、nested If 或不安全输入在 Publish / Compile 时拒绝。这些是当前执行能力限制，不是永久 Graph Contract 限制。

## Iteration 与 SubWorkflow

`flow.iteration@1` 显式改变执行基数。items 端口为 Array<T>，itemType 明确声明，不能从值推断；额外 invariantInputs 不得覆盖 items。Body 复用 GraphDefinition，workflow_input 指向局部输入。

bodyInputMapping 从 current_item、current_index 或已声明 iteration_input 映射到 Body 输入；目标唯一、类型兼容并覆盖必填输入。optional 不能供应 required；缺失的 optional 不补 null。Body 每个输出 U 提升为父端口 Array<U>，嵌套数组不 flatten。动态端口统一由 resolveNodePorts 解析，Manifest 的空 outputs 不代表实例没有输出。Publish 要求非空 Body、非顶层 any 的已知 itemType 与完整输入映射。

执行固定 RuntimeCollectionSnapshot，再通过原生 Send 调用 Body，按原 index 聚合输出。空集合不调用 Body、不创建 child，完成父 NodeRun 并返回类型正确的空集合。prepare、Body 入口和 collect 分别承担父审计、ChildExecution 创建和聚合，不预建虚拟执行记录。

`flow.subworkflow@1` 的 composite.graph 内嵌在当前版本，固定调用一次，不引用独立 Workflow、不创建新 Run / Job。输入输出直接由 graph 推导，同名输入建立局部边界，不另设映射协议。父子边界传递原 RuntimeValue，不解码引用，不复制父 State。

局部调用独立初始化 inputs、outputs、variables、execution。Graph Invocation 只接受明确来源和映射，验证必填、唯一目标、来源存在及类型。静态位置与执行 scope 分离；每个父 attempt 的 child 身份见[Execution](execution.md#嵌套执行)。

| 图位置            | 当前允许                                                                                     | 当前拒绝                                                                                    |
| ----------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Root              | Action、受限简单 If、分支区域外串行 Human Review、Iteration、SubWorkflow                     | 任意循环、nested If、未证明的汇聚                                                           |
| Iteration Body    | Action、精确 `flow.subworkflow@1`                                                            | Iteration、If、Human Review、其他 control / interaction / composite                         |
| SubWorkflow graph | 普通 Action DAG、parallel + ALL join、DataEdge、workflow_input、constant、Template、声明输出 | Candidate、If、Human Review、Iteration、SubWorkflow、其他 control / interaction / composite |

正式组合为 Iteration → SubWorkflow v1 → Action DAG。Draft 可保存不完整配置，但递归结构表达能力不代表 Publish / Runtime 放行。没有共享子流程、跨项目 / 跨版本调用、Item Retry、partial success 或任意递归 Composite。

## 执行预算与依赖限制

Compiler 根据实际依赖和全部潜在条件路径计算最长深度 D，通过官方 withConfig 绑定 recursionLimit。普通图上限为 D+1；带审计入口和输出收口的局部图为 D+3，Composite wrapper 上限为 4，取各原生图上限的最大值，不按 item 数或调用次数累加。预算属于单次 invocation，不是费用、节点数量或 thread 累计额度。

LangGraph.js 1.5.0 的 Iteration 在节点执行前拒绝 `maxConcurrency=1`，不静默改成其他值。技术结构分析可以递归计算更广图形，但生产执行必须通过同一能力门禁；没有用自制调度或私有兼容状态机绕过限制。

## 节点扩展

声明 Manifest、严格 input/output/config Schema 和业务 execute；在受信任 Registry 注册精确版本。产品入口另声明 Catalog Entry。发布时校验全部后代的能力与资源权限，不能只依赖 UI 控件。

`ai.text_generate@1` 输入 prompt / 可选 system，输出 text，配置仅保存 modelConfigurationId。它通过 CapabilityInvoker 调用 `text.generate`；Provider、参数、凭证与 SDK 留在[能力装配](architecture.md#provider-与能力装配)及[安全边界](security.md#业务权限与密钥边界)。
