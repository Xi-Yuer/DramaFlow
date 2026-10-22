"""在无宿主端口的测试网络内执行；每种 VK 情况只发起一次 POST。"""

import http.client
import json
import sys
import time
import uuid

secret = json.load(sys.stdin)


def request(host, port, method, path, body=None, headers=None):
    connection = http.client.HTTPConnection(host, port, timeout=5)
    try:
        connection.request(method, path, body=body, headers=headers or {})
        response = connection.getresponse()
        return response.status, response.read()
    finally:
        connection.close()


for attempt in range(100):
    try:
        if request("gateway", 8080, "GET", "/health")[0] == 200:
            break
    except OSError:
        pass
    time.sleep(0.2)
else:
    raise RuntimeError("Gateway 未就绪")

results = []
for name, vk in [("missing", None), ("empty", ""), ("invalid", "sk-bf-b11-invalid")]:
    identity = str(uuid.uuid4())
    headers = {
        "Content-Type": "application/json",
        "x-bf-direct-key": "true",
        "x-api-key": secret["providerKey"],
    }
    if vk is not None:
        headers["x-bf-vk"] = vk
    status, raw = request("gateway", 8080, "POST", "/v1/chat/completions", json.dumps({
        "model": "openai/gpt-b11-auth",
        "messages": [{"role": "user", "content": identity}],
        "max_tokens": 1,
        "stream": False,
    }), headers)
    oracle = json.loads(request("upstream", 8081, "GET", "/records")[1])
    results.append({
        "case": name,
        "id": identity,
        "gatewayStatus": status,
        "generationPosts": oracle["records"].count(identity),
    })

print(json.dumps({"cases": results}))
