"""故障 oracle 只供测试驱动核对；正式协议不能读取这里的真实受理状态。"""

import json
import socket
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


records = []
observations = []
lock = threading.Lock()


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):
        return

    def reply(self, status, value, headers=None):
        content = json.dumps(value).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(content)))
        for key, value in (headers or {}).items():
            self.send_header(key, value)
        self.end_headers()
        try:
            self.wfile.write(content)
        except (BrokenPipeError, ConnectionResetError):
            # deadline 测试允许调用者先离开；oracle 中保留真实生成状态。
            self.close_connection = True

    def do_GET(self):
        if self.path == "/__health":
            return self.reply(200, {"ok": True})
        if self.path == "/__records":
            with lock:
                return self.reply(200, {"requests": list(records), "observations": list(observations)})
        return self.reply(404, {"error": "unknown test route"})

    def disconnect(self):
        self.close_connection = True
        try:
            self.connection.shutdown(socket.SHUT_RDWR)
        except OSError:
            return

    def do_POST(self):
        try:
            body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", "0"))))
        except (ValueError, UnicodeDecodeError):
            return self.reply(400, {"error": "invalid JSON"})
        if self.path == "/__observation":
            with lock:
                observations.append(body)
            return self.reply(200, {"ok": True})
        if self.path == "/__gateway-header-stall":
            # 单独检验 Worker 完整 body deadline；不冒充真实 LiteLLM 响应。
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", "1000")
            self.end_headers()
            self.wfile.write(b'{"choices":[')
            self.wfile.flush()
            time.sleep(3)
            return self.disconnect()
        normalized_path = self.path.removeprefix("/redirect")
        protocol = "anthropic" if normalized_path == "/anthropic/v1/messages" else "openai"
        if normalized_path not in {"/openai/v1/chat/completions", "/anthropic/v1/messages"}:
            return self.reply(404, {"error": "unexpected upstream path"})
        message = body.get("messages", [{}])[-1].get("content", "")
        prompt = message if isinstance(message, str) else "".join(x.get("text", "") for x in message)
        _, case_id, scenario = prompt.split(":", 2)
        credential = self.headers.get("x-api-key", "") if protocol == "anthropic" else self.headers.get("Authorization", "").removeprefix("Bearer ")
        row = {"caseId": case_id, "scenario": scenario, "protocol": protocol,
               "credential": credential, "accepted": True, "generated": False,
               "peerPort": self.client_address[1], "stream": body.get("stream", False), "redirected": self.path.startswith("/redirect/")}
        with lock:
            records.append(row)
        if scenario == "redirect307" and not row["redirected"]:
            row["generated"] = True
            return self.reply(307, {"error": "synthetic redirect after generation"}, {"Location": "/redirect" + normalized_path})
        statuses = {"400": (400, "invalid_request_error"), "401": (401, "authentication_error"),
                    "403": (403, "permission_error"), "429": (429, "rate_limit_error"),
                    "500": (500, "server_error"), "503": (503, "server_error")}
        if scenario in statuses:
            status, kind = statuses[scenario]
            unsafe = {"message": f"L2-PRIVATE-BODY {prompt} credential={credential} endpoint={self.path}",
                      "type": kind, "code": f"synthetic_{status}", "traceback": "L2-TRACEBACK /app/private/provider.py",
                      "metadata": {"private": "L2-INTERNAL-METADATA"}}
            return self.reply(status, {"error": unsafe}, {"Retry-After": "2", "x-provider-private": "L2-PRIVATE-HEADER"})
        if scenario == "500-after-generation":
            row["generated"] = True
            return self.reply(500, {"error": {"message": "result generated but delivery failed", "type": "server_error"}})
        if scenario == "context-limit":
            return self.reply(400, {"error": {"message": "This model maximum context length is 4096 tokens. Your messages exceed the context length.", "type": "invalid_request_error", "code": "context_length_exceeded"}})
        if scenario == "content-policy":
            return self.reply(400, {"error": {"message": "content policy violation", "type": "content_policy_violation", "code": "content_filter"}})
        if scenario == "unprocessable":
            return self.reply(422, {"error": {"message": "Unsupported parameter: temperature", "type": "invalid_request_error"}})
        if scenario == "disconnect-after-accept":
            return self.disconnect()
        if scenario == "timeout-before-result":
            time.sleep(3)
        if scenario == "timeout-after-result":
            row["generated"] = True
            time.sleep(3)
        if scenario == "worker-deadline":
            time.sleep(1)
        row["generated"] = True
        if protocol == "openai":
            response = {"id": "synthetic", "object": "chat.completion", "created": 1, "model": body["model"],
                        "choices": [{"index": 0, "message": {"role": "assistant", "content": "L2-SYNTHETIC-OUTPUT"}, "finish_reason": "stop"}],
                        "usage": {"prompt_tokens": 2, "completion_tokens": 3, "total_tokens": 5},
                        "internal_metadata": {"private": "L2-INTERNAL-METADATA"}}
        else:
            response = {"id": "synthetic", "type": "message", "role": "assistant", "model": body["model"],
                        "content": [{"type": "text", "text": "L2-SYNTHETIC-OUTPUT"}], "stop_reason": "end_turn",
                        "usage": {"input_tokens": 2, "output_tokens": 3}}
        if scenario == "reflect-key-success":
            if protocol == "openai":
                response["choices"][0]["message"]["content"] = "L2 reflected credential " + credential
            else:
                response["content"][0]["text"] = "L2 reflected credential " + credential
        if scenario == "malformed-json":
            content = b'{"choices": this is not JSON}'
        elif scenario == "malformed-schema":
            content = json.dumps({"id": "synthetic", "choices": []}).encode()
        else:
            content = json.dumps(response).encode()
        if scenario == "partial-disconnect":
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(content)))
            self.end_headers()
            self.wfile.write(content[:len(content) // 2])
            self.wfile.flush()
            return self.disconnect()
        if scenario == "partial-stall":
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(content)))
            self.end_headers()
            try:
                self.wfile.write(content[:10])
                self.wfile.flush()
                time.sleep(3)
                self.wfile.write(content[10:])
            except (BrokenPipeError, ConnectionResetError):
                self.close_connection = True
            return
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(content)))
        self.send_header("x-provider-private", "L2-PRIVATE-HEADER")
        self.end_headers()
        try:
            self.wfile.write(content)
        except (BrokenPipeError, ConnectionResetError):
            self.close_connection = True


ThreadingHTTPServer(("0.0.0.0", 8080), Handler).serve_forever()
