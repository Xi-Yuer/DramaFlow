# Workflow 模型：② 静态定义、版本与运行

本文维护 Workflow 层的当前设计结论，承接 [平台核心模型](platform-model.md)。这里只确定流程的身份、静态定义、输入输出契约、不可变版本及运行边界，不设计 Node 内部执行、数据库表或 Runtime 调度实现。实现现状见 [当前架构](architecture.md)，设计进度见 [分步设计与实施方案](implementation-plan.md)。

已有代码范围见 [Workflow 基础库](architecture.md#workflow-基础库)：元数据与显式 Schema 组合、值契约校验、输出收集、只读版本快照及运行版本检查已经实现；应用接口、持久化、完整图校验及调度尚未接入。

## 核心关系

Workflow 是受管理的流程对象，保存身份、元数据及可编辑草稿；WorkflowDefinition 是静态流程定义，不包含运行状态。

```text
Workflow
    ├── Metadata
    └── draft: WorkflowDefinition
            ├── inputs
            ├── nodes
            ├── edges
            └── outputs
                    │
                    │ publish / version：校验并冻结完整定义
                    ▼
            WorkflowVersion（不可变快照）
                    │
                    │ execute：显式选择版本并提供本次输入
                    ▼
            WorkflowRun（一次实际运行）
                    └── State / NodeRun / Asset 引用 / Interrupt
```

图中的发布作用于整个 WorkflowDefinition，包含 inputs、nodes、edges、outputs，而非只冻结节点和连线。Versions 与 Runs 分别关联 Workflow，不要求作为嵌套数组随每次读取整体返回，也不据此规定数据库结构。

## Workflow 与 WorkflowDefinition

Workflow 回答“这是谁的哪一个流程、草稿是什么”；WorkflowDefinition 回答“有哪些节点、怎样连接、接受什么输入、暴露什么输出”。一个项目恰好一张 Canvas，对应一个逻辑 Workflow；Canvas 是编辑视图，不是 Runtime 的执行状态。

以下 TypeScript 表达完整概念关系。当前元数据、NodeDefinition、InputBinding、EdgeDefinition 和 Schema 组合器已经在 contracts 导出，Node 层边界见 [Node 模型](node-model.md)；最小 DataType 声明已实现，复合结构及媒体 / 领域运行值契约仍待数据流设计。调用 `createWorkflowSchemas` 时必须显式提供 DataType、Node、Edge Schema，可复用已有 Node / Edge 结构，没有任意 JSON 或空壳默认类型。

```ts
interface Workflow {
  id: string;
  projectId: string;
  name: string;
  description?: string;
  draft: WorkflowDefinition;
  createdAt: Date;
  updatedAt: Date;
}

interface WorkflowDefinition {
  inputs: WorkflowInput[];
  nodes: NodeDefinition[];
  edges: EdgeDefinition[];
  outputs: WorkflowOutput[];
}
```

Inputs 与 Outputs 只在 WorkflowDefinition 内定义，随草稿和版本分别保存；不在 Workflow 顶层再维护一份可独立修改的契约。版本、运行的关联也不改变 WorkflowDefinition 的四个组成部分。

视口、节点布局等纯编辑信息不决定执行语义，具体与定义如何分离留到编辑协议设计。现有项目名称与拟议的 Workflow 元数据名称如何呈现及持久化，也不在本步增加同步字段或修改项目保存接口。

## Inputs：工作流的显式输入契约

Workflow 是具有明确 Input Contract 的可执行单元。运行输入以该版本的契约为准，不能只依赖 Start Node 内部的几个字符串，也不要求以某种 Start Node 形式才能声明输入。

| 类别       | 需要表达的值                                    | 边界                                                                 |
| ---------- | ----------------------------------------------- | -------------------------------------------------------------------- |
| 基础值     | `text`、`number`、`boolean`                     | 提供明确的类型与约束                                                 |
| 媒体与文件 | `file`、`image`、`video`、`audio`               | 使用受管理、可校验的素材引用，不把文件二进制或服务端本地路径塞入定义 |
| 领域资料   | `asset`、`character`、`scene`，以及后续产品资料 | 明确引用或结构契约；具体领域模型在数据与资产阶段确定                 |
| 复合值     | `array`、`object`                               | 描述元素或字段类型，不能只接受无约束 JSON                            |

例如，小说转漫剧可以声明小说文件引用、目标集数、视频风格；广告流程可以声明产品资料、目标受众、时长和带枚举约束的投放平台。这些是契约需求示意，不代表已有对应领域类型或资产实现。

输入名称必须唯一，输入输出名称及来源输出键目前采用以英文字母开头的字母、数字、下划线标识，并拒绝原型相关保留属性名。启动前按所选版本的契约校验实际输入及素材访问权限，不合格的输入不能进入执行。必填、默认值、空值、复合结构与类型兼容规则随 DataType / 数据流模型细化，不在这里先建立另一套类型系统。

基础库的值契约使用显式 Zod Schema，可校验基础值与复合值，也可执行该 Schema 明确声明的可选或默认行为；这不预设未来编辑协议如何表达默认值。素材引用的具体结构和访问权限仍由资产及应用模型决定。

## Outputs：显式暴露的结果契约

**最后一个节点的输出不等于 Workflow Output。** 工作流可以同时暴露视频、封面和发布文案，也可以只暴露内部某些节点结果；节点结果是否被其他节点消费，与是否被声明为最终输出是两回事。

```ts
interface WorkflowOutput {
  name: string;
  type: DataType;
  source: {
    nodeId: string;
    outputKey: string;
  };
}
```

例如：

```text
finalVideo  ← videoCompose.output
cover       ← coverGenerator.image
publishText ← copyWriter.text
```

输出名称必须唯一，来源节点和输出键必须存在，来源类型与暴露类型必须兼容。发布校验依赖后续 Node 输出契约，运行收集结果时还要校验实际值。`WorkflowRun.outputs` 按声明的名称组织结果，不自动返回所有节点结果，也不能把任意最后完成节点的结果当成成功输出。

条件分支被跳过、可选输出、集合结果以及嵌套路径的具体规则留到 Node / 数据流与运行阶段；不能用空值或任意上游结果静默补齐缺失输出。节点接收多个上游结果的规则属于 Node / 数据流模型，不由 Workflow Output 反向决定。

## WorkflowVersion：发布后的不可变定义

```ts
interface WorkflowVersion {
  id: string;
  workflowId: string;
  version: number;
  definition: WorkflowDefinition;
  publishedAt: Date;
}
```

发布表示校验草稿并创建不可变快照，不触发生成或执行。快照包含完整输入输出契约、节点及连线；后续草稿修改只影响之后发布的版本，不能回写已发布版本或已有运行。

现有项目 `revision` 是并发保存检查值，与 WorkflowVersion 的身份和版本编号分离。发布时应校验操作者权限及其所依据的草稿修订，避免并发修改后发布了另一份定义；具体修订字段与接口在实施时确定。

发布与启动需要保证定义的结构、引用、输入输出和依赖有效；节点细节、类型兼容及图校验规则分别由后续模型补齐。安全密钥不进入定义或版本。此处的不可变性要求持久化与服务边界共同保证，不因某个 TypeScript 类型标记就视为实现完成。

运行只能绑定明确的 WorkflowVersion，不能在执行中读取草稿或动态解析“最新版”。固定定义不意味着供应商一定持续可用；能力缺失或配置失效时明确报告，不能通过自动换插件改变本次运行语义。

## WorkflowRun：一次实际运行

```ts
type RunStatus = 'pending' | 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled';

interface WorkflowRun {
  id: string;
  workflowId: string;
  workflowVersionId: string;
  status: RunStatus;
  inputs: Record<string, unknown>;
  outputs?: Record<string, unknown>;
  startedAt?: Date;
  completedAt?: Date;
}
```

`workflowVersionId` 必须属于同一个 `workflowId`，读取或启动时都必须检查对应项目权限。同一版本可以多次运行，各次输入、State、资产引用、节点执行结果、错误及等待记录相互隔离，不反写进 WorkflowDefinition。

`Record<string, unknown>` 仅表示本次输入输出值集合；实际值必须通过该版本契约校验，不能作为绕过边界验证的自由数据入口。当前基础 Schema 的时间字段采用 ISO 字符串，值契约与快照拒绝非 JSON 值；概念示例中的 `Date` 不是当前共享协议字段类型，也不规定数据库存储类型。

| 状态        | 语义                                         |
| ----------- | -------------------------------------------- |
| `pending`   | 已创建，尚未开始执行                         |
| `running`   | 正在推进执行                                 |
| `waiting`   | 等待明确的外部条件或人工操作，仍是同一次运行 |
| `completed` | 按定义完成，并形成符合输出契约的结果         |
| `failed`    | 本次运行失败                                 |
| `cancelled` | 本次运行被取消                               |

`waiting` 是等待人工审核、外部 API、子流程或批量结果等执行事实的业务投影，不能凭状态字符串驱动另一套暂停 / 恢复流程。人工介入使用 LangGraph interrupt / Command.resume；根 WorkflowRun.id 对应 thread_id，等待原因与业务记录映射随 State、持久化和长任务模型细化，技术边界见 [技术职责](runtime-architecture.md)。

恢复继续使用原 Run、thread_id 及其不可变版本，不重新选择最新版。Checkpoint 保存执行 State，不保存平台 DSL；应用必须按 Run 绑定的版本重新编译图，不能恢复最新草稿。人工确认、生成和继续下游仍须遵守明确操作边界；恢复与用户主动重生成分离，供应商受理不明时不能借恢复盲目重试。

## Workflow 组合与 SubWorkflow 边界

Workflow 的显式输入输出使它可以被其他 Workflow 作为完整单元调用，为后续 SubWorkflowNode 奠定契约基础：

```text
小说漫剧 Workflow 的固定版本
    └── Episode Batch
            └── Episode Workflow 的固定版本 × N
                    输入 Episode → 内部生产流程 → 输出 EpisodeVideo
```

在“每项目一张画布、一个逻辑 Workflow”的现有约束下，被调用 Workflow 归属它自己的项目；主流程引用另一个项目的明确 WorkflowVersion，不在当前项目下新增多工作流编辑层级。当前权限仍按项目所有者隔离，组合不能隐式获得其他项目的访问权限，也不因此引入工作空间成员实现。

调用关系随调用方版本固定，被调用流程后来发布的新版本不能改变既有运行。不能只保存一个在运行时会变化的“最新版”别名。父子 Run 的关系、输入映射、等待、取消、并行与结果收集在第 ⑪ 步设计，SubWorkflowNode 的结构随 Node 模型展开；本步不实现调用器或批量引擎。

首期保持 DAG，不允许以子流程直接或间接递归绕过无环约束。显式批量表示对明确集合的处理，不等于任意循环。

## 图拓扑与执行职责

WorkflowDefinition 通过 nodes、edges 及控制节点表达串行、并行、条件与显式批量，不另设 `parallelNodes`、`sequentialNodes` 等独立列表，也不预先建立一个包含所有控制逻辑的固定 Pipeline。

执行关系决定节点激活，数据绑定负责传值，联合依赖必须无环。平台 Workflow Compiler 将已校验关系映射到 LangGraph 的边、条件路由、fan-in、Send 与子图，由 LangGraph 执行；不另写 ready 判断、调度器、Checkpoint 或暂停恢复状态机。WorkflowDefinition 不包含运行进度、队列任务或领域专用调度分支。

本步确定静态定义与运行分离、完整契约版本化、显式输入输出、固定版本运行及流程可组合的边界。Node 编译适配见 [Node 模型](node-model.md)；DataType、State / Binding、整图编译、执行事件投影和持久化实现分别在相应步骤细化，不用占位契约将这些事项标成已完成。
