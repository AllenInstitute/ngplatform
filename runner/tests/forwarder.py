"""A TCP forwarder that stands in for ``ssh -L LOCAL:127.0.0.1:REMOTE``: ``python forwarder.py LOCAL REMOTE``.

Like ssh, it accepts a connection on 127.0.0.1:LOCAL even when nothing
listens on REMOTE, and then closes it.
"""

from __future__ import annotations

import signal
import socket
import sys
import threading


def _pump(source: socket.socket, sink: socket.socket) -> None:
    try:
        while True:
            data = source.recv(1 << 16)
            if not data:
                break
            sink.sendall(data)
    except OSError:
        pass
    finally:
        for s in (sink, source):
            try:
                s.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass


class Forwarder:
    def __init__(self, local_port: int, remote_port: int):
        self.remote_port = remote_port
        self.listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self.listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self.listener.bind(("127.0.0.1", local_port))
        self.listener.listen(64)
        self.port = self.listener.getsockname()[1]
        self.thread = threading.Thread(target=self.serve, daemon=True)

    def start(self) -> "Forwarder":
        self.thread.start()
        return self

    def serve(self) -> None:
        while True:
            try:
                client, _ = self.listener.accept()
            except OSError:
                return
            try:
                upstream = socket.create_connection(("127.0.0.1", self.remote_port), timeout=5)
                upstream.settimeout(None)
            except OSError:
                client.close()
                continue
            threading.Thread(target=_pump, args=(client, upstream), daemon=True).start()
            threading.Thread(target=_pump, args=(upstream, client), daemon=True).start()

    def close(self) -> None:
        try:
            self.listener.close()
        except OSError:
            pass


def main(argv: list[str]) -> int:
    forwarder = Forwarder(int(argv[0]), int(argv[1]))
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
    print(f"forwarding 127.0.0.1:{forwarder.port} to 127.0.0.1:{forwarder.remote_port}", flush=True)
    forwarder.serve()
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
