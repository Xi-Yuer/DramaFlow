# @dramaflow/workflow

领域校验、Registry、编译、Codec、提交和执行。不含 HTTP、数据库或 Checkpointer。

各目录根上只留该层的装配入口。同一职责的实现放进子目录，不把无关文件平铺在一起。

| 目录                                              | 职责                                                                                                    |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| definition/contract                               | 输入输出值契约、不可变版本快照、调用契约                                                                |
| definition/publish                                | 静态定义语义与发布错误。不编译图，也不判断拓扑能力                                                      |
| node/registry                                     | NodeType、Schema、Operation 与精确版本 Registry                                                         |
| node/builtin                                      | 内置节点声明。`execute` 只依赖执行上下文，不依赖 Executor                                               |
| compiler                                          | 编译装配、策略契约、Publish / Compile 共用的执行能力门禁                                                |
| compiler/graph                                    | Scoped / recursive graph plan、通用编译管线与原生 builder 边界；不处理 invocation mapping / persistence |
| compiler/dependency                               | 普通依赖收集、ALL join 与静态执行预算                                                                   |
| compiler/if、human-review、iteration、subworkflow | 各自的分析、策略与专属运行辅助。条件求值在 `if/`，LangGraph 兼容检查在 `iteration/`                     |
| runtime/state                                     | Workflow State 与声明输出解析                                                                           |
| runtime/binding                                   | 本图显式数据来源的 Binding                                                                              |
| runtime/node                                      | 执行上下文、Action Executor 与节点失败记录                                                              |
| runtime/execution                                 | NodeRun / ChildExecution 端口、scope 与局部图调用                                                       |
| runtime/values                                    | 运行值、内容引用与存储策略                                                                              |
| data                                              | DataType Registry 与真实值校验                                                                          |
| run/runner                                        | Runner、运行配置与 Run 级错误                                                                           |
| run/repository                                    | WorkflowRun 与 WorkflowVersion 端口                                                                     |
| run/submission                                    | 调用等价性与受理                                                                                        |

依赖方向：definition 与 node 不引用编译策略；compiler 使用 definition 与 runtime；run 使用 compiler 完成一次 Run。执行归属端口不进入受理。

协议见 [数据模型](../../docs/data-model.md)、[Node](../../docs/node-model.md) 和 [Runtime](../../docs/runtime-architecture.md)。已实现范围见 [当前架构](../../docs/architecture.md)。
