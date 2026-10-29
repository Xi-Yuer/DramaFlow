# 数据类型、运行值与内容引用

类型、运行值和内容引用的约束。接入范围见 [当前架构](architecture.md)，执行管线见 [Runtime](runtime-architecture.md)。

## 四个维度

| 概念          | 职责                                                             |
| ------------- | ---------------------------------------------------------------- |
| DataType      | 端口的语义类型                                                   |
| RuntimeValue  | 本次运行的值：inline、reference 或 collection，都带实际 DataType |
| DataReference | 持久内容身份：Artifact ID，或 Asset ID + versionId               |
| Domain Object | 业务结构本身，可内联，也可作为 Artifact / Asset 内容             |

Image 不等于 Asset，Character 不等于 Asset。签名 URL、供应商 URL 和本地路径不能充当长期身份。

## DataType

正式描述是纯 JSON：any；primitive（string / number / boolean / null）；named；array.itemType；object.properties；union.types。

命名类型使用 namespace，例如 media.image、example.record、system.json。核心 union 不随领域名称增长。any 是独立 kind；system.json 不能自动等于所有语义类型。

isTypeAssignable 前后端共用：

- primitive 和 named 只按名称精确相等，没有继承或字符串到媒体的提升。
- 数组递归比较 itemType，不自动升降维。
- 源 union 的每一种都必须可赋给目标；目标 union 接受任一兼容分支。
- object 按结构兼容：来源须具备目标的全部字段，允许额外字段。
- 任意类型可赋给 any；any 不能直接赋给具体类型。

可空用 union。required:false 表示可省略，与值可为 null 不同。一个输入端口至多一条 Data Edge 或一条静态绑定。数组不表示多连接聚合。template 在这一条绑定内用 `{{名称}}` 引用多个 node_output 或 workflow_input。

DataTypeManifest 只有 name、displayName、category、storage。服务端把 Manifest 和 Zod 组成 DataTypeDefinition。Registry 拒绝重复或未知名称。结构对象的字段均为必填；可选由节点输入契约表达。没有生产目录 API，也不自动安装插件。未注册的媒体 Schema 不能进入 Registry。

调用契约校验复用 Registry 的递归 Schema，对 inline 同时验证类型标签与声明类型下的实际值，不使用 Schema 的转换或默认结果改写输入。未注册的 named Schema 以独立的不可用错误拒绝 inline，不回退 JSON 或猜测字段；当前生产 Submission 未注册 named 业务 Schema。reference 只按 DataType 兼容规则检查，其真实内容留给 Runtime。类型标签不兼容与实际值错误分别使用 WORKFLOW_INVOCATION_INPUT_TYPE_MISMATCH、WORKFLOW_INVOCATION_INPUT_VALUE_INVALID。

## RuntimeValue 与存储策略

```ts
{ storage: "inline", type: DataType, value: JSONValue }
{ storage: "reference", type: DataType, reference: DataReference }
{ storage: "collection", type: ArrayDataType, elements: RuntimeValue[] }
```

共享 Schema 校验结构和 JSON；collection 还校验元素 DataType 可赋给 itemType，并拒绝内联媒体元素。不校验业务内容、字节预算或权限。collection.elements 属于运行表示，不能当作 inline 的业务 JSON 数组。

ArtifactReference 为 `{kind:"artifact", id}`。AssetReference 为 `{kind:"asset", id, versionId}`。禁止缺少版本时选择最新版。

storagePolicy 为 inline、reference 或 auto，省略按 auto。auto 只由 DataStoragePolicyResolver 按类型决定，不按 JSON 长度猜测。默认：primitive、system.json 为 inline；media.file / image / video / audio / document 为 reference。未注册 named，以及 any / array / object / union 的 auto，报 DATA_STORAGE_POLICY_NOT_FOUND。显式 inline / reference 不调用 Resolver。普通 JSON 数组可显式选择 inline 或整体 Artifact reference；auto 数组继续要求显式策略，不启用大小阈值。媒体数组不能直接 encode 为 JSON（空数组除外），须逐元素用原有 BinaryContent / Artifact 管线 encode，再交给集合 Builder 保留引用；不能回写含临时 URL 的 MediaResource 数组。大型文本应显式 reference。

## Artifact 与 Asset

Artifact 保存项目、运行、可选 NodeRun、DataType、contentKind（json / blob）和对象位置。位置使用 provider / key，不以 URL 为身份。只有 ready 可解析；内容身份不可更新。NodeRun 已关联逻辑 occurrence，Artifact 经 nodeRunId 反查，不重复存储 scopeKey / occurrenceId；Iteration Body 产物也经 NodeRun.childExecutionId 追溯对应 item，不复制完整 item payload。

需要引用承载的输出先成为 Artifact。inline 不创建 Artifact。进入资产库必须显式 Promote。Asset 保存项目、名字、DataType、明确 versionId、来源（upload / artifact / external）和内容。Asset 的数据库、版本读取和 Promote 尚未接入。解析 Asset 引用报 REFERENCE_RESOLUTION_FAILED，cause.code 为 ASSET_REFERENCE_NOT_CONFIGURED。

生产 Writer 接受 JSON，或媒体类型要求的 BinaryContent `{ bytes, mimeType }`。不把 URL 当作已保存媒体，也不自动下载。JSON 按 UTF-8 存储，decode 还原原值；blob decode 返回带临时 access.url 的 MediaResource。临时 URL 不能回写 RuntimeValue、输入快照或日志。写入细节见 [对象存储](object-storage.md)。

## Codec 与 Binding

decode 把 RuntimeValue 变成业务值。inline 直接返回，无 I/O；reference 只委托有项目 / 运行作用域的 DataReferenceResolver；collection 按顺序递归 decode 元素，得到业务数组（嵌套数组不 flatten），此时才解析元素引用。Codec 不查库、不访问对象存储、不校验业务 Schema。任一引用失败则整组失败，保留 ReferenceResolutionError。NodeExecutor 在 decode_input 保留该错误，与 validate_input 的 NODE_INPUT_VALIDATION_FAILED 区分。

encode 处理已经过业务校验的单个输出。inline 只包装可持久化 JSON，不创建 Artifact。reference 只调用 ArtifactWriter，成功后包装 ArtifactReference，不把业务内容或临时 URL 写入 State。编码失败标记 encode_output，不返回部分结果，不回滚已写入的前序 Artifact。

BindingResolver 按 Manifest 合并 Data Edge 和静态绑定，返回 RuntimeValue，不 decode、不做 I/O。Control Edge 不取值。constant 按目标端口类型内联包装；workflow_input 复用 State.inputs 中的 RuntimeValue。明确 optional 的 workflow_input 缺失并绑定到已通过发布校验的可选节点输入时，省略目标 key，不生成 null、undefined 或空字符串占位；required 或未知声明的来源缺失仍报 WORKFLOW_INPUT_MISSING。已提供的 null、false、0、空字符串和 reference 原样保留，不按 truthy 判断缺失。asset 包装为带 assetId 和 versionId 的引用。template 只按绑定中的变量查找已有 RuntimeValue，变量必须已是内联字符串，渲染结果是一条内联字符串；不扫描未声明输出，也不读取引用。来源冲突报 INPUT_SOURCE_CONFLICT，上游输出缺失报 SOURCE_NODE_OUTPUT_MISSING，端口未声明报 INPUT_PORT_NOT_FOUND，模板变量不是内联字符串时报 TEMPLATE_VARIABLE_INVALID。节点业务校验留在执行层，Workflow 存在性规则见 [Workflow](workflow-model.md#输入与输出)。

## 固定集合快照与有序构造

[RuntimeCollectionSnapshot / OrderedRuntimeCollectionBuilder](../packages/workflow/src/runtime/values/runtime-collection.ts)为通用值工具，不包含 Iteration 身份或调度。Snapshot.create 接受明确 array DataType：inline 数组按 itemType 包装元素；整体 reference 经 Codec 读取一次业务 JSON 容器，再固定元素；collection 直接保留各元素表示，不读取引用内容。非空媒体集合要求 collection 中的引用元素，不能把整体媒体 reference 猜成可索引容器。

Snapshot 深复制并冻结表示，不修改调用方原值；length、index 与元素内容固定，相同业务值仍占不同 slot，get 越界或非整数失败。get 返回 RuntimeValue，可直接交给 Graph Invocation 映射。toRuntimeValue 返回可序列化的 collection；保存该值后恢复 snapshot 不再读取原容器。Snapshot 类实例及其私有字段不直接进入 checkpoint，持久化由调用方负责。

Builder 在已知 length 内接收 index / RuntimeValue，拒绝越界、重复、遗漏与类型不兼容，按原 index 构造输出。若所有元素均 inline 且实际类型与 itemType 完全一致，则压缩为 inline 业务数组；否则返回 collection，保留引用及窄元素类型。没有 I/O、存储策略选择、value hash、临时 URL 或自动 flatten。整体 JSON Artifact 与元素引用集合是不同表示，不能将 envelope 数组交给普通 JSON encode 冒充业务 Array<T>。
