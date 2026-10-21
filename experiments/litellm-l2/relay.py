"""透明 TCP 测试入口，不解析 HTTP、不缓冲完整响应、不重试。"""

import select
import socket
import socketserver
import threading


TARGETS = {4100: ("gateway", 4000), 4101: ("safe-gateway", 4000),
           4102: ("probe-gateway", 4000), 8080: ("upstream", 8080)}


class Handler(socketserver.BaseRequestHandler):
    def handle(self):
        try:
            remote = socket.create_connection(TARGETS[self.server.server_address[1]], timeout=3)
        except OSError:
            return
        with remote:
            sockets = [self.request, remote]
            while True:
                ready, _, _ = select.select(sockets, [], [], 30)
                if not ready:
                    return
                for source in ready:
                    try:
                        chunk = source.recv(65536)
                        if not chunk:
                            return
                        (remote if source is self.request else self.request).sendall(chunk)
                    except OSError:
                        return


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


for port in TARGETS:
    server = Server(("0.0.0.0", port), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
threading.Event().wait()
