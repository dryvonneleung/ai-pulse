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

## Project structure

```
index.html, styles.css, app.js   # static frontend (no build step)
server.py                         # local dev server (serves site + API), macOS
api/                              # Vercel serverless functions (Linux)
  _lib.py                         #   shared helpers (NVIDIA, etc.)
  arxiv.py  ai-status.py
  summarize.py  score.py  paper-image.py
requirements.txt  vercel.json     # Vercel config (Pillow, function timeout)
```

`server.py` and the `api/` functions share the same logic; locally you run `server.py`, and on Vercel each `api/*.py` is its own function.

## Deployment

**GitHub Pages won't work** — it's static-only and can't run the Python backend (the arXiv proxy and all AI routes would fail). Host it where Python runs.

### Deploy to Vercel

1. Push this repo to GitHub (already done).
2. Go to <https://vercel.com/new> and **import the repo**. Vercel auto-detects the static files (served from the root) and the `api/*.py` Python serverless functions — no extra config needed.
3. In **Project Settings → Environment Variables**, add:
   - `NVIDIA_API_KEY` = your `nvapi-...` key
   - `NVIDIA_MODEL` = `meta/llama-3.1-8b-instruct` (optional)
4. **Deploy.** The site and `/api/*` routes run on the same origin, so everything works.

> **Note on paper figures:** the Vercel version (`api/paper-image.py`) extracts embedded JPEG figures with **Pillow**. Papers whose figures are all vector/PNG won't get a thumbnail (the card still renders). The local `server.py` additionally renders a first-page preview via macOS Quick Look — that fallback is macOS-only and isn't available on Vercel.

Other Python hosts (Render, Railway, Fly.io, a VPS) work too — run `server.py`, or adapt the `api/` functions.

## License

Released under the [MIT License](LICENSE). © 2026 Yvonne Leung AI Consulting Inc.
