# 前端规范

只用于当轮明确授权的界面。当前使用 Next.js、Ant Design、TanStack Query；主题以 [theme.ts](../apps/web/src/app/theme.ts) 为准，不另建一套样式或控件体系。

## 交互边界

- 节点创建读取独立 JSON Catalog Entry，端口和控件读取精确 target Manifest；config[].ui / ui.inputs 指定控件，不重复维护数值范围、默认值或厂商列表。Data Handle 使用端口 key，Control Handle 使用 control:source / control:target，命名出口追加 Manifest 的 key；连接语义见 [Node](node-model.md)。
- 新 Data Edge 替换已有静态输入须确认，取消保持定义不变；已有节点输出来源时明确选择替换或添加候选。候选以绑定投影多条数据线，共用输入 Handle，不写入真实 edges；详细能力见[当前架构](architecture.md#react-flow-数据适配)。selected / dragging / measured 不持久化。保存失败不得显示已保存，短暂会话检查故障保留 Editor，明确拒绝访问则隐藏内容。
- 模型选择只写 modelConfigurationId，配置从 Schema / Catalog 得到；不静默替换失效配置。供应商配置意图只在当前界面保留，取消不继续。Secret 不回填、不进 Form / Query / 浏览器存储，请求发出及退出表单时清空。
- prompt / system 独立保存 constant 或 template；变量展示当前节点 / 端口名称，保存 nodeId / portKey。引用节点输出即自动显示数据依赖投影，不额外创建 Data Edge；重复 alias 共用一条依赖线，变量通过输入编辑器删除。禁止自身和下游来源。
- Save 与 Publish 分离，发布锁定 Draft，不隐式保存或运行；当前保存修订与最新版本分别展示。Run 始终明确选择已发布版本。
- Iteration Body 的 Item Selector 只选择实际 ChildExecution，显示 Item `index + 1`，以真实 executionId 为值；按 metadata.index 排序，默认最小 index。有效选择在刷新后保留，失效才回退；单 Item 不强制操作，分页未完成不提前选择。Canvas / Inspector 共享当前执行实例，不把 Item 切换写入 Draft 或持久化为节点配置。
- 主动离开统一使用 Editor guard；Logout 先确认再退出。invocation recovery 不自动重放请求，具体行为见[当前架构](architecture.md#web-invocation-identity-recovery)。

## 视觉与组件

创作画布优先，界面安静、克制。保留石墨灰 / 青色主题，不采用传统蓝色后台、营销横幅或装饰性图表。

- 近黑 / 炭灰分层，中灰辅助文字保证对比；青色用于关键操作与焦点，成功 / 警告 / 失败用独立语义色。避免大面积霓虹、厚重玻璃和常驻发光。
- 顶部只放当前对象与必要操作；节点参数就近，次要区域按需放抽屉 / 浮层，不挤占画布。真实素材内容优先于界面装饰。
- 圆角、细边框、阴影、间距与弹层遵循统一主题。正文约 13—14px、辅助文字约 11—12px，中文使用系统无衬线字体，图标保持同套线性风格。
- 编辑、选中、运行、等待、失败状态清楚；关键操作支持键盘和触屏，图标按钮提供可访问名称。复用组件库焦点管理、表单校验、滚动和禁用状态。
- 动效通常为 150—250ms 的轻微状态反馈，尊重减少动态效果；不增加无业务意义的粒子、光束或频繁动画。
- Canvas 运行态通过节点边框、轻底色和标题图标表达，不使用状态胶囊；完成态保持低权重，运行、人工等待与失败须清晰可辨。DataEdge 使用低强度方向流动，ControlEdge 保持静态实线箭头；投影须有可识别标记。具体实现见[当前架构](architecture.md#canvas-运行态与连线表现)。
- 新增按钮、输入、菜单、确认与提示使用成熟组件，当前复用 Ant Design；不手写原生 button / input 替代产品控件，不引入第二套组件库或手写已有的通用交互原语。

实现完整的加载、空态、错误和响应式行为，不用模拟数据冒充已接入。视觉规范不授权新增业务或重做全站。

## If 条件编辑

`flow.if@1` 继续使用 Generic Node；value 使用现有 string 输入 / Binding / DataEdge，条件表单只编辑 `config.condition`，不写入输入来源。四个操作为等于、不等于、包含、不包含，映射正式 ConditionExpression，不展示 JSON Logic 编辑器。新节点不填默认条件；选择操作后比较文本允许为空，保留大小写、空格与换行。画布摘要使用普通文本。

true / false Handle 来自精确 Manifest 的 controlOutputs，保存为 ControlEdge.source.portKey。Web 拒绝未声明或无名称出口、重复出口和两支同目标；复杂拓扑仍由 Publish 权威校验，并给出中文限制说明，不复制 Compiler 分析。Draft 允许不完整并可 Save；未知表达式不因加载、编辑其他字段或保存而改写，明确点击「替换为可编辑条件」后才替换。条件编辑职责集中于 `features/workflow/conditions/`，不另建 React Flow 节点模型。

## Workflow 输出编辑

画布的「结束」边界投影 `WorkflowDefinition.outputs`，不作为业务节点执行。节点输出端口拖到结束边界可创建输出；边界内统一配置名称、来源节点和输出端口，DataType 自动取 Manifest。多项输出分别声明，名称遵守 Contract 且唯一。拖线遇到已有输出时，明确选择「新建独立输出」或「加入某项的候选」；同一输出可投影多条来源线，不写入业务 edges。单来源删线删除声明；候选模式删线或删节点只移除对应 candidate，保留名称、类型及零/单候选 Draft，并提示补齐，不自动转换成 source。候选表单保留 sources 模式，最终互斥与覆盖由 Publish 校验。结束边界可移动但不可删除，位置只在当前页面保留，不扩展领域布局协议。

## Human Review

`flow.human_review@1` 复用节点目录和端口展示，设计时在节点设置中编辑名称、静态审核说明，content 使用现有输入编辑与连线。审批操作放在 Run 的状态与结果面板，不混入节点配置。

waiting Run 查询 Pending Human Review；单条卡片依次显示等待提示、节点名称、审核说明（可选）、纯文本内容、可选反馈和「拒绝」「通过」。不渲染 RuntimeValue JSON 或 interrupt / revision / checkpoint 身份，不执行内容中的 HTML。reject 是正常业务决策，后续流程由图决定。

提交中禁用反馈与决策，submitted 显示「审批结果已提交，等待工作流继续执行……」。POST 后继续跟踪原 Run；网络不确定和 409 只重新查询，不自动重试 POST。查询失败不得保留旧审批操作；新审核清空旧反馈。普通待审批停止高频 Run 查询，已提交时沿用 Run timer 确认恢复；串行下一条审核更新卡片，终态复用现有结果与失败 UI。关闭面板不停止页面级状态跟踪。并行 pending 暂不提供审批 UI，显示能力错误。
