from http.server import BaseHTTPRequestHandler

from _lib import NVIDIA_API_KEY, NVIDIA_MODEL, send_json


class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        send_json(self, {"enabled": bool(NVIDIA_API_KEY), "model": NVIDIA_MODEL})
