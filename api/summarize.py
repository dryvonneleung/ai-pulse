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


def fetch_article_text(url):
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "AI-Pulse/1.0"})
        with urllib.request.urlopen(req, timeout=6) as resp:
            ctype = resp.headers.get("Content-Type", "")
            if "html" not in ctype and "text" not in ctype:
                return ""
            raw = resp.read(200_000).decode("utf-8", "ignore")
    except Exception:  # noqa: BLE001
        return ""
    raw = re.sub(r"(?is)<(script|style|head).*?</\1>", " ", raw)
    text = re.sub(r"(?s)<[^>]+>", " ", raw)
    return re.sub(r"\s+", " ", text).strip()


class handler(BaseHTTPRequestHandler):
    def do_POST(self):
        if not NVIDIA_API_KEY:
            send_json(self, {"error": "AI summaries disabled (no NVIDIA_API_KEY set)."}, 503)
            return
        try:
            length = int(self.headers.get("Content-Length", 0))
            payload = json.loads(self.rfile.read(length) or b"{}")
        except Exception:  # noqa: BLE001
            send_json(self, {"error": "Invalid request body."}, 400)
            return

        title = (payload.get("title") or "").strip()[:300]
        url = (payload.get("url") or "").strip()
        text = (payload.get("text") or "").strip()
        if not title:
            send_json(self, {"error": "Missing title."}, 400)
            return

        if text:
            prompt = (
                "Summarize this research paper in 1-2 plain-English sentences for a "
                "non-expert newsletter reader: what it does and why it matters. Output "
                "only the summary, no preamble.\n\n"
                f"Title: {title}\n\nAbstract:\n{text[:4000]}\n"
            )
        else:
            article = fetch_article_text(url) if url.startswith("http") else ""
            prompt = (
                "Write a concise 1-2 sentence summary of this AI/tech news story for a "
                "newsletter reader. Base it on the headline. If the excerpt below contains "
                "readable article prose, use it for extra detail; if the excerpt is empty or "
                "looks like code/markup, just summarize from the headline. Output only the "
                "summary itself — no preamble, and never mention the excerpt, code, or markup.\n\n"
                f"Headline: {title}\n"
            )
            if article:
                prompt += f"\nExcerpt:\n{article[:3000]}\n"

        try:
            summary = call_nvidia(prompt)
        except Exception as exc:  # noqa: BLE001
            send_json(self, {"error": f"Summary failed: {exc}"}, 502)
            return
        send_json(self, {"summary": summary})
