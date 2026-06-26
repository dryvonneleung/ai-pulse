"""Scrape a figure from an arXiv PDF (Linux/Vercel version).

Extracts the largest embedded JPEG from the PDF bytes and re-encodes it to a
clean RGB PNG via Pillow (fixes CMYK JPEGs browsers won't render). Unlike the
local macOS server, there is no Quick Look first-page fallback, so papers whose
figures are all vector/PNG simply return 404 (the frontend hides the thumb).
"""

import base64
import io
import re
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler

from _lib import send_json

try:
    from PIL import Image
except Exception:  # noqa: BLE001
    Image = None

ID_RE = re.compile(r"[0-9]{4}\.[0-9]{4,5}(v[0-9]+)?")
_cache = {}


class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        params = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
        arxiv_id = (params.get("id", [""])[0]).strip()
        if not ID_RE.fullmatch(arxiv_id):
            send_json(self, {"error": "Invalid arXiv id."}, 400)
            return
        if arxiv_id in _cache:
            send_json(self, {"dataUrl": _cache[arxiv_id], "cached": True})
            return
        if Image is None:
            send_json(self, {"error": "Pillow not available."}, 500)
            return

        try:
            req = urllib.request.Request(
                f"https://arxiv.org/pdf/{arxiv_id}",
                headers={"User-Agent": "AI-Pulse/1.0"},
            )
            with urllib.request.urlopen(req, timeout=20) as resp:
                pdf = resp.read(12_000_000)
        except Exception as exc:  # noqa: BLE001
            send_json(self, {"error": f"PDF fetch failed: {exc}"}, 502)
            return

        png = extract_figure_png(pdf)
        if not png:
            send_json(self, {"error": "No image could be extracted."}, 404)
            return

        data_url = "data:image/png;base64," + base64.b64encode(png).decode()
        _cache[arxiv_id] = data_url
        send_json(self, {"dataUrl": data_url})


def extract_figure_png(pdf, min_bytes=20_000):
    """Largest embedded JPEG, re-encoded to RGB PNG. None if nothing usable."""
    jpegs, i = [], 0
    while True:
        start = pdf.find(b"\xff\xd8\xff", i)
        if start < 0:
            break
        end = pdf.find(b"\xff\xd9", start)
        if end < 0:
            break
        blob = pdf[start:end + 2]
        if len(blob) >= min_bytes:
            jpegs.append(blob)
        i = end + 2
    jpegs.sort(key=len, reverse=True)
    for blob in jpegs[:6]:
        try:
            im = Image.open(io.BytesIO(blob))
            im.load()
            im = im.convert("RGB")
            out = io.BytesIO()
            im.save(out, format="PNG")
            return out.getvalue()
        except Exception:  # noqa: BLE001
            continue
    return None
