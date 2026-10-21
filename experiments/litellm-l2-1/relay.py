"""仅暴露隔离实验的 TCP 入口；不处理 HTTP redirect。"""

import select
import socket
import socketserver
import threading

TARGETS = {4100: ("gateway", 4000), 4101: ("injected-gateway", 4000),
           4102: ("forward-gateway", 4000), 4103: ("httpx-gateway", 4000), 8080: ("upstream", 8080)}


class Handler(socketserver.BaseRequestHandler):
    def handle(self):
        try:
            remote = socket.create_connection(TARGETS[self.server.server_address[1]], timeout=3)
        except OSError:
            return
        with remote:
            while True:
                ready, _, _ = select.select([self.request, remote], [], [], 15)
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
