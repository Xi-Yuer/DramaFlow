"""单独探针容器使用的只读缓存观察 callback；普通验证容器不加载它。"""

import hashlib
import json
import urllib.request

import litellm
from litellm.integrations.custom_logger import CustomLogger
from litellm.proxy import proxy_server


class CacheObserver(CustomLogger):
    async def async_log_success_event(self, kwargs, response_obj, start_time, end_time):
        cache = litellm.in_memory_llm_clients_cache
        found = []
        seen = set()

        def visit(value, location, depth):
            if depth > 4 or id(value) in seen:
                return
            seen.add(id(value))
            if isinstance(value, str):
                if value.startswith("sk-l1-provider-"):
                    found.append({"location": location, "fingerprint": hashlib.sha256(value.encode()).hexdigest()[:16]})
            elif isinstance(value, dict):
                for key, item in value.items():
                    visit(item, f"{location}.mapping-value", depth + 1)
                    visit(key, f"{location}.mapping-key", depth + 1)
            elif isinstance(value, (tuple, list)):
                for item in value:
                    visit(item, f"{location}.sequence-value", depth + 1)
            elif hasattr(value, "__dict__"):
                for key, item in vars(value).items():
                    if key in {"api_key", "_api_key", "_client", "_custom_headers", "_headers"}:
                        visit(item, f"{location}.{type(value).__name__}.{key}", depth + 1)

        visit(cache.cache_dict, "llm_client_cache", 0)
        summary = {
            "cacheType": type(cache).__name__,
            "cacheEntries": len(cache.cache_dict),
            "defaultTtlSeconds": cache.default_ttl,
            "credentialReferences": found,
            "databaseClientPresent": proxy_server.prisma_client is not None,
            "configuredModels": [item["model_name"] for item in proxy_server.llm_router.model_list],
            "configuredProviderCredentialPresent": "sk-l1-provider-" in json.dumps(proxy_server.llm_router.model_list, default=str),
            "globalProviderCredentialPresent": any(
                isinstance(getattr(litellm, name, None), str)
                and getattr(litellm, name).startswith("sk-l1-provider-")
                for name in ["api_key", "openai_key", "anthropic_key"]
            ),
        }
        request = urllib.request.Request(
            "http://upstream:8080/__observation", data=json.dumps(summary).encode(),
            headers={"Content-Type": "application/json"}, method="POST",
        )
        # 只发送类型、数量和合成凭证的 hash；不发送凭证值、cache key 或原始对象。
        with urllib.request.urlopen(request, timeout=5) as response:
            response.read()


observer = CacheObserver()
