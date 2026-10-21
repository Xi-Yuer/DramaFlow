"""仅供重定向准入实验；oracle 不保存完整 credential。"""

import hashlib
import json
import ssl
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

cases = {}
records = []
observations = []
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
        self.wfile.write(content)

    def do_GET(self):
        if self.path == "/__records":
            with lock:
                return self.reply(200, {"requests": list(records), "observations": list(observations)})
        if self.path == "/__health":
            return self.reply(200, {"ok": True})
        return self.invoke(b"")

    def do_POST(self):
        content = self.rfile.read(int(self.headers.get("Content-Length", "0")))
        if self.path == "/__case":
            value = json.loads(content)
            with lock:
                cases[value["id"]] = value
            return self.reply(200, {"ok": True})
        if self.path == "/__observation":
            with lock:
                observations.append(json.loads(content))
            return self.reply(200, {"ok": True})
        return self.invoke(content)

    def invoke(self, content):
        parts = urlsplit(self.path).path.strip("/").split("/")
        target = parts[0] == "target"
        case_id = parts[1] if target else parts[0]
        with lock:
            case = cases.get(case_id)
        if case is None:
            return self.reply(404, {"error": {"message": "unknown test case"}})
        auth = self.headers.get("Authorization", "")
        row = {"caseId": case_id, "target": target, "method": self.command,
               "host": self.headers.get("Host"), "path": self.path,
               "tls": isinstance(self.connection, ssl.SSLSocket),
               "authorizationFingerprint": fingerprint(auth.removeprefix("Bearer ")),
               "apiKeyFingerprint": fingerprint(self.headers.get("x-api-key", "")),
               "bodyBytes": len(content), "bodySha256": hashlib.sha256(content).hexdigest(),
               "generated": self.command == "POST"}
        with lock:
            records.append(row)
        if not target and case["status"] != 200:
            return self.reply(case["status"], {"error": {"message": "synthetic redirect after accepting POST"}},
                              {"Location": case["location"]})
        if case["protocol"] == "openai":
            value = {"id": "synthetic", "object": "chat.completion", "created": 1, "model": "l21-model",
                     "choices": [{"index": 0, "message": {"role": "assistant", "content": "L21-OUTPUT"}, "finish_reason": "stop"}],
                     "usage": {"prompt_tokens": 2, "completion_tokens": 3, "total_tokens": 5}}
        else:
            value = {"id": "synthetic", "type": "message", "role": "assistant", "model": "l21-model",
                     "content": [{"type": "text", "text": "L21-OUTPUT"}], "stop_reason": "end_turn",
                     "usage": {"input_tokens": 2, "output_tokens": 3}}
        return self.reply(200, value)


for port in [80, 443, 8080, 8081, 8443]:
    server = ThreadingHTTPServer(("0.0.0.0", port), Handler)
    server.daemon_threads = True
    if port in [443, 8443]:
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.load_cert_chain("/certs/server.crt", "/certs/server.key")
        server.socket = context.wrap_socket(server.socket, server_side=True)
    threading.Thread(target=server.serve_forever, daemon=True).start()
threading.Event().wait()
