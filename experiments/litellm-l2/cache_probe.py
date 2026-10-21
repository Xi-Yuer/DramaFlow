"""只在观察容器运行的无修改 callback，不打印 cache key 或 Secret。"""

import hashlib
import json
import urllib.request

import litellm
from litellm.integrations.custom_logger import CustomLogger
from litellm.proxy import proxy_server


class Probe(CustomLogger):
    async def async_log_success_event(self, kwargs, response_obj, start_time, end_time):
        cache = litellm.in_memory_llm_clients_cache
        clients = []
        for key, client in cache.cache_dict.items():
            credential = getattr(client, "api_key", None)
            if isinstance(credential, str) and credential.startswith("sk-l2-provider-"):
                clients.append({
                    "clientIdentity": id(client),
                    "credentialFingerprint": hashlib.sha256(credential.encode()).hexdigest()[:16],
                    "keyContainsRawCredential": credential in key,
                    "keyContainsCredentialHash": hashlib.sha256(credential.encode()).hexdigest() in key,
                    "remainingTtlSeconds": round(cache.ttl_dict[key] - cache._clock(), 2),
                    "sdkMaxRetries": client.max_retries,
                    "closed": client.is_closed(),
                })
        snapshot = {
            "cacheDefaultTtlSeconds": cache.default_ttl,
            "routerClientTtlSeconds": proxy_server.llm_router.client_ttl,
            "cacheCapacity": cache.max_size_in_memory,
            "clients": clients,
            "routerNumRetries": proxy_server.llm_router.num_retries,
        }
        request = urllib.request.Request("http://upstream:8080/__observation",
            data=json.dumps(snapshot).encode(), headers={"Content-Type": "application/json"}, method="POST")
        with urllib.request.urlopen(request, timeout=5) as response:
            response.read()


probe = Probe()
