# 数据类型、运行值与内容引用

本文维护本轮数据模型。实际接入范围见 [当前架构](architecture.md)，下一步 Graph Model 见 [实施方案](implementation-plan.md)。

## 四个维度

| 概念          | 职责                             | 示例                                                            |
| ------------- | -------------------------------- | --------------------------------------------------------------- |
| DataType      | 端口的语义类型描述               | media.image、story.character、Shot[]                            |
| RuntimeValue  | 本次运行实际携带的值及其承载方式 | inline / reference，均附带实际 DataType                         |
| DataReference | 持久内容的身份                   | 不可变 Artifact ID、Asset ID + versionId                        |
| Domain Object | 业务数据本身的结构               | Character、Shot、Script，可内联，也可作为 Artifact / Asset 内容 |

Image 不等于 AssetReference，Character 不等于 Asset。类型描述与存储形式独立；不能用签名 URL、供应商 URL 或本地路径充当长期内容身份。

## DataType 与共享兼容规则

contracts/data 中的描述是纯 JSON：any；primitive{name:string/number/boolean/null}；named{name}；array{itemType}；object{properties}；union{types}。旧的 image / domain 等 kind 与 array.item 不再接受，不加开发期兼容层。

命名类型使用 namespace，例如 media.image、story.character、commerce.product、system.json，允许 my-plugin.custom_data。核心 union 不随领域名称增长。AnyType 使用独立 kind:any；JsonType 是 named:system.json，不能将 JSON 与所有语义类型自动等同。

isTypeAssignable 是前后端共用的纯函数：

- primitive 名称、named 名称精确相同；没有继承、转换或字符串到媒体的提升。
- T[] 递归比较 itemType，不自动执行 T 与 T[] 的升降维。
- 源 union 的每一种可能都必须可赋给目标；目标 union 接受其中任意一个兼容分支。
- object 采用结构兼容：来源必须具备目标的全部字段，字段类型递归兼容；允许来源有额外字段。
- 任意类型可以赋给 any；any 来源不能直接赋给具体类型。

string | null 通过 union 表达。输入 required:false（或未声明 required）表示可省略绑定，与值可为 null 不同。一个端口仍只保存一条绑定；数组描述集合，不恢复 multiple 标志。

## Named Type Registry

共享 DataTypeManifest 只含 name、displayName、category 和 storage。服务端 DataTypeDefinition 将 Manifest 与实际 Zod Schema 组合，DataTypeRegistry 拒绝重复或未知名称，目录返回独立 JSON 副本。

Registry 可将 primitive / named / array / object / union 递归组合为真实值校验器；parse 同时拒绝非 JSON 输入和非 JSON 转换结果。结构描述的对象字段均为必填；optional 由节点输入契约表达，不通过 nullable 代替。端口静态兼容不代替节点的完整 Zod 约束。

没有注册虚构媒体 Schema 或业务对象。共享 builtin-types 只提供语义类型常量；只有具备实际值 Schema 的受信任定义才能注册。DataTypeRegistry 未提供生产目录 API，也不自动安装插件。

## RuntimeValue 与引用

RuntimeValue 只有两类：

```ts
{ storage: "inline", type: DataType, value: JSONValue }
{ storage: "reference", type: DataType, reference: DataReference }
```

共享 Schema 校验结构与 JSON，不承担语义值校验、字节预算或权限校验。类型由服务端 Registry 与节点 Zod 验证，引用由内容服务验证项目归属和版本。

ArtifactReference 为 {kind:"artifact", id}，ID 指向不可变产物。AssetReference 为 {kind:"asset", id, versionId}；AssetBinding 同样显式携带 assetId 与 versionId，禁止缺少版本时选择最新版。增加 versionId 保留已有的版本化资产约束。

StoragePolicy 包含 inline、reference、auto：小型值可内联，媒体及大型文档必须引用；auto 的大小预算由统一 Codec 决定，不能分散在每个 Node。短文本和小型领域元数据适合内联；大型小说也须引用，不能因其为字符串就反复进入 Checkpoint。

## Artifact、Asset 与领域对象

Artifact 契约保存项目、运行、可选 NodeRun 来源、DataType、对象存储位置、可选 JSON 元数据和 ISO 时间。存储位置含 provider/key 以及可选 MIME、大小、checksum，不以 URL 作为核心存储字段。

Asset 契约保存项目、名字、DataType、明确 versionId、来源和内容。来源包括 upload、artifact、external；内容可为内联 JSON 或独立对象存储位置。文件不是唯一资产形态，Character 等领域对象同样可以成为受管理的资产。

节点结果首先是 Artifact，进入可复用资产库需显式 Promote 或已明确的规则；不自动把全部候选图、中间文件和重试产物堆入资产库。Domain Object 描述数据形状，不自动赋予持久化身份。Shot 可以包含产物引用，而不内嵌生成视频的二进制。

本轮仅实现上述共享内容协议及 ArtifactStore / AssetStore 服务接口，没有创建数据库表、上传、Promote 或资产库业务。实际存储继续统一使用 RustFS / S3，不引入本地存储或内存生产兜底。

## Codec、Binding 与执行服务接口

RuntimeValueContext 明确 projectId、workflowRunId 和可选 nodeRunId。RuntimeValueCodec.encode 负责实际值验证、StoragePolicy 与产物持久化后返回 RuntimeValue；decode 负责类型兼容与授权引用解析，返回业务可用值。

媒体解析应返回 ResolvedMediaObject：明确引用、MIME、可选尺寸/时长与临时 access.url，不机械下载成 Buffer，也不把临时 URL 写回持久 RuntimeValue。ArtifactStore / AssetStore 的所有访问都带项目运行上下文，不能仅凭知道引用 ID 就获得读取权限。

BindingResolver.resolveValue 保留本次绑定使用的 RuntimeValue，供执行管线 decode 和记录输入快照；resolve(binding, expectedType, context) 接收包含 WorkflowState 的上下文，解析 connection / workflow_input / constant / asset，再经 Codec 返回节点实际输入。这样不必把含临时访问 URL 的已解析媒体对象重新 encode 成快照。Codec、Resolver 与内容 Store 当前是服务接口，尚无生产实现；不会悄悄把绑定描述当作已解析值。

NodeExecutor 的统一管线契约是：解析绑定、decode、输入/配置 Zod 校验、NodeType.execute、输出校验、encode、持久化 Artifact、记录 NodeRun，最后返回本节点的 outputs 增量。NodeRunRecorder 的 begin / complete / fail 与 Checkpoint 分离，输入输出快照使用 RuntimeValue，不能把凭证或临时访问 URL 写入快照。attempt 不等于节点函数重入次数。

普通 NodeType 只实现 input + config + context → output。它不获得 Graph builder、BindingResolver、内容 Store 或 Checkpoint。控制、复合与交互结构由独立 CompilationStrategy 处理，不在 Executor 中按业务 type 写 switch。完整执行管线仍需运行服务接入，不能把接口或测试替身写成已完成的 Runtime。
