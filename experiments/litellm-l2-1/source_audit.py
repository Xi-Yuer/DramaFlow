"""只读固定镜像，保存源文件哈希及关键定义定位；不输出请求、配置或 Secret。"""

import hashlib
import importlib.metadata
import importlib.util
import json
import pathlib

files = {
    "litellm/llms/openai/common_utils.py": ["def _get_async_http_client", "if litellm.aclient_session", "follow_redirects=True"],
    "litellm/llms/openai/openai.py": ["def _get_openai_client", "AsyncOpenAI(", "http_client=async_http_client"],
    "litellm/llms/anthropic/chat/handler.py": ["async def acompletion_function", "client or get_async_httpx_client", "await async_handler.post"],
    "litellm/llms/custom_httpx/http_handler.py": ["follow_redirects: bool = True", "follow_redirects=self.follow_redirects", "async def post", "get_async_httpx_client"],
    "litellm/llms/custom_httpx/aiohttp_transport.py": ["allow_redirects=False", "async def handle_async_request"],
    "httpx/_client.py": ["def _send_handling_redirects", "def _redirect_headers", "is_https_redirect", 'headers.pop("Authorization"', "def _redirect_method"],
    "openai/_base_client.py": ["async def request", "await self._client.send"],
}
report = {"versions": {name: importlib.metadata.version(name) for name in ["litellm", "httpx", "httpcore", "aiohttp", "openai"]}, "sources": {}}
for name, terms in files.items():
    package, relative = name.split("/", 1)
    root = pathlib.Path(importlib.util.find_spec(package).origin).parent
    source = (root / relative).read_text()
    report["sources"][name] = {"sha256": hashlib.sha256(source.encode()).hexdigest(), "locations": [
        {"line": number, "text": line.strip()} for number, line in enumerate(source.splitlines(), 1)
        if any(term in line for term in terms)]}
print(json.dumps(report))
