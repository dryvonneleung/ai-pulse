from http.server import BaseHTTPRequestHandler

from _lib import NVIDIA_API_KEY, call_nvidia, fetch_article_text, read_json, send_json


class handler(BaseHTTPRequestHandler):
    def do_POST(self):
        if not NVIDIA_API_KEY:
            send_json(self, {"error": "AI summaries disabled (no NVIDIA_API_KEY set)."}, 503)
            return
        try:
            payload = read_json(self)
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
