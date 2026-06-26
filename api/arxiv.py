from http.server import BaseHTTPRequestHandler
import urllib.parse
import urllib.request

ALLOWED_CATEGORIES = {"cs.AI", "cs.LG", "cs.CL", "cs.CV", "stat.ML"}


class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        params = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
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
            with urllib.request.urlopen(req, timeout=20) as resp:
                body = resp.read()
        except Exception as exc:  # noqa: BLE001
            self.send_error(502, f"arXiv fetch failed: {exc}")
            return

        self.send_response(200)
        self.send_header("Content-Type", "application/atom+xml; charset=utf-8")
        self.send_header("Cache-Control", "public, max-age=300")
        self.end_headers()
        self.wfile.write(body)
