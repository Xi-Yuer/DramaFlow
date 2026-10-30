# Authoring Layer 与前端规范

Web 使用 Next.js、React Flow、TanStack Query、Ant Design，主题以 [theme.ts](../apps/web/src/app/theme.ts) 为准。产品路径见[产品文档](product.md)，领域连线与节点协议见[Workflow](workflow.md)。

## Canvas 与编辑状态

Canvas 是 Workflow Definition 的编辑空间。React Flow 只负责视图和交互：selected、dragging、measured 及投影边不持久化；ui.position 保存布局，项目保存根视口。转换和领域修改集中在 `workflow/canvas/adapter/`，交互确认在 `editing/`，会话状态在 `view/`，渲染在 `rendering/`。

DataEdge、ControlEdge 按原协议序列化。模板与候选连线从绑定投影，共用目标输入 Handle，不写入真实 edges；重复 alias 共用数据依赖投影。断连 / 重连核对完整旧快照，拒绝过期事件。替换静态输入必须确认；已有节点输出来源时明确选择替换或添加候选。

Root / Body 共用 Graph Input 定义编辑与输入边界连接。输入可改名、删除、设置 required 和类型；支持文本、数字、布尔及文本 / 数字列表。未知类型保留原声明。输入重命名和删除只清理本图相关绑定，不改其他作用域。

End 边界投影 Graph outputs，不是 NodeType，不进入 nodes。拖入来源可新建输出或加入候选；单来源删线删除声明，候选删线只移除对应来源，零 / 单候选仍作为可修复 Draft 保留，不静默转换模式。End 可以移动但不能删除，位置只在页面会话保留。

## Catalog 与 Inspector

Picker 读取独立 Catalog Entry 创建实例，端口、输入和配置控件读取精确 target Manifest。Entry 加载失败只禁用创建，不影响已有节点按 Manifest 编辑。普通 Picker 只显示 public，再叠加当前图的 capability 限制；SubWorkflow graph 仅允许普通 Action，Iteration Body 允许 Action 与精确 SubWorkflow。

设计 Inspector 修改节点配置、名称、输入绑定及 Composite 边界；运行 Inspector 展示真实 occurrence / attempt、输入输出、耗时和安全错误，不修改草稿。未知条件配置保留，只有明确替换才转换成可编辑条件。

If 在 Generic Node 中编辑等于、不等于、包含、不包含，value 复用 string Binding；true / false Handle 来自 Manifest。UI 不复制完整 Compiler 拓扑证明，Publish 是权威校验。

prompt / system 独立保存 constant 或 template。变量展示当前节点与端口名称，持久化仍保存 nodeId / portKey，禁止自身和下游来源。选择变量不创建真实 Data Edge。

## 模型设置

Provider 与模型配置属于账号，Query 缓存按用户 ID 隔离。画布抽屉和节点模型选择共享正式目录 / Schema，节点只写 modelConfigurationId；参数读取绑定配置，不在节点另存。

`models/settings/` 管理资源与表单会话，`providers/` 和 `configurations/` 负责各自提交，`shared/` 复用非秘密 Schema 控件。`workflow/model-selection/selection/` 负责资源、意图恢复和选项，`presentation/` 展示，`configuration/` 处理明确添加操作。

从节点进入配置成功后继续原选择意图，取消不写节点。Secret 只存在于当前提交表单，请求发出和退出即清空；不回填、不进 Query、URL 或浏览器存储，不因错误恢复凭证。

## Nested Graph

双击或选择节点“进入”可以下钻局部图；面包屑按 Definition Location 导航。各层保存视口和选择，返回不改定义。图编辑使用静态 nodeId / graphKey 路径，不使用运行 scope。

Iteration Item Selector 只列实际 ChildExecution，以 executionId 为值，按 metadata.index 排序，显示 index+1。单 Item 可以自动关联；多 Item 在完整分页读取后选择，默认最小 index。失效的已选 ID 要求重新选择，不能静默换 Item。

执行选择按 Run / Version / Definition Location 隔离并可在刷新后恢复；祖先选择变化清除后代。选择只改变运行投影，不写入 Draft 或节点配置。

## Run Workspace 与历史查看

Save、Publish、Run 相互独立。Publish 发布已保存草稿，不隐式保存或运行；Run 始终选择明确已发布版本。未发布编辑不会进入请求。运行输入表单支持已实现的基础类型和列表；不支持的输入类型明确阻止提交，没有引用选择器。

运行工作区提供设置、状态与结果、历史和执行树。完成结果只展示声明输出：inline 字符串 / JSON 可读，reference 展示身份并提示不支持预览，collection 暂不展开；没有声明输出时明确显示空结果。

历史列表按需分页和刷新。选择 Run 后按其固定 Version 只读展示 Canvas、Inspector 和嵌套图，锁定创建、拖动与配置写入。版本不可用时不借用 Draft；返回草稿保留未保存编辑，不写入历史视口。运行表单版本与历史查看版本是独立状态。

审核卡片展示文本、说明、可选反馈和通过 / 拒绝。提交中锁定操作，submitted 等待运行继续；不渲染内容 HTML、不直接编辑正文。网络不明或冲突只重新查询，不自动再次 POST。取消通过确认操作受理；requested / uncertain 不当成已经停止，观察到 cancelled 后撤下审核。

## 运行投影与执行树

Canvas / Inspector 共用 Graph Execution Projection，从固定版本的 Definition Location 和显式 parent relation 逐层解析边界；不按全局 nodeId 或最大 attempt 猜测执行。缺少唯一关联时显示未关联 / 不可用，不制造虚拟 Item。祖先 Item 选择限定后代 SubWorkflow 的解析范围，siblings 不交叉。

Execution Tree 是独立只读浏览器，每次读取 parent 的一层，使用返回的 type / id 下钻。NodeRun 不存在 ChildExecution 时留在原层。不同 attempt 不合并，名称来自匹配版本且只在唯一时使用；Tree 名称不建立执行归属。没有点击条目直接定位画布、child Retry / Resume / Cancel 或结果编辑。

画布状态来自实际运行投影，不从数据流动画推断 Active Edge。DataEdge 使用低强度方向流动，ControlEdge 静态呈现；Template / Candidate 投影有明确标识。运行、人工等待和失败须明显，完成态保持低权重。

## 保存、离开与请求恢复

保存失败不显示已保存；修订冲突阻止覆盖。短暂后台会话检查故障保留 Editor，明确拒绝访问则隐藏内容。项目元数据与 Workflow 草稿分别保存。

统一离开 guard 协调草稿与元数据保存、丢弃、取消；Project 共享导航必须接入当前页面的 guard，页面卸载后解除注册，不能绕过 Canvas 或设置页的未保存保护。Logout 先确认，标准 beforeunload 保护未保存状态。不改写 Router / history，也不保证崩溃或强制关闭可拦截。

invocation recovery 只在用户 namespace 保存 workflow / version / key、可选 Run ID 等身份，不保存输入内容或 Secret。页面重进只 lookup；未找到或查询失败时保留身份，不自动 POST 或换 key。storage event 同步集合，不当跨 Tab 锁；退出后清用户记录并拒绝晚到响应。终态 receipt 清理不清空当前页面结果。

## 视觉与组件规范

创作画布优先，使用近黑 / 炭灰、中灰与青色主题，正文约 13—14px；运行含义不能只依赖颜色。控件、确认和提示复用成熟组件，新增交互使用 Ant Design，不另建平行控件体系。

顶部放当前对象与必要操作，节点参数就近呈现，次要内容使用抽屉 / 浮层。保持键盘与触屏可操作、图标可访问名称、完整加载 / 空态 / 错误与响应式行为。动效通常 150—250ms，减少动态效果偏好下关闭流动和旋转，不使用模拟数据冒充接入。
