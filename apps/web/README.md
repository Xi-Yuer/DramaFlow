# web

提供账户、项目、Workflow 编辑与用户级模型管理。

`src/features/` 先按业务入口分组，再按实际职责组织内部模块。画布入口只装配会话，不在入口中实现项目保存、模型配置或文本编辑器生命周期。

| 目录                                             | 职责                                 |
| ------------------------------------------------ | ------------------------------------ |
| `workflow/editor/draft/`                         | 草稿状态、保存和修订冲突             |
| `workflow/editor/project/`                       | 项目名称、根视口、保存与重读         |
| `workflow/editor/navigation/`                    | 子图导航、转场和离开保护             |
| `workflow/editor/models/`、`presentation/`       | 编辑器模型设置会话、工具栏和操作提示 |
| `workflow/inputs/template/`                      | 模板绑定、文档转换和上游来源规则     |
| `workflow/inputs/template/editor/`、`variables/` | Tiptap 生命周期、变量插入与选择器    |

`test/models/` 与 `test/workflow/` 按功能组织现有测试，跨场景 fixture 放在 `test/fixtures/`。内部调用直接引用职责模块；界面和保存协议的行为由测试约束。格式统一继承仓库根配置。

行为见 [当前架构](../../docs/architecture.md)。样式见 [前端规范](../../docs/frontend.md)。启动与检查见 [根 README](../../README.md)。
