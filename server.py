#!/usr/bin/env python3
"""AI Pulse dev server.

Serves the static site and proxies the arXiv API on a same-origin path
(/api/arxiv) so the browser isn't blocked by arXiv's missing CORS headers.
Hacker News' API already sends CORS headers, so news is fetched directly.
"""

import base64
import http.server
import json
import os
import re
import subprocess
import tempfile
import urllib.parse
import urllib.request

PORT = 8000
ALLOWED_CATEGORIES = {"cs.AI", "cs.LG", "cs.CL", "cs.CV", "stat.ML"}


def load_dotenv(path=".env"):
    """Minimal .env loader so secrets stay out of source files."""
    if not os.path.exists(path):
        return
    with open(path, encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, val = line.partition("=")
            os.environ.setdefault(key.strip(), val.strip().strip('"').strip("'"))


load_dotenv()

# Free NVIDIA NIM inference endpoint (OpenAI-compatible). Set a key from
# https://build.nvidia.com to enable AI summaries (via .env or the environment).
NVIDIA_API_KEY = os.environ.get("NVIDIA_API_KEY", "").strip()
NVIDIA_URL = "https://integrate.api.nvidia.com/v1/chat/completions"
NVIDIA_MODEL = os.environ.get("NVIDIA_MODEL", "meta/llama-3.1-8b-instruct")

# Cache for figures scraped from arXiv PDFs (arxiv id -> data URL).
_figure_cache = {}


class Handler(http.server.SimpleHTTPRequestHandler):
    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/api/arxiv":
            self.handle_arxiv(urllib.parse.parse_qs(parsed.query))
            return
        if parsed.path == "/api/ai_status":
            self.send_json({"enabled": bool(NVIDIA_API_KEY), "model": NVIDIA_MODEL})
            return
        if parsed.path == "/api/paper_image":
            self.handle_paper_image(urllib.parse.parse_qs(parsed.query))
            return
        super().do_GET()

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/api/summarize":
            self.handle_summarize()
            return
        if parsed.path == "/api/score":
            self.handle_score()
            return
        self.send_error(404, "Not found")

    def handle_arxiv(self, params):
        category = (params.get("cat", ["cs.AI"])[0]) or "cs.AI"
        if category not in ALLOWED_CATEGORIES:
            self.send_error(400, "Unsupported category")
            return

        query = urllib.parse.urlencode({
            "search_query": f"cat:{category}",
            "sortBy": "submittedDate",
            "sortOrder": "descending",
            "start": 0,
            "max_results": 10,
        })
        url = f"https://export.arxiv.org/api/query?{query}"

        try:
            req = urllib.request.Request(url, headers={"User-Agent": "AI-Pulse/1.0"})
            with urllib.request.urlopen(req, timeout=15) as resp:
                body = resp.read()
        except Exception as exc:  # noqa: BLE001
            self.send_error(502, f"arXiv fetch failed: {exc}")
            return

        self.send_response(200)
        self.send_header("Content-Type", "application/atom+xml; charset=utf-8")
        self.send_header("Cache-Control", "public, max-age=300")
        self.end_headers()
        self.wfile.write(body)

    def handle_summarize(self):
        if not NVIDIA_API_KEY:
            self.send_json({"error": "AI summaries disabled (no NVIDIA_API_KEY set)."}, 503)
            return

        try:
            length = int(self.headers.get("Content-Length", 0))
            payload = json.loads(self.rfile.read(length) or b"{}")
        except (ValueError, json.JSONDecodeError):
            self.send_json({"error": "Invalid request body."}, 400)
            return

        title = (payload.get("title") or "").strip()[:300]
        url = (payload.get("url") or "").strip()
        text = (payload.get("text") or "").strip()  # e.g. a paper abstract
        if not title:
            self.send_json({"error": "Missing title."}, 400)
            return

        if text:
            # Paper: summarize the provided abstract.
            prompt = (
                "Summarize this research paper in 1-2 plain-English sentences for a "
                "non-expert newsletter reader: what it does and why it matters. Output "
                "only the summary, no preamble.\n\n"
                f"Title: {title}\n\nAbstract:\n{text[:4000]}\n"
            )
        else:
            # News story: summarize from the headline (+ fetched article text).
            article = self.fetch_article_text(url) if url.startswith("http") else ""
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
            summary = self.call_nvidia(prompt)
        except Exception as exc:  # noqa: BLE001
            self.send_json({"error": f"Summary failed: {exc}"}, 502)
            return

        self.send_json({"summary": summary})

    def handle_score(self):
        """Score headlines on predictability (0=uncertain..1=predictable) and
        sentiment (0=negative..1=positive) via the LLM, returned as JSON pairs."""
        if not NVIDIA_API_KEY:
            self.send_json({"error": "Scoring disabled (no NVIDIA_API_KEY set)."}, 503)
            return
        try:
            length = int(self.headers.get("Content-Length", 0))
            payload = json.loads(self.rfile.read(length) or b"{}")
        except (ValueError, json.JSONDecodeError):
            self.send_json({"error": "Invalid request body."}, 400)
            return

        # Accept either {items:[{title, summary}]} or legacy {headlines:[str]}.
        items = payload.get("items")
        if items is None:
            items = [{"title": h} for h in (payload.get("headlines") or [])]
        items = items[:50]
        if not items:
            self.send_json({"error": "No items."}, 400)
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
            text = self.call_nvidia(prompt, max_tokens=1200, temperature=0.6)
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
            self.send_json({"error": f"Scoring failed: {exc}"}, 502)
            return

        self.send_json({"scores": cleaned})

    def handle_paper_image(self, params):
        """Scrape a figure from an arXiv PDF.

        Strategy: download the PDF, pull out the largest embedded JPEG figure;
        if there are none (vector/PNG figures), fall back to a Quick Look render
        of the first page. Result is cached per arXiv id.
        """
        arxiv_id = (params.get("id", [""])[0]).strip()
        if not re.fullmatch(r"[0-9]{4}\.[0-9]{4,5}(v[0-9]+)?", arxiv_id):
            self.send_json({"error": "Invalid arXiv id."}, 400)
            return
        if arxiv_id in _figure_cache:
            self.send_json({"dataUrl": _figure_cache[arxiv_id], "cached": True})
            return

        try:
            req = urllib.request.Request(
                f"https://arxiv.org/pdf/{arxiv_id}",
                headers={"User-Agent": "AI-Pulse/1.0"},
            )
            with urllib.request.urlopen(req, timeout=25) as resp:
                pdf = resp.read(15_000_000)
        except Exception as exc:  # noqa: BLE001
            self.send_json({"error": f"PDF fetch failed: {exc}"}, 502)
            return

        data_url = self.extract_jpeg(pdf) or self.render_first_page(pdf)
        if not data_url:
            self.send_json({"error": "No image could be extracted."}, 404)
            return

        _figure_cache[arxiv_id] = data_url
        self.send_json({"dataUrl": data_url})

    def extract_jpeg(self, pdf, min_bytes=20_000):
        """Return the largest *valid* embedded JPEG (DCTDecode) as a data URL.

        The FFD8..FFD9 byte scan can occasionally grab a malformed blob, so each
        candidate (largest first) is validated with `sips` before use.
        """
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
            png = self.normalize_to_png(blob, ".jpg")
            if png:  # re-encoded to sRGB PNG → guaranteed browser-renderable
                return "data:image/png;base64," + base64.b64encode(png).decode()
        return None

    def normalize_to_png(self, blob, suffix):
        """Re-encode bytes to a clean sRGB PNG via `sips`.

        This both validates the candidate and normalizes odd colorspaces
        (e.g. CMYK JPEGs that browsers refuse to render). Returns PNG bytes
        or None if the bytes aren't a usable image.
        """
        with tempfile.TemporaryDirectory() as tmp:
            src = os.path.join(tmp, "in" + suffix)
            out = os.path.join(tmp, "out.png")
            with open(src, "wb") as fh:
                fh.write(blob)
            try:
                subprocess.run(
                    ["sips", "-s", "format", "png", src, "--out", out],
                    capture_output=True, timeout=15, check=False,
                )
            except Exception:  # noqa: BLE001
                return None
            if not os.path.exists(out) or os.path.getsize(out) < 1000:
                return None
            with open(out, "rb") as fh:
                return fh.read()

    def render_first_page(self, pdf):
        """Render the PDF's first page to a PNG via macOS Quick Look."""
        with tempfile.TemporaryDirectory() as tmp:
            pdf_path = os.path.join(tmp, "paper.pdf")
            with open(pdf_path, "wb") as fh:
                fh.write(pdf)
            try:
                subprocess.run(
                    ["qlmanage", "-t", "-s", "700", "-o", tmp, pdf_path],
                    capture_output=True, timeout=25, check=False,
                )
            except Exception:  # noqa: BLE001
                return None
            pngs = [f for f in os.listdir(tmp) if f.endswith(".png")]
            if not pngs:
                return None
            with open(os.path.join(tmp, pngs[0]), "rb") as fh:
                return "data:image/png;base64," + base64.b64encode(fh.read()).decode()

    def fetch_article_text(self, url):
        """Best-effort: fetch the page and strip tags to plain-ish text."""
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "AI-Pulse/1.0"})
            with urllib.request.urlopen(req, timeout=8) as resp:
                ctype = resp.headers.get("Content-Type", "")
                if "html" not in ctype and "text" not in ctype:
                    return ""
                raw = resp.read(200_000).decode("utf-8", "ignore")
        except Exception:  # noqa: BLE001
            return ""
        raw = re.sub(r"(?is)<(script|style|head).*?</\1>", " ", raw)
        text = re.sub(r"(?s)<[^>]+>", " ", raw)
        text = re.sub(r"\s+", " ", text)
        return text.strip()

    def call_nvidia(self, prompt, max_tokens=1024, temperature=0.3):
        body = json.dumps({
            "model": NVIDIA_MODEL,
            "messages": [{"role": "user", "content": prompt}],
            "temperature": temperature,
            "max_tokens": max_tokens,
        }).encode("utf-8")
        req = urllib.request.Request(
            NVIDIA_URL,
            data=body,
            headers={
                "Authorization": f"Bearer {NVIDIA_API_KEY}",
                "Content-Type": "application/json",
                "Accept": "application/json",
            },
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=90) as resp:
            data = json.loads(resp.read())
        content = data["choices"][0]["message"].get("content", "") or ""
        # Reasoning models (e.g. Nemotron) may emit a <think>...</think> block
        # before the answer — keep only the final text.
        content = re.sub(r"(?is)<think>.*?</think>", "", content)
        content = re.sub(r"(?is)^.*?</think>", "", content)  # unclosed/leading think
        return content.strip()

    def send_json(self, obj, status=200):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):  # quieter logs
        pass


if __name__ == "__main__":
    # Threaded so concurrent PDF scrapes / summaries don't block the whole site.
    http.server.ThreadingHTTPServer.allow_reuse_address = True
    with http.server.ThreadingHTTPServer(("", PORT), Handler) as httpd:
        print(f"AI Pulse running at http://localhost:{PORT}")
        httpd.serve_forever()
