import json
import os
import re
import urllib.request
from http.server import BaseHTTPRequestHandler

NVIDIA_API_KEY = os.environ.get("NVIDIA_API_KEY", "").strip()
NVIDIA_URL = "https://integrate.api.nvidia.com/v1/chat/completions"
NVIDIA_MODEL = os.environ.get("NVIDIA_MODEL", "meta/llama-3.1-8b-instruct")


def send_json(h, obj, status=200):
    body = json.dumps(obj).encode("utf-8")
    h.send_response(status)
    h.send_header("Content-Type", "application/json; charset=utf-8")
    h.send_header("Content-Length", str(len(body)))
    h.end_headers()
    h.wfile.write(body)


def call_nvidia(prompt, max_tokens=1024, temperature=0.3):
    body = json.dumps({
        "model": NVIDIA_MODEL,
        "messages": [{"role": "user", "content": prompt}],
        "temperature": temperature,
        "max_tokens": max_tokens,
    }).encode("utf-8")
    req = urllib.request.Request(
        NVIDIA_URL, data=body,
        headers={
            "Authorization": f"Bearer {NVIDIA_API_KEY}",
            "Content-Type": "application/json",
            "Accept": "application/json",
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=55) as resp:
        data = json.loads(resp.read())
    content = data["choices"][0]["message"].get("content", "") or ""
    content = re.sub(r"(?is)<think>.*?</think>", "", content)
    content = re.sub(r"(?is)^.*?</think>", "", content)
    return content.strip()


class handler(BaseHTTPRequestHandler):
    def do_POST(self):
        if not NVIDIA_API_KEY:
            send_json(self, {"error": "Scoring disabled (no NVIDIA_API_KEY set)."}, 503)
            return
        try:
            length = int(self.headers.get("Content-Length", 0))
            payload = json.loads(self.rfile.read(length) or b"{}")
        except Exception:  # noqa: BLE001
            send_json(self, {"error": "Invalid request body."}, 400)
            return

        items = payload.get("items")
        if items is None:
            items = [{"title": h} for h in (payload.get("headlines") or [])]
        items = items[:50]
        if not items:
            send_json(self, {"error": "No items."}, 400)
            return

        def line(i, it):
            title = str(it.get("title") or "")[:200]
            summary = str(it.get("summary") or "")[:400]
            return f"{i + 1}. {title}" + (f" — Summary: {summary}" if summary else "")

        numbered = "\n".join(line(i, it) for i, it in enumerate(items))
        prompt = (
            "Score each AI/tech news item on two axes, each from 0.0 to 1.0. "
            "Each item is a headline, plus a short summary when provided — when a "
            "summary is given, use it as the primary basis for your scores.\n"
            "- p (predictability): 0 = highly uncertain/speculative/open question, "
            "1 = predictable/expected/established.\n"
            "- s (sentiment): 0 = very negative/concerning, 1 = very positive/optimistic.\n"
            "Be decisive and use the FULL range (e.g. 0.1, 0.25, 0.4, 0.7, 0.9). "
            "Most items clearly lean one way — do NOT default to 0.5; reserve "
            "0.5 only for genuinely neutral cases.\n"
            "Return ONLY a JSON array with one [p, s] pair per item, in order, "
            "no prose. Example: [[0.85,0.6],[0.3,0.15]]\n\n"
            f"Items:\n{numbered}\n"
        )
        try:
            text = call_nvidia(prompt, max_tokens=1200, temperature=0.6)
            match = re.search(r"\[.*\]", text, re.S)
            scores = json.loads(match.group()) if match else None
            if not isinstance(scores, list):
                raise ValueError("not a list")
            cleaned = []
            for pair in scores:
                p = min(1.0, max(0.0, float(pair[0])))
                s = min(1.0, max(0.0, float(pair[1])))
                cleaned.append([round(p, 3), round(s, 3)])
        except Exception as exc:  # noqa: BLE001
            send_json(self, {"error": f"Scoring failed: {exc}"}, 502)
            return
        send_json(self, {"scores": cleaned})
