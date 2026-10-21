"""实验用普通 forward proxy：不 follow、不 retry；CONNECT 不解密 TLS。"""

import http.client
import json
import select
import socket
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

HOP = {"connection", "proxy-connection", "keep-alive", "transfer-encoding", "upgrade", "proxy-authorization"}


def observe(method, target):
    request = urllib.request.Request("http://upstream:8080/__observation",
        data=json.dumps({"kind": "forward-transport", "method": method, "target": target}).encode(),
        headers={"Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(request, timeout=3) as response:
        response.read()


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):
        return

    def do_CONNECT(self):
        host, port = self.path.rsplit(":", 1)
        if host not in {"upstream", "other-host"} or int(port) not in {443, 8443}:
            self.send_error(403)
            return
        with socket.create_connection((host, int(port)), timeout=5) as remote:
            observe("CONNECT", self.path)
            self.send_response(200, "Connection established")
            self.end_headers()
            while True:
                ready, _, _ = select.select([self.connection, remote], [], [], 10)
                if not ready:
                    break
                for source in ready:
                    content = source.recv(65536)
                    if not content:
                        return
                    (remote if source is self.connection else self.connection).sendall(content)

    def forward(self):
        url = urlsplit(self.path)
        if url.scheme != "http" or url.hostname not in {"upstream", "other-host"} or url.port not in {80, 8080, 8081}:
            self.send_error(403)
            return
        body = self.rfile.read(int(self.headers.get("Content-Length", "0")))
        headers = {key: value for key, value in self.headers.items() if key.lower() not in HOP}
        connection = http.client.HTTPConnection(url.hostname, url.port, timeout=5)
        try:
            observe(self.command, self.path)
            connection.request(self.command, url.path + ("?" + url.query if url.query else ""), body=body, headers=headers)
            response = connection.getresponse()
            content = response.read()
            self.send_response(response.status)
            for key, value in response.getheaders():
                if key.lower() not in HOP | {"content-length"}:
                    self.send_header(key, value)
            self.send_header("Content-Length", str(len(content)))
            self.end_headers()
            self.wfile.write(content)
        finally:
            connection.close()

    do_POST = forward
    do_GET = forward


ThreadingHTTPServer(("0.0.0.0", 8888), Handler).serve_forever()
