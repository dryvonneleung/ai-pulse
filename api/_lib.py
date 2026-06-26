"""Shared helpers for the Vercel serverless API functions.

On Vercel, secrets come from the project's Environment Variables (not .env).
Each route lives in its own api/<name>.py file and imports from here.
"""

import json
import os
import re
import urllib.request

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


def read_json(h):
    length = int(h.headers.get("Content-Length", 0))
    return json.loads(h.rfile.read(length) or b"{}")


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
    # Reasoning models may wrap thinking in <think>...</think>; keep the answer.
    content = re.sub(r"(?is)<think>.*?</think>", "", content)
    content = re.sub(r"(?is)^.*?</think>", "", content)
    return content.strip()


def fetch_article_text(url):
    """Best-effort: fetch a page and strip tags to plain-ish text."""
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "AI-Pulse/1.0"})
        # Keep short so summarize fits within Vercel's default function timeout.
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
