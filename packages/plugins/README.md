# 受信任模型插件

浏览器仅加载 `@dramaflow/plugins/manifest`。服务端调用 `getProvider(pluginId, pluginVersion)`，精确选择已安装版本；未知插件或不支持的能力立即报错，不自动替换厂商。

内置 OpenAI 适配器以 LangChain 调用文本接口，以官方 OpenAI SDK 调用图片接口。兼容插件仅声明 Chat Completions 文本能力，要求明确接口地址。模型 ID 由用户选择；连接必须声明真实上下文窗口，平台不会猜测兼容模型的限制。

请求参数经过严格 Schema 校验；供应商 SDK 自动重试关闭。网络断开、超时与服务端 5xx 可能发生在供应商受理之后，统一返回 `OUTCOME_UNKNOWN`，由宿主记录和协调，不能盲重试。错误不携带原始 SDK headers、密钥或请求对象。HTTP(S) 地址的可访问范围与 SSRF 防护由宿主的连接管理负责。

图片返回 base64 或供应商 URL，宿主负责保存成版本化资产后交给工作流。Video 的 submit/poll/cancel 接口已定义，内置插件没有视频实现或视频能力声明；未安装实现时应明确显示不可用。

测试通过本地 HTTP 服务检查真实 SDK 的请求形状、返回转换和重试行为，不使用真实凭证，不宣称供应商在线调用已验证。
