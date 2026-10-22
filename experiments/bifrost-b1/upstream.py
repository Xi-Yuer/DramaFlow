"""OpenAI / Anthropic wire oracle；不保存 credential 原文。"""

import hashlib
import json
import re
import socket
import ssl
import struct
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

cases = {}
records = []
discovery_cases = {}
discovery_records = []
lock = threading.Lock()


def fingerprint(value):
    return hashlib.sha256(value.encode()).hexdigest()[:16] if value else None


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
            self.close_connection = True

    def do_GET(self):
        if self.path == "/__health":
            return self.reply(200, {"ok": True})
        if self.path == "/__records":
            with lock:
                return self.reply(200, {"requests": list(records), "discovery": list(discovery_records)})
        if self.path.split("?")[0] == "/v1/models":
            protocol = "anthropic" if self.headers.get("x-api-key") else "openai"
            credential = self.headers.get("x-api-key") or self.headers.get("Authorization", "").removeprefix("Bearer ")
            key = (protocol, fingerprint(credential))
            with lock:
                case = discovery_cases.get(key)
                if case:
                    discovery_records.append({"id": case["id"], "protocol": protocol, "credentialFingerprint": key[1], "host": self.headers.get("Host"), "path": self.path, "method": "GET"})
            if not case:
                return self.reply(200, {"object": "list", "data": []})
            if case["status"] != 200:
                return self.reply(case["status"], {"error": {"type": "permission_error", "message": "synthetic model access denied"}})
            if protocol == "openai":
                return self.reply(200, {"object": "list", "data": [{"id": "gpt-b1-listed-only", "object": "model", "created": 1, "owned_by": "synthetic"}]})
            return self.reply(200, {"data": [{"id": "claude-b1-listed-only", "type": "model", "display_name": "Synthetic reference", "created_at": "2026-01-01T00:00:00Z"}], "has_more": False, "first_id": "claude-b1-listed-only", "last_id": "claude-b1-listed-only"})
        if self.path.startswith("/target/"):
            return self.invoke(b"")
        # Gateway 启动或目录发现不冒充生成请求。
        return self.reply(200, {"object": "list", "data": []})

    def do_POST(self):
        content = self.rfile.read(int(self.headers.get("Content-Length", "0")))
        if self.path == "/__case":
            value = json.loads(content)
            with lock:
                cases[value["id"]] = value
            return self.reply(200, {"ok": True})
        if self.path == "/__discovery":
            value = json.loads(content)
            with lock:
                discovery_cases[(value["protocol"], value["credentialFingerprint"])] = value
            return self.reply(200, {"ok": True})
        return self.invoke(content)

    def invoke(self, content):
        body = json.loads(content) if content else {}
        target = self.path.startswith("/target/")
        match = re.search(rb"B1:([a-f0-9-]{36}):", content)
        case_id = self.path.split("/")[2] if target else match.group(1).decode() if match else None
        with lock:
            case = cases.get(case_id)
        if case is None:
            return self.reply(400, {"error": {"message": "unknown test invocation"}})
        credential = self.headers.get("x-api-key") or self.headers.get("Authorization", "").removeprefix("Bearer ")
        row = {"caseId": case_id, "protocol": case["protocol"], "target": target,
               "method": self.command, "host": self.headers.get("Host"), "path": self.path,
               "tls": isinstance(self.connection, ssl.SSLSocket), "connection": self.client_address[1],
               "credentialFingerprint": fingerprint(credential),
               "authorizationFingerprint": fingerprint(self.headers.get("Authorization", "").removeprefix("Bearer ")),
               "apiKeyFingerprint": fingerprint(self.headers.get("x-api-key", "")),
               "anthropicVersion": self.headers.get("anthropic-version"),
               "contentType": self.headers.get("Content-Type"),
               "gatewayHeaderForwarded": bool(self.headers.get("x-bf-vk") or self.headers.get("X-Bifrost-Setup-Token")),
               "model": body.get("model"), "bodySha256": hashlib.sha256(content).hexdigest(),
               "bodyIdentity": f"B1:{case_id}:" in content.decode(), "bodyBytes": len(content),
               "bodyKeys": sorted(body), "stream": body.get("stream", False), "generated": True}
        with lock:
            records.append(row)
            sequence = sum(x["caseId"] == case_id for x in records)
        scenario = case.get("scenario", "success")
        if not target and case.get("redirect"):
            return self.reply(case["redirect"], {"error": {"message": "redirect after generation"}}, {"Location": case["location"]})
        if scenario in ["400", "401", "403", "429", "500", "503"]:
            row["generated"] = False
            return self.reply(int(scenario), {"error": {"type": "rate_limit_error" if scenario == "429" else "api_error",
                "message": f"B1-PRIVATE-PROMPT credential={credential} endpoint={self.headers.get('Host')}{self.path}",
                "metadata": {"private": "B1-INTERNAL"}, "traceback": "B1-TRACEBACK /srv/private/provider.go"}},
                {"Retry-After": "2", "X-Provider-Private": "B1-PRIVATE-HEADER"})
        if scenario in ["tcp-rst", "tcp-rst-once"] and (scenario == "tcp-rst" or sequence == 1):
            self.close_connection = True
            self.connection.setsockopt(socket.SOL_SOCKET, socket.SO_LINGER, struct.pack("ii", 1, 0))
            self.connection.close()
            return
        if scenario in ["reset", "reset-once"] and (scenario == "reset" or sequence == 1):
            self.close_connection = True
            try:
                self.connection.shutdown(socket.SHUT_RDWR)
            except OSError:
                return
            return
        if scenario == "timeout":
            time.sleep(7.0)
        text = f"B1-OUTPUT:{case_id}"
        if scenario == "reflect-key":
            text = credential
        if case["protocol"] == "openai":
            response = {"id": case_id, "object": "chat.completion", "created": 1, "model": body.get("model", "b1"),
                "choices": [{"index": 0, "message": {"role": "assistant", "content": text}, "finish_reason": "stop"}],
                "usage": {"prompt_tokens": 2, "completion_tokens": 3, "total_tokens": 5}, "internal_metadata": "B1-INTERNAL"}
        else:
            response = {"id": case_id, "type": "message", "role": "assistant", "model": body.get("model", "b1"),
                "content": [{"type": "text", "text": text}], "stop_reason": "end_turn", "stop_sequence": None,
                "usage": {"input_tokens": 2, "output_tokens": 3}}
        if scenario == "malformed-schema":
            response = {"choices": [], "content": "invalid", "internal_metadata": "B1-INTERNAL"}
        if scenario in ["malformed-json", "partial-body"]:
            data = b'{"choices": not-json}' if scenario == "malformed-json" else json.dumps(response).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data if scenario == "malformed-json" else data[:10])
            self.wfile.flush()
            if scenario == "partial-body":
                self.close_connection = True
                self.connection.shutdown(socket.SHUT_RDWR)
            return
        return self.reply(200, response, {"X-Provider-Private": "B1-PRIVATE-HEADER"})


for port in [80, 443, 8080, 8081, 8443]:
    server = ThreadingHTTPServer(("0.0.0.0", port), Handler)
    server.daemon_threads = True
    if port in [443, 8443]:
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.load_cert_chain("/certs/server.crt", "/certs/server.key")
        server.socket = context.wrap_socket(server.socket, server_side=True)
    threading.Thread(target=server.serve_forever, daemon=True).start()
threading.Event().wait()
