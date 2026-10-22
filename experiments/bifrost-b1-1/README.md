# Bifrost transport 控制点核查

历史结论：NO-GO。固定 Gateway HTTP v2.3.2 没有向配置或 Provider client 注入接口暴露底层 transport retry 关闭能力；依赖库存在公开字段不等于产品可配置。未实施 fork、补丁或代理。

[result.json](result.json) 和 [source-audit.json](source-audit.json) 保存验证结果与源码证据；镜像沿用 [B1 锁文件](../bifrost-b1/image.lock.json)。该实验只核查控制点及 VK 负向行为，不重新声明完整故障矩阵通过。

需要 Node 24、Docker 和锁定镜像，从仓库根目录执行 `node experiments/bifrost-b1-1/run.mjs`。仅使用合成凭证 / 本机替身，不加载项目 `.env`，不调用真实 Provider，不连接业务库。新结果位于 `.local`，不覆盖提交的证据。

非生产路径；历史分析由 Git 保留，当前实现见[架构](../../docs/architecture.md#文本-ai-与-provider-plugin)。
