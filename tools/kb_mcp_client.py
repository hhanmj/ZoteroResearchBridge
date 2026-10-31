#!/usr/bin/env python3
"""Team KB (kb.cstcloud.cn) MCP client over SSE transport.

Usage:
  python kb_mcp_client.py tools/list
  python kb_mcp_client.py tools/call <tool_name> '<json-args>'
"""
import http.client
import json
import os
import queue
import ssl
import sys
import threading
import time

HOST = "kb.cstcloud.cn"
SSE_PATH = "/kbmcp/v1/sse"
KEY_FILE = os.path.expanduser("~/.zrb-secrets/kb-mcp-authkey.txt")


def load_key():
    return open(KEY_FILE, encoding="utf-8").read().strip()


class KBMCP:
    def __init__(self):
        self.ctx = ssl.create_default_context()
        self.conn = http.client.HTTPSConnection(HOST, timeout=60, context=self.ctx)
        self.key = load_key()
        self.q = queue.Queue()
        self.endpoint = None
        self._stop = False

    def _sse_reader(self):
        try:
            resp = self.conn.getresponse()
            if resp.status != 200:
                self.q.put(("http_error", resp.status, resp.read(300)))
                return
            event = None
            while True:
                line = resp.readline()
                if not line:
                    break
                line = line.decode("utf-8", "replace").rstrip("\r\n")
                if line.startswith("event:"):
                    event = line[6:].strip()
                elif line.startswith("data:"):
                    data = line[5:].strip()
                    if event == "endpoint":
                        self.endpoint = data
                        self.q.put(("endpoint", data))
                    elif event in (None, "message"):
                        self.q.put(("message", data))
        except Exception as e:  # noqa: BLE001
            self.q.put(("exception", repr(e)))

    def connect(self, timeout=30):
        # GET SSE with Bearer auth
        self.conn.request("GET", SSE_PATH, headers={
            "Authorization": f"Bearer {self.key}",
            "Accept": "text/event-stream",
        })
        t = threading.Thread(target=self._sse_reader, daemon=True)
        t.start()
        deadline = time.time() + timeout
        while time.time() < deadline:
            try:
                item = self.q.get(timeout=1)
            except queue.Empty:
                continue
            if item[0] == "endpoint":
                return
            if item[0] in ("http_error", "exception"):
                raise RuntimeError(f"SSE connect failed: {item}")
        raise TimeoutError("no endpoint event")

    def post(self, payload):
        path = self.endpoint
        if path.startswith("http"):
            from urllib.parse import urlparse
            path = urlparse(path).path + ("?" + urlparse(path).query if urlparse(path).query else "")
        c = http.client.HTTPSConnection(HOST, timeout=30, context=self.ctx)
        body = json.dumps(payload)
        c.request("POST", path, body=body, headers={
            "Authorization": f"Bearer {self.key}",
            "Content-Type": "application/json",
            "Content-Length": str(len(body)),
        })
        r = c.getresponse()
        data = r.read()
        c.close()
        return r.status, data

    def rpc(self, method, params=None, msg_id=None, timeout=60):
        payload = {"jsonrpc": "2.0", "method": method}
        if params is not None:
            payload["params"] = params
        notify = msg_id is None
        if not notify:
            payload["id"] = msg_id
        status, data = self.post(payload)
        if status not in (200, 202):
            raise RuntimeError(f"POST {method} -> HTTP {status}: {data[:200]}")
        if notify:
            return None
        deadline = time.time() + timeout
        while time.time() < deadline:
            try:
                item = self.q.get(timeout=1)
            except queue.Empty:
                continue
            if item[0] == "message":
                try:
                    d = json.loads(item[1])
                except json.JSONDecodeError:
                    continue
                if d.get("id") == msg_id:
                    return d
            elif item[0] in ("exception", "http_error"):
                raise RuntimeError(f"stream broke: {item}")
        raise TimeoutError(f"no response to {method} id={msg_id}")

    def close(self):
        try:
            self.conn.close()
        except Exception:  # noqa: BLE001
            pass


def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else "ping"
    c = KBMCP()
    c.connect()
    try:
        if mode == "ping":
            print("connected. endpoint =", c.endpoint)
        elif mode == "tools/list":
            c.rpc("initialize", {
                "protocolVersion": "2025-03-26", "capabilities": {},
                "clientInfo": {"name": "zrb-p0", "version": "0.1"}}, msg_id=1)
            c.rpc("notifications/initialized", None)
            r = c.rpc("tools/list", {}, msg_id=2)
            tools = r.get("result", {}).get("tools", [])
            for t in tools:
                print("=" * 12, t["name"])
                print((t.get("description") or "")[:400])
                print("schema:", json.dumps(t.get("inputSchema", {}), ensure_ascii=False)[:500])
        elif mode == "tools/call":
            tool = sys.argv[2]
            args = json.loads(sys.argv[3]) if len(sys.argv) > 3 else {}
            c.rpc("initialize", {
                "protocolVersion": "2025-03-26", "capabilities": {},
                "clientInfo": {"name": "zrb-p0", "version": "0.1"}}, msg_id=1)
            c.rpc("notifications/initialized", None)
            r = c.rpc("tools/call", {"name": tool, "arguments": args}, msg_id=99, timeout=120)
            print(json.dumps(r, ensure_ascii=False, indent=1)[:6000])
    finally:
        c.close()


if __name__ == "__main__":
    main()
