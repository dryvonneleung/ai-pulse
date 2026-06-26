# AI Pulse

A single-page dashboard for the latest in AI — **academic papers from arXiv**, **trending AI news from Hacker News**, an attention **Trend Radar**, a relational **news graph**, an **outlook quadrant**, and a newsletter sign-up. Optional AI features (summaries, headline scoring) are powered by free [NVIDIA NIM](https://build.nvidia.com) models.

> © 2026 Yvonne Leung AI Consulting Inc. · Released under the [MIT License](LICENSE).

## Features

- **Latest AI papers** — live from the arXiv API, with a category switcher (cs.AI, cs.LG, cs.CL, cs.CV, stat.ML). Each paper card scrapes a **figure straight from the PDF** and offers a one-click **AI summary** of the abstract.
- **Trending AI news** — from the Hacker News API (`AI OR LLM OR Agent`, last 12 months), with topic filtering, popularity/recency sorting, a "popularity by topic" dashboard, and on-demand **AI summaries**.
- **📡 Trend Radar** — buckets 6 months of AI stories by topic and shows which are gaining or losing attention, with a speculative outlook. *(Attention signal, not a capability forecast.)*
- **🕸️ News network** — a force-directed graph linking each story to its topic and a central AI hub.
- **🧭 Outlook quadrant** — maps headlines on **predictable ↔ uncertain** × **positive ↔ negative**, scored by the LLM (from a story's summary when available, else the headline).
- **Newsletter sign-up** — stored in `localStorage` for the demo (swap in a provider like Mailchimp/Buttondown to go live).

## Architecture

This is **not** a pure static site. A small Python server (`server.py`) serves the frontend **and** provides API routes the browser can't do on its own:

| Route | Why it needs a server |
|---|---|
| `GET /api/arxiv` | arXiv's API sends **no CORS headers**, so the browser can't call it directly — the server proxies it. |
| `POST /api/summarize` | Calls NVIDIA NIM to summarize a news story or paper abstract. Keeps the **API key server-side**. |
| `POST /api/score` | Scores headlines/summaries for the quadrant (predictability + sentiment) via NVIDIA NIM. |
| `GET /api/paper-image` | Downloads a paper's PDF and extracts a figure (or renders the first page). **Uses macOS tools — see note below.** |
| `GET /api/ai-status` | Tells the frontend whether AI features are enabled. |

The frontend is **vanilla HTML/CSS/JS — no build step, no dependencies.**

## Run locally

Requires **Python 3** (no packages needed).

```bash
python3 server.py
# → http://localhost:8000
```

The site works without any API key — only the AI features (summaries, quadrant scoring) stay off.

## Enable the AI features

1. Get a free API key from <https://build.nvidia.com> (`nvapi-...`).
2. Create a `.env` file in the project root:

   ```
   NVIDIA_API_KEY=nvapi-xxxxxxxxxxxxxxxx
   NVIDIA_MODEL=meta/llama-3.1-8b-instruct
   ```

3. Restart `python3 server.py`. Summaries and quadrant scoring turn on automatically.

`.env` is git-ignored — **never commit your key.**

## Data sources

- [arXiv](https://arxiv.org) — academic papers
- [Hacker News (Algolia API)](https://hn.algolia.com/api) — news
- [NVIDIA NIM](https://build.nvidia.com) — LLM summaries & scoring (optional)

## Deployment notes

Because it has a Python backend, **GitHub Pages alone won't run it** (Pages is static-only — the arXiv proxy and all AI routes would fail). Host it somewhere that runs Python, e.g. **Vercel** (Python serverless functions), Render, Railway, Fly.io, or a small VPS.

> ⚠️ **`GET /api/paper-image` is macOS-specific** — it uses `qlmanage` (Quick Look) and `sips`. On Linux hosts (including Vercel) this route needs a rewrite using `pdfimages`/Pillow or similar. Every other route is portable.

## License

Released under the [MIT License](LICENSE). © 2026 Yvonne Leung AI Consulting Inc.
