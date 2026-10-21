"""只处理合成测试凭证的本机协议服务，不是生产 Provider Adapter。"""

import json
import re
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


records = []
observations = []
unexpected_requests = []
lock = threading.Lock()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        # 请求头与异常测试中的合成凭证仅留在内存，不打印到 stdout。
        return

    def reply(self, status, value):
        body = json.dumps(value).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/__health":
            return self.reply(200, {"ok": True})
        if self.path == "/__records":
            with lock:
                return self.reply(200, {"requests": list(records), "observations": list(observations), "unexpectedRequests": list(unexpected_requests)})
        return self.reply(404, {"error": "unknown path"})

    def do_POST(self):
        length = int(self.headers.get("Content-Length", "0"))
        if length > 262144:
            return self.reply(413, {"error": "body too large"})
        try:
            body = json.loads(self.rfile.read(length))
        except (ValueError, UnicodeDecodeError):
            return self.reply(400, {"error": "invalid JSON"})
        if self.path == "/__observation":
            with lock:
                observations.append(body)
            return self.reply(200, {"ok": True})
        match = re.fullmatch(r"/(openai|anthropic)/(a|b)/(v1/chat/completions|v1/messages)", self.path)
        if not match:
            with lock:
                unexpected_requests.append({"path": self.path})
            return self.reply(404, {"error": "unexpected upstream protocol path"})
        protocol, account, suffix = match.groups()
        expected_suffix = "v1/chat/completions" if protocol == "openai" else "v1/messages"
        if suffix != expected_suffix:
            return self.reply(400, {"error": "wrong provider protocol"})
        credential = (
            self.headers.get("Authorization", "").removeprefix("Bearer ")
            if protocol == "openai"
            else self.headers.get("x-api-key", "")
        )
        raw_content = body.get("messages", [{}])[-1].get("content", "")
        prompt = raw_content if isinstance(raw_content, str) else "".join(
            item.get("text", "") for item in raw_content if isinstance(item, dict)
        )
        with lock:
            records.append({
                "protocol": protocol,
                "account": account,
                "path": self.path,
                "credential": credential,
                "authorization": self.headers.get("Authorization"),
                "anthropicVersion": self.headers.get("anthropic-version"),
                "body": body,
                "prompt": prompt,
                "receivedAt": time.monotonic(),
            })
        # 合成 key 带 account 标记；未知或错误账户必须拒绝。
        if not credential.startswith(f"sk-l1-provider-{account}-"):
            return self.reply(401, {"error": {"message": "synthetic credential rejected", "type": "authentication_error"}})
        if prompt.startswith("reflect-error-"):
            # 主动测试不可信上游在错误正文中反射 Secret 的情形。
            return self.reply(400, {"error": {
                "message": f"synthetic upstream reflected key={credential} endpoint={self.path}",
                "type": "invalid_request_error",
            }})
        time.sleep(0.015 + (sum(prompt.encode()) % 7) * 0.007)
        text = f"{protocol}:{account}:{prompt}"
        if protocol == "openai":
            return self.reply(200, {
                "id": "chatcmpl-l1-synthetic",
                "object": "chat.completion",
                "created": 1,
                "model": body["model"],
                "choices": [{"index": 0, "message": {"role": "assistant", "content": text}, "finish_reason": "stop"}],
                "usage": {"prompt_tokens": 4, "completion_tokens": 3, "total_tokens": 7},
            })
        if not self.headers.get("anthropic-version") or self.headers.get("Authorization"):
            return self.reply(400, {"error": {"message": "expected native Anthropic headers", "type": "invalid_request_error"}})
        if "max_tokens" not in body or "system" not in body:
            return self.reply(400, {"error": {"message": "expected native Anthropic body", "type": "invalid_request_error"}})
        return self.reply(200, {
            "id": "msg-l1-synthetic",
            "type": "message",
            "role": "assistant",
            "model": body["model"],
            "content": [{"type": "text", "text": text}],
            "stop_reason": "end_turn",
            "stop_sequence": None,
            "usage": {"input_tokens": 4, "output_tokens": 3},
        })


ThreadingHTTPServer(("0.0.0.0", 8080), Handler).serve_forever()
