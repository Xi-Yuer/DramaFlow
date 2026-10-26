# Vercel AI SDK 文本适配验证

历史结论：GO，仅针对当时固定版本的文本协议、单次出站及安全投影；不表示媒体、模型发现或收费模型已验收。当前生产实现见[架构](../../docs/architecture.md#文本-ai-与-provider-plugin)，不使用本实验作为 Runtime。

- [result.json](result.json)：脱敏结果；[source-audit.json](source-audit.json)：控制点核查，路径与摘要属于当时的源码布局。
- [versions.lock.json](versions.lock.json) 与 [runtime.lock.json](runtime.lock.json)：实际验证版本。
- [run.ts](run.ts)：复现入口。只使用本机协议替身，不加载项目 `.env`，不访问业务库或收费模型。

需要 Node 24，从仓库根目录执行：

```sh
npm ci --prefix experiments/ai-sdk-c1 --ignore-scripts --no-audit --no-fund
node experiments/ai-sdk-c1/run.ts
```

新结果写入 `.local`，历史逐项分析由 Git 保留。需要复核时再读取本目录，不纳入日常上下文。
