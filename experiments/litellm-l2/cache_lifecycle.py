"""在固定官方镜像中调用实际 SDK cache；时间推进与禁用仅限此测试进程。"""

import asyncio
import gc
import hashlib
import importlib.metadata
import inspect
import json
import pathlib
import secrets
import weakref

import litellm
from litellm.llms.openai.openai import OpenAIChatCompletion
from litellm.llms.custom_httpx.http_handler import _DEFAULT_TTL_FOR_HTTPX_CLIENTS


async def main():
    gc.disable()  # 仅为稳定观察引用环；不建议生产关闭 GC。
    cache = litellm.in_memory_llm_clients_cache
    factory = OpenAIChatCompletion()
    key_a = "sk-l2-provider-a-" + secrets.token_hex(20)
    key_b = "sk-l2-provider-b-" + secrets.token_hex(20)
    args = {"is_async": True, "api_base": "http://upstream:8080/openai/v1", "timeout": 1.2, "max_retries": 0}
    first = factory._get_openai_client(api_key=key_a, **args)
    same = factory._get_openai_client(api_key=key_a, **args)
    other = factory._get_openai_client(api_key=key_b, **args)
    first.chat.completions  # 与真实调用相同，实例化持有 SDK client 的资源命名空间。
    key = next(name for name, value in cache.cache_dict.items() if value is first)
    assert first is same and first is not other
    report = {
        "cacheContainerDefaultTtl": cache.default_ttl,
        "sdkInsertionTtl": _DEFAULT_TTL_FOR_HTTPX_CLIENTS,
        "observedEntryTtl": round(cache.ttl_dict[key] - cache._clock(), 2),
        "capacity": cache.max_size_in_memory,
        "openaiSdkVersion": importlib.metadata.version("openai"),
        "sdkResourcesInitialized": True,
        "sameCredentialReusesClient": first is same,
        "differentCredentialSeparateClient": first is not other,
        "cacheKeyContainsRawCredential": key_a in key,
        "cacheKeyContainsCredentialHash": hashlib.sha256(key_a.encode()).hexdigest() in key,
    }
    # 真实代码路径但使用测试 clock，不等待一小时；没有修改生产镜像 / 正式配置。
    real_clock = cache._clock
    cache._clock = lambda: real_clock() + 3601
    report["expiredEntryStillReferencedBeforeAccess"] = key in cache.cache_dict
    assert cache.get_cache(key.removesuffix("-" + str(id(asyncio.get_running_loop())))) is None
    report["entryRemovedOnAccess"] = key not in cache.cache_dict
    report["expirationHeapStillReferencesRawCredential"] = any(key_a in entry[1] for entry in cache.expiration_heap)
    weak = weakref.ref(first)
    report["evictionClosesImmediately"] = first.is_closed()
    report["evictionGraceSeconds"] = cache.evicted_client_closer._grace_seconds
    original_closer_clock = cache.evicted_client_closer._clock
    cache.evicted_client_closer._clock = lambda: original_closer_clock() + 901
    cache.evicted_client_closer.reap()
    await asyncio.sleep(0.05)
    report["clientClosedAfterGraceAndReap"] = first.is_closed()
    report["closedClientStillHasApiKey"] = first.api_key == key_a
    del first, same
    report["gcDisabledOnlyForReachabilityProbe"] = True
    report["weakReferenceAliveBeforeExplicitGc"] = weak() is not None
    gc.collect()
    gc.enable()
    report["weakReferenceAliveAfterExplicitGc"] = weak() is not None
    report["cacheBookkeepingRetainsCredentialAfterClientGc"] = any(key_a in entry[1] for entry in cache.expiration_heap)
    # 私有对象字段确实能关闭插入，但这不是支持的 Gateway YAML 选项。
    cache.max_size_in_memory = 0
    fresh = factory._get_openai_client(api_key="sk-l2-provider-fresh-" + secrets.token_hex(20), **args)
    report["privateCapacityZeroPreventsInsertion"] = all(value is not fresh for value in cache.cache_dict.values())
    another = factory._get_openai_client(api_key=fresh.api_key, **args)
    report["privateDisableCreatesNewClientPerCall"] = fresh is not another
    await another.close()
    await fresh.close()
    await other.close()
    sources = [pathlib.Path(inspect.getfile(type(cache))), pathlib.Path(inspect.getfile(type(cache).__mro__[1])),
               pathlib.Path(inspect.getfile(type(cache.evicted_client_closer))),
               pathlib.Path(inspect.getfile(OpenAIChatCompletion)), pathlib.Path(inspect.getfile(OpenAIChatCompletion.__mro__[2]))]
    report["sourceSha256"] = {str(p).split("site-packages/")[-1]: hashlib.sha256(p.read_bytes()).hexdigest() for p in sources}
    assert report["entryRemovedOnAccess"] and report["clientClosedAfterGraceAndReap"]
    print(json.dumps(report))


asyncio.run(main())
