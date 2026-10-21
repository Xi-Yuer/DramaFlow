"""观察真实调用栈；可选注入官方文档公开的 OpenAI aclient_session。"""

import importlib.metadata
import json
import os
import sys
import urllib.request

import httpx
import litellm
from litellm.integrations.custom_logger import CustomLogger

if os.environ.get("L21_CUSTOM_SESSION") == "1":
    # 正式文档公开的全局注入；不修改 SDK 私有字段，不更换 Provider。
    litellm.aclient_session = httpx.AsyncClient(follow_redirects=False, verify="/certs/server.crt")


class Probe(CustomLogger):
    def __init__(self):
        self.rows = {}
        self.case_id = None

    def profile(self, frame, event, arg):
        if event != "call":
            return
        file = frame.f_code.co_filename
        function = frame.f_code.co_name
        selected = ("litellm/llms/" in file and function in {"acompletion", "acompletion_function", "async_completion", "_acompletion", "post", "_get_openai_client", "_get_async_http_client", "get_async_httpx_client"})
        selected = selected or ("httpx/_client.py" in file and function in {"send", "_send_handling_redirects", "_send_single_request"})
        selected = selected or ("aiohttp_transport.py" in file and function == "handle_async_request")
        selected = selected or ("aiohttp/client.py" in file and function == "_request")
        selected = selected or ("openai/_base_client.py" in file and function == "request")
        if not selected:
            return
        owner = frame.f_locals.get("self")
        row = {"file": file.split("site-packages/")[-1], "function": function,
               "line": frame.f_code.co_firstlineno,
               "owner": type(owner).__module__ + "." + type(owner).__name__ if owner is not None else None}
        if isinstance(owner, httpx.AsyncClient):
            row["clientFollowRedirects"] = owner.follow_redirects
            row["transport"] = type(owner._transport).__module__ + "." + type(owner._transport).__name__
        if type(owner).__module__ == "openai" and hasattr(owner, "max_retries"):
            row["sdkMaxRetries"] = owner.max_retries
        for name in ["follow_redirects", "allow_redirects"]:
            if isinstance(frame.f_locals.get(name), bool):
                row[name] = frame.f_locals[name]
        self.rows[json.dumps(row, sort_keys=True)] = row

    async def async_pre_call_hook(self, user_api_key_dict, cache, data, call_type):
        if data.get("metadata", {}).get("l21_probe"):
            self.rows = {}
            self.case_id = data["messages"][-1]["content"]
            sys.setprofile(self.profile)
        return data

    def publish(self):
        if self.case_id is None:
            return
        sys.setprofile(None)
        value = {"kind": "runtime-call-chain", "caseId": self.case_id, "frames": list(self.rows.values()),
                 "versions": {name: importlib.metadata.version(name) for name in ["litellm", "httpx", "httpcore", "aiohttp", "openai"]}}
        self.case_id = None
        request = urllib.request.Request("http://upstream:8080/__observation", data=json.dumps(value).encode(),
                                         headers={"Content-Type": "application/json"}, method="POST")
        # 绕过实验 HTTP_PROXY，仅投递不含 Secret 的观察值。
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        with opener.open(request, timeout=5) as response:
            response.read()

    async def async_log_success_event(self, kwargs, response_obj, start_time, end_time):
        self.publish()

    async def async_log_failure_event(self, kwargs, response_obj, start_time, end_time):
        self.publish()


probe = Probe()
