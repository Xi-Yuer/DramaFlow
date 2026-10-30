# 类型、运行值与内容存储

## DataType 与引用身份

DataType 描述端口语义；RuntimeValue 描述运行表示；DataReference 描述持久内容身份。业务对象可以内联或存为内容，类型不等于 Asset。供应商 URL、签名 URL 和本地路径都不能代替长期身份。

DataType 是纯 JSON：any、primitive（string / number / boolean / null）、named、array.itemType、object.properties、union.types。named 按 namespace 命名，核心 union 不随业务类型增长。

前后端共用 `isTypeAssignable`：

- primitive / named 按名称精确相等，没有自动提升或继承。
- 数组递归比较 itemType，不自动升降维。
- 源 union 的每项都须可赋给目标；目标 union 接受任一兼容分支。
- object 按所需字段结构兼容，允许来源有额外字段。
- 任意类型可赋给 any，any 不能直接赋给具体类型。

required:false 表示可省略，nullable 用 union 表达。服务端 DataTypeRegistry 保存 Manifest 和真实 Schema，拒绝重复 / 未注册名称；没有产品目录 API或自动插件安装。Submission 的 inline 校验同时检查实际类型标签与声明类型下的内容，不将 transform / default 写回输入；未注册 named Schema 不回退成 JSON。当前生产调用校验未注册 named 业务 Schema。

## RuntimeValue

```ts
{ storage: "inline", type: DataType, value: JSONValue }
{ storage: "reference", type: DataType, reference: DataReference }
{ storage: "collection", type: ArrayDataType, elements: RuntimeValue[] }
```

Artifact reference 固定 `{ kind: "artifact", id }`，Asset reference 固定 `{ kind: "asset", id, versionId }`，不能缺省选择最新版本。collection 校验元素类型兼容并拒绝内联媒体元素；elements 是运行表示，不是 inline 业务数组。

输出 storagePolicy 为 inline / reference / auto，省略按 auto。默认 primitive、system.json 为 inline；media.file / image / video / audio / document 为 reference。其他 named、any、array、object、union 的 auto 无规则即失败，不按 JSON 长度猜测。显式 inline / reference 不调用默认策略。

普通 JSON 数组可显式 inline 或整体引用；媒体集合逐元素通过 BinaryContent / Artifact 编码再构造 collection，不保存带临时 URL 的 MediaResource 数组。大型文本可显式 reference。

## Binding 与 Codec

BindingResolver 根据 Manifest 合并真实 Data Edge 与静态绑定，返回 RuntimeValue；不 decode、不访问存储。Control Edge 不提供值。

- constant 按目标类型包装 inline。
- workflow_input 复用当前局部调用的 inputs。optional → optional 缺失时省略目标 key，不补 null 或空字符串；显式的 null / false / 0 / 空字符串仍是存在的值。
- asset 包装固定资产及版本身份，不读取内容。
- template 只读取显式变量映射，变量须为内联字符串；不扫描未声明输出、不解码引用。
- candidate 读取实际已有的唯一候选；零个或多个均失败，不设置优先级。

来源冲突、上游输出缺失、端口不存在和非法模板变量均明确报错，业务 Schema 校验留在 Executor。

Codec.decode 将表示变成业务值：inline 无 I/O，reference 委托已授权 Resolver，collection 按顺序递归解码，保留嵌套层级。引用失败与业务输入校验失败分开记录，不返回部分数组。

Codec.encode 包装已校验输出。inline 不创建 Artifact；reference 只有 Writer 成功才返回引用。失败不回滚此前已成功保存的其他 Artifact，不把正文或临时 URL 塞入 State。

## 固定集合与有序聚合

[RuntimeCollectionSnapshot](../packages/workflow/src/runtime/values/runtime-collection.ts)固定 length、index 与元素表示，深复制并冻结，不修改调用方。inline 数组按 itemType 包装；整体 JSON reference 读取一次容器再固定元素；collection 直接保留元素引用，不读取内容。非空媒体集合不能被猜成普通可索引 JSON reference。

Snapshot 的可序列化 collection 可以进入 checkpoint，类实例不进入持久状态。OrderedRuntimeCollectionBuilder 拒绝越界、重复、遗漏和类型不符，按原 index 输出；全部 inline 且类型精确匹配时可压缩为 inline 数组，否则保留 collection。没有 flatten、隐式存储阈值或调度语义。

## Artifact 与 Asset 边界

Artifact 保存项目、Run、可选 NodeRun、输出位置、DataType、编码、私有 storageKey、大小与摘要。它经 nodeRunId 追溯 occurrence 和 ChildExecution，不复制 scope、item payload 或父链。inline 输出不创建 Artifact。

生产 Writer 接收 JSON，或媒体类型要求的 BinaryContent `{ bytes, mimeType }`；不将 URL 当成已保存内容，也不自动抓取远端资源。JSON decode 还原值；blob decode 生成临时 MediaResource。

Asset 目前只有显式版本引用协议，没有数据库模型、上传产品链路、版本内容服务或 Promote。解析 Asset reference 明确失败，不回退 Artifact 或最新版。Artifact / Asset 没有独立产品列表或内容 HTTP 接口；Run 查询只返回引用身份，不 materialize 或签发 URL。

## 对象存储与生命周期

内容统一写私有 RustFS / S3，无本地文件回退。StorageService 提供 ping、put、get、head、delete 和 signedGetUrl，不承担业务权限或资产版本管理；授权由上层 Artifact Repository 按项目 / Run 检查。

写入先登记 writing 与专属 key，PUT 后确认 ready，只有 ready 可解析。PUT 失败尝试删除专属对象并记录 failed / cleanupRequired；补偿或记录失败保留全部原因。确认写库失败可能已经提交，不返回引用，也不盲删对象。进程退出保留可核对的记录和 key；没有自动对账或垃圾回收。

JSON 解析校验字节数与 SHA-256；blob 先 HEAD 验证对象和元数据。媒体输出当前使用内存字节与单次 PUT，不支持大文件流式或 multipart。

签名 GET 有效期为 900 秒。签名 URL 不保存到 State、输入快照、Artifact 身份或日志；不可签名后替换 host。删除数据库元数据不会自动清对象；项目删除服务按已登记 key 清理对象、队列与 thread，清理未完成会明确报告。

RustFS 端点、访问方地址、凭证与备份见[部署](deployment.md#对象存储)，密钥边界见[安全](security.md)。
