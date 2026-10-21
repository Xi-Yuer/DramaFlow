"""仅为宿主测试驱动提供固定目标转发，不执行任何 AI 协议转换或重试。"""

import http.client
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


targets = {4000: ("gateway", 4000), 4001: ("gateway-debug", 4000),
           4002: ("gateway-cache", 4000), 8080: ("upstream", 8080)}
hop_headers = {"host", "connection", "transfer-encoding", "content-length"}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        return

    def forward(self):
        body = self.rfile.read(int(self.headers.get("Content-Length", "0")))
        headers = {key: value for key, value in self.headers.items() if key.lower() not in hop_headers}
        connection = http.client.HTTPConnection(*targets[self.server.server_port], timeout=35)
        try:
            connection.request(self.command, self.path, body=body, headers=headers)
            response = connection.getresponse()
            content = response.read()
            self.send_response(response.status)
            for key, value in response.getheaders():
                if key.lower() not in hop_headers:
                    self.send_header(key, value)
        except (OSError, http.client.HTTPException):
            content = b'{"error":"test relay target not ready"}'
            self.send_response(502)
        finally:
            connection.close()
        self.send_header("Content-Length", str(len(content)))
        self.end_headers()
        self.wfile.write(content)

    do_GET = forward
    do_POST = forward


for port in targets:
    server = ThreadingHTTPServer(("0.0.0.0", port), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
threading.Event().wait()
