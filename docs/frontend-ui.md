# 前端规范

只用于当轮明确授权的界面。当前使用 Next.js、Ant Design、TanStack Query；主题以 [theme.ts](../apps/web/src/app/theme.ts) 为准，不另建一套样式或控件体系。

## 交互边界

- 节点只读 JSON Manifest；config[].ui / ui.inputs 指定控件，不重复维护数值范围、默认值或厂商列表。Data Handle 使用端口 key，Control Handle 使用 control:source / control:target；连接语义见 [Node](node-model.md)。
- 新 Data Edge 替换已有静态输入须确认，取消保持定义不变；selected / dragging / measured 不持久化。保存失败不得显示已保存，短暂会话检查故障保留 Editor，明确拒绝访问则隐藏内容。
- 模型选择只写 modelConfigurationId，配置从 Schema / Catalog 得到；不静默替换失效配置。供应商配置意图只在当前界面保留，取消不继续。Secret 不回填、不进 Form / Query / 浏览器存储，请求发出及退出表单时清空。
- prompt / system 独立保存 constant 或 template；变量展示当前节点 / 端口名称，保存 nodeId / portKey，不额外创建 Data Edge。禁止自身和下游来源。
- Save 与 Publish 分离，发布锁定 Draft，不隐式保存或运行；当前保存修订与最新版本分别展示。Run 始终明确选择已发布版本。
- 主动离开统一使用 Editor guard；Logout 先确认再退出。invocation recovery 不自动重放请求，具体行为见[当前架构](architecture.md#web-invocation-identity-recovery)。

## 视觉与组件

创作画布优先，界面安静、克制。保留石墨灰 / 青色主题，不采用传统蓝色后台、营销横幅或装饰性图表。

- 近黑 / 炭灰分层，中灰辅助文字保证对比；青色用于关键操作与焦点，成功 / 警告 / 失败用独立语义色。避免大面积霓虹、厚重玻璃和常驻发光。
- 顶部只放当前对象与必要操作；节点参数就近，次要区域按需放抽屉 / 浮层，不挤占画布。真实素材内容优先于界面装饰。
- 圆角、细边框、阴影、间距与弹层遵循统一主题。正文约 13—14px、辅助文字约 11—12px，中文使用系统无衬线字体，图标保持同套线性风格。
- 编辑、选中、运行、等待、失败状态清楚；关键操作支持键盘和触屏，图标按钮提供可访问名称。复用组件库焦点管理、表单校验、滚动和禁用状态。
- 动效通常为 150—250ms 的轻微状态反馈，尊重减少动态效果；不增加无业务意义的粒子、光束或频繁动画。
- 新增按钮、输入、菜单、确认与提示使用成熟组件，当前复用 Ant Design；不手写原生 button / input 替代产品控件，不引入第二套组件库或手写已有的通用交互原语。

实现完整的加载、空态、错误和响应式行为，不用模拟数据冒充已接入。视觉规范不授权新增业务或重做全站。

## Workflow 输出编辑

画布的「结束」边界投影 `WorkflowDefinition.outputs`，不作为业务节点执行。节点输出端口拖到结束边界可创建输出；边界内统一配置名称、来源节点和输出端口，DataType 自动取 Manifest。多项输出分别声明，名称遵守 Contract 且唯一。删除边界连线即删除对应声明，删除来源节点同步清理声明。结束边界可移动但不可删除，位置只在当前页面保留，不扩展领域布局协议。
