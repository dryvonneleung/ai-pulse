import json
import os
from http.server import BaseHTTPRequestHandler

NVIDIA_API_KEY = os.environ.get("NVIDIA_API_KEY", "").strip()
NVIDIA_MODEL = os.environ.get("NVIDIA_MODEL", "meta/llama-3.1-8b-instruct")


class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        body = json.dumps({"enabled": bool(NVIDIA_API_KEY), "model": NVIDIA_MODEL}).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)
