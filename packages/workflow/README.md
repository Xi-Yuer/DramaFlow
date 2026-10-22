# @dramaflow/workflow

领域校验、Registry、编译、Codec、提交和执行。不含 HTTP、数据库或 Checkpointer。

| 目录 | 职责 |
| --- | --- |
| definition | 输入输出校验、版本快照、静态发布语义 |
| data | DataType Registry 与真实值校验 |
| node | NodeType、精确版本 Registry、Preset |
| runtime | State、Binding、Codec、Action Executor |
| compiler | 普通 Action 图与依赖编译 |
| run | Submission 与 Runner |

协议见 [数据模型](../../docs/data-model.md)、[Node](../../docs/node-model.md) 和 [Runtime](../../docs/runtime-architecture.md)。已实现范围见 [当前架构](../../docs/architecture.md)。
