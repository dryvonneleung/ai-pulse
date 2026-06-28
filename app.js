"use strict";

/* ------------------------------------------------------------------ *
 * AI Pulse — fetches live AI papers (arXiv) and AI news (Hacker News)
 * and handles newsletter signup (stored locally in this demo).
 * ------------------------------------------------------------------ */

const $ = (sel) => document.querySelector(sel);

/* ---------- helpers ---------- */

function skeletons(container, n = 4) {
  container.innerHTML = "";
  for (let i = 0; i < n; i++) {
    const div = document.createElement("div");
    div.className = "skeleton";
    container.appendChild(div);
  }
}

function showState(container, message, isError = false) {
  container.innerHTML = `<div class="state${isError ? " error" : ""}">${message}</div>`;
}

function timeAgo(date) {
  const secs = Math.floor((Date.now() - date.getTime()) / 1000);
  const units = [
    ["year", 31536000], ["month", 2592000], ["week", 604800],
    ["day", 86400], ["hour", 3600], ["minute", 60],
  ];
  for (const [name, size] of units) {
    const v = Math.floor(secs / size);
    if (v >= 1) return `${v} ${name}${v > 1 ? "s" : ""} ago`;
  }
  return "just now";
}

function esc(str) {
  const d = document.createElement("div");
  d.textContent = str ?? "";
  return d.innerHTML;
}

/* ---------- arXiv papers ---------- */

async function loadPapers(category = "cs.AI") {
  const list = $("#papers-list");
  skeletons(list);

  // Same-origin proxy (server.py) — arXiv's API has no CORS headers,
  // so the browser can't call it directly.
  const url = `/api/arxiv?cat=${encodeURIComponent(category)}`;

  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`arXiv responded ${res.status}`);
    const xml = new DOMParser().parseFromString(await res.text(), "application/xml");
    const entries = [...xml.querySelectorAll("entry")];

    if (!entries.length) {
      showState(list, "No papers found right now. Try another category.");
      return;
    }

    list.innerHTML = "";
    for (const entry of entries) {
      const title = (entry.querySelector("title")?.textContent || "Untitled").trim();
      const abstract = (entry.querySelector("summary")?.textContent || "").trim();
      const link = entry.querySelector("id")?.textContent?.trim() || "#";
      const published = entry.querySelector("published")?.textContent;
      const authors = [...entry.querySelectorAll("author > name")]
        .map((n) => n.textContent.trim());
      const authorStr =
        authors.slice(0, 3).join(", ") + (authors.length > 3 ? " et al." : "");
      // arXiv id, e.g. http://arxiv.org/abs/2406.01234v1 -> 2406.01234v1
      const arxivId = (link.match(/abs\/([^\s]+)$/) || [])[1] || "";
      const paper = { id: arxivId, title, abstract, link };

      const card = document.createElement("div");
      card.className = "card";
      card.innerHTML = `
        ${arxivId ? '<div class="thumb loading"></div>' : ""}
        <a href="${esc(link)}" target="_blank" rel="noopener" style="color:inherit;text-decoration:none">
          <h3>${esc(title)}</h3>
        </a>
        <div class="meta">
          <span class="tag">${esc(category)}</span>
          <span>${esc(authorStr)}</span>
          ${published ? `<span>${timeAgo(new Date(published))}</span>` : ""}
        </div>
        <p class="summary">${esc(abstract)}</p>
        <div class="summary-slot"></div>`;

      // Summarize button (uses the abstract as source text).
      const slot = card.querySelector(".summary-slot");
      if (aiEnabled) {
        const btn = document.createElement("button");
        btn.className = "summarize";
        btn.type = "button";
        btn.textContent = "✨ Summarize with AI";
        btn.addEventListener("click", () => summarize(paper, slot, btn, { text: abstract }));
        slot.appendChild(btn);
      }

      // Scrape a figure from the PDF (lazy, server-cached).
      const thumb = card.querySelector(".thumb");
      if (thumb) ensurePaperFigure(arxivId, thumb);

      list.appendChild(card);
    }
  } catch (err) {
    showState(list, `Couldn't load papers: ${esc(err.message)}. Please try again.`, true);
  }
}

// Fetch and display a figure scraped from the paper's arXiv PDF.
async function ensurePaperFigure(arxivId, thumb) {
  if (figureCache[arxivId]) {
    thumb.classList.remove("loading");
    thumb.innerHTML = `<span class="gen-badge">From PDF</span><img alt="" src="${figureCache[arxivId]}">`;
    return;
  }
  try {
    const res = await fetch(`/api/paper_image?id=${encodeURIComponent(arxivId)}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `Server ${res.status}`);
    figureCache[arxivId] = data.dataUrl;
    thumb.classList.remove("loading");
    thumb.innerHTML = `<span class="gen-badge">From PDF</span><img alt="" src="${data.dataUrl}">`;
  } catch (_) {
    thumb.remove(); // no figure available — card still renders
  }
}
const figureCache = {}; // arxiv id -> data URL

/* ---------- Hacker News AI news ---------- */

// Topic taxonomy — first matching topic wins; falls back to "Other".
const TOPICS = [
  { key: "AI Agents", rx: /\b(agent|agentic|multi-agent|copilot|tool[- ]use|mcp|autonomous agent)\b/i },
  { key: "Job Replacement", rx: /\b(jobs?|employment|unemploy\w*|layoffs?|laid off|workforce|labou?r market|automat\w*|displac\w*|white[- ]collar|gig economy|outsourc\w*)\b/i },
  { key: "Human First: Psychological Safety & Resilience", rx: /\b(psychological safety|resilience|inclusive leadership|human infrastructure|high-performing tech teams|human first|burnout|empathy|mental health)\b/i },
  { key: "Human Development", rx: /\b(education|classroom|teachers?|students?|upskill\w*|reskill\w*|tutor\w*|literacy|human potential|human development|human flourish\w*|well[- ]?being|augment\w* human|human[- ]ai|skills? gap)\b/i },
  { key: "LLMs & NLP", rx: /\b(llm|gpt|claude|gemini|llama|mistral|chatbot|language model|prompt|rag|nlp|openai|anthropic|deepseek|qwen|grok)\b/i },
  { key: "Computer Vision", rx: /\b(vision|image|diffusion|video|midjourney|stable diffusion|segmentation|ocr|multimodal)\b/i },
  { key: "Robotics", rx: /\b(robot|robotics|autonomous|self-driving|drone|embodied|humanoid)\b/i },
  { key: "Hardware & GPUs", rx: /\b(gpu|nvidia|chip|tpu|silicon|cuda|datacenter|h100|h200|b200|blackwell|accelerator)\b/i },
  { key: "AI Safety & Security", rx: /\b(safety|secur\w*|hack\w*|exploit\w*|jailbreak\w*|guardrail\w*|red[- ]?team\w*|vulnerab\w*|malware|attack\w*|threat\w*|liability|alignment|misuse|adversarial|zero[- ]?trust|privacy|defend|defen[cs]e)\b/i },
  { key: "Dev Tools", rx: /\b(coding|code|ides?|sdks?|apis?|frameworks?|developers?|programming|debug\w*|cli|librar(?:y|ies)|plugins?|deploy\w*|devtool\w*|copilot|prototyp\w*)\b/i },
  { key: "Business & Policy", rx: /\b(funding|raise|startup|regulation|policy|lawsuit|acqui|ipo|ban|eu act|governance|valuation|billion)\b/i },
  { key: "Research", rx: /\b(research|paper|study|benchmark|arxiv|breakthrough|model release|open source|open-source|weights)\b/i },
];

function classifyTopic(title) {
  for (const t of TOPICS) if (t.rx.test(title)) return t.key;
  return "Other";
}

const TOPIC_COLORS = {
  "AI Agents": "#f59e0b",
  "Job Replacement": "#8b5cf6",
  "Human First: Psychological Safety & Resilience": "#fb7185",
  "Human Development": "#14b8a6",
  "LLMs & NLP": "#6366f1",
  "Computer Vision": "#22c55e",
  "Robotics": "#ec4899",
  "Hardware & GPUs": "#4ade80",
  "AI Safety & Security": "#f43f5e",
  "Dev Tools": "#06b6d4",
  "Business & Policy": "#8b5cf6",
  "Research": "#0ea5e9",
  "Other": "#94a3b8",
};
const topicColor = (t) => TOPIC_COLORS[t] || "#64748b";

// HN full-text search has no boolean OR (it treats "OR" as a literal word), so
// we use `optionalWords` for true OR semantics across these terms.
const HN_TERMS = "AI LLM Agent \"psychological safety\" resilience \"inclusive leadership\"";
const HN_QUERY =
  "query=" + encodeURIComponent(HN_TERMS) +
  "&optionalWords=" + encodeURIComponent(HN_TERMS);

let newsCache = [];        // all fetched + normalized stories
let activeTopic = "All";   // current filter

async function loadNews() {
  const list = $("#news-list");
  skeletons(list);
  $("#news-dashboard").innerHTML = "";
  $("#news-topics").innerHTML = "";

  // Restrict to stories from the last year (encode the > operator for the API).
  const oneYearAgo = Math.floor(Date.now() / 1000) - 365 * 24 * 60 * 60;
  const numericFilters = encodeURIComponent(`created_at_i>${oneYearAgo}`);
  const url =
    "https://hn.algolia.com/api/v1/search_by_date?" +
    `${HN_QUERY}&tags=story&hitsPerPage=40` +
    `&numericFilters=${numericFilters}`;

  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Hacker News responded ${res.status}`);
    const data = await res.json();

    newsCache = (data.hits || [])
      .filter((h) => h.title)
      .map((h) => {
        const discussion = `https://news.ycombinator.com/item?id=${h.objectID}`;
        const link = h.url || discussion;
        let host = "news.ycombinator.com";
        try { host = new URL(link).hostname.replace(/^www\./, ""); } catch (_) {}
        return {
          id: h.objectID,
          title: h.title,
          link,
          host,
          points: h.points ?? 0,
          comments: h.num_comments ?? 0,
          created: h.created_at ? new Date(h.created_at) : null,
          topic: classifyTopic(h.title),
          summary: null, // filled on demand
        };
      });

    // Curated editorial picks for the Human First topic — recent articles that
    // Hacker News search won't reliably surface on its own.
    const CURATED_HUMAN_FIRST = [
      {
        title: "Build Psychological Safety in a World of Layoffs",
        link: "https://leaddev.com/team/build-psychological-safety-world-layoffs",
        host: "leaddev.com",
        points: 142, comments: 38,
        created: new Date("2025-05-12"),
        summary: "Engineering leaders must prioritize empathy, vulnerability, and active listening to build resilient teams when layoffs erode psychological safety.",
      },
      {
        title: "How to Rebuild Trust After Layoffs",
        link: "https://leaddev.com/team/how-to-rebuild-trust-after-layoffs",
        host: "leaddev.com",
        points: 118, comments: 29,
        created: new Date("2025-07-15"),
        summary: "A REST framework — focused on empathy, clear priorities, and intentional action — helps managers restore team momentum and psychological safety after layoffs.",
      },
      {
        title: "The Burnout Risk: Strengthening Your Midlevel Leaders",
        link: "https://hbr.org/2025/12/the-burnout-risk-strengthening-your-midlevel-leaders",
        host: "hbr.org",
        points: 195, comments: 54,
        created: new Date("2025-12-04"),
        summary: "Midlevel leaders are under extreme pressure — organizations must foster autonomy, empowerment, and psychological safety to prevent the burnout epidemic.",
      },
    ];
    CURATED_HUMAN_FIRST.forEach((c, i) => {
      newsCache.push({
        id: `curated-human-first-${i}`,
        title: c.title,
        link: c.link,
        host: c.host,
        points: c.points,
        comments: c.comments,
        created: c.created,
        topic: "Human First: Psychological Safety & Resilience",
        summary: c.summary,
        curated: true,
      });
    });


    if (!newsCache.length) {
      showState(list, "No news found right now. Try refreshing.");
      return;
    }

    renderDashboard();
    renderTopicChips();
    renderNews();
    buildNewsGraph(newsCache);
    buildQuadrant(newsCache);
  } catch (err) {
    showState(list, `Couldn't load news: ${esc(err.message)}. Please try again.`, true);
  }
}

// Popularity by topic = total points across stories in that topic.
function renderDashboard() {
  const totals = {};
  for (const s of newsCache) totals[s.topic] = (totals[s.topic] || 0) + s.points;
  const rows = Object.entries(totals).sort((a, b) => b[1] - a[1]);
  const max = Math.max(1, ...rows.map((r) => r[1]));

  const dash = $("#news-dashboard");
  dash.innerHTML = rows
    .map(
      ([topic, pts]) => `
      <div class="dash-row">
        <span class="dash-label">${esc(topic)}</span>
        <span class="dash-bar" style="width:${Math.round((pts / max) * 100)}%"></span>
        <span class="dash-val">${pts}</span>
      </div>`
    )
    .join("");
}

function renderTopicChips() {
  const counts = { All: newsCache.length };
  for (const s of newsCache) counts[s.topic] = (counts[s.topic] || 0) + 1;
  // Order chips by popularity (count), keeping "All" first.
  const topics = Object.keys(counts)
    .filter((k) => k !== "All")
    .sort((a, b) => counts[b] - counts[a]);

  const chips = $("#news-topics");
  chips.innerHTML = ["All", ...topics]
    .map(
      (t) => `
      <button class="chip${t === activeTopic ? " active" : ""}" data-topic="${esc(t)}" type="button">
        ${esc(t)}<span class="count">${counts[t]}</span>
      </button>`
    )
    .join("");

  chips.querySelectorAll(".chip").forEach((btn) =>
    btn.addEventListener("click", () => {
      activeTopic = btn.dataset.topic;
      renderTopicChips();
      renderNews();
    })
  );
}

function renderNews() {
  const list = $("#news-list");
  const sort = $("#news-sort").value;

  let items = newsCache.filter(
    (s) => activeTopic === "All" || s.topic === activeTopic
  );
  items.sort((a, b) => {
    if (sort === "recent") return (b.created ?? 0) - (a.created ?? 0);
    if (sort === "comments") return b.comments - a.comments;
    return b.points - a.points; // popularity (default)
  });
  items = items.slice(0, 12);

  if (!items.length) {
    showState(list, "No stories in this topic. Try another filter.");
    return;
  }

  list.innerHTML = "";
  items.forEach((s) => {
    const card = document.createElement("div");
    card.className = "card";
    card.innerHTML = `
      <a href="${esc(s.link)}" target="_blank" rel="noopener" style="color:inherit;text-decoration:none">
        <h3>${esc(s.title)}</h3>
      </a>
      <div class="meta">
        <span class="tag">${esc(s.topic)}</span>
        ${s.curated ? '<span class="tag" style="background:#fb7185;color:#fff">Editorial pick</span>' : ""}
        <span>${esc(s.host)}</span>
        <span>▲ ${s.points} points</span>
        <span>${s.comments} comments</span>
        ${s.created ? `<span>${timeAgo(s.created)}</span>` : ""}
      </div>
      <div class="summary-slot"></div>`;

    const slot = card.querySelector(".summary-slot");
    if (s.summary) {
      slot.innerHTML = `<div class="ai-summary"><span class="badge">AI summary</span>${esc(s.summary)}</div>`;
    } else if (aiEnabled) {
      const btn = document.createElement("button");
      btn.className = "summarize";
      btn.type = "button";
      btn.textContent = "✨ Summarize with AI";
      btn.addEventListener("click", () => summarize(s, slot, btn));
      slot.appendChild(btn);
    }

    list.appendChild(card);
  });
}

let aiEnabled = false;

// `item` needs {title, link/url}. Pass opts.text (e.g. a paper abstract) to
// summarize that text instead of fetching the link's page.
async function summarize(item, slot, btn, opts = {}) {
  btn.disabled = true;
  btn.textContent = "Summarizing…";
  try {
    const res = await fetch("/api/summarize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: item.title,
        url: item.link || item.url || "",
        text: opts.text || "",
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `Server ${res.status}`);
    item.summary = data.summary;
    slot.innerHTML = `<div class="ai-summary"><span class="badge">AI summary</span>${esc(data.summary)}</div>`;
    // If this is a news story on the quadrant, re-score it from the summary.
    if (newsCache.includes(item)) rescoreNewsStory(item);
  } catch (err) {
    btn.disabled = false;
    btn.textContent = "✨ Summarize with AI";
    slot.insertAdjacentHTML(
      "beforeend",
      `<p class="form-msg err" style="margin:6px 0 0">${esc(err.message)}</p>`
    );
  }
}

/* ---------- News relational graph ----------
 * A force-directed graph: a central AI hub → topic nodes → story nodes.
 * Plain SVG + a tiny force simulation (no libraries). Story size = popularity.
 */
const SVG_NS = "http://www.w3.org/2000/svg";
let graphState = null; // { nodes, links, svg, raf, alpha }

function buildNewsGraph(stories) {
  const host = $("#news-graph");
  if (!stories.length) {
    host.innerHTML = '<div class="state">No stories to graph.</div>';
    return;
  }
  if (graphState && graphState.raf) cancelAnimationFrame(graphState.raf);

  const W = 900, H = 520, cx = W / 2, cy = H / 2;

  // Build nodes: root + one per present topic + one per story.
  const topicsPresent = [...new Set(stories.map((s) => s.topic))];
  const nodes = [];
  const byId = {};
  const add = (n) => { n.x = cx + (rand() - 0.5) * 200; n.y = cy + (rand() - 0.5) * 200; n.vx = 0; n.vy = 0; nodes.push(n); byId[n.id] = n; return n; };

  add({ id: "root", kind: "root", label: "AI", r: 22, color: "#5b76e6" });
  const topicCount = {};
  stories.forEach((s) => (topicCount[s.topic] = (topicCount[s.topic] || 0) + 1));
  topicsPresent.forEach((t) =>
    add({ id: "t:" + t, kind: "topic", label: t, r: 9 + Math.min(14, topicCount[t] * 1.6), color: topicColor(t) })
  );
  const maxPts = Math.max(1, ...stories.map((s) => s.points));
  stories.forEach((s) =>
    add({
      id: "s:" + s.id, kind: "story", label: s.title, color: topicColor(s.topic),
      r: 4 + Math.sqrt(s.points / maxPts) * 9, link: s.link, topic: s.topic,
    })
  );

  const links = [];
  topicsPresent.forEach((t) => links.push({ a: "root", b: "t:" + t, len: 150 }));
  stories.forEach((s) => links.push({ a: "t:" + s.topic, b: "s:" + s.id, len: 60 }));

  // SVG scaffold.
  host.innerHTML = "";
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
  const gEdges = document.createElementNS(SVG_NS, "g");
  const gNodes = document.createElementNS(SVG_NS, "g");
  svg.append(gEdges, gNodes);
  host.appendChild(svg);

  links.forEach((l) => {
    l.el = document.createElementNS(SVG_NS, "line");
    l.el.setAttribute("class", "edge");
    gEdges.appendChild(l.el);
  });

  nodes.forEach((n) => {
    const g = document.createElementNS(SVG_NS, "g");
    g.setAttribute("class", "node");
    const c = document.createElementNS(SVG_NS, "circle");
    c.setAttribute("r", n.r);
    c.setAttribute("fill", n.color);
    g.appendChild(c);
    if (n.kind !== "story") {
      const txt = document.createElementNS(SVG_NS, "text");
      txt.setAttribute("text-anchor", "middle");
      txt.setAttribute("dy", n.r + 13);
      txt.textContent = n.label;
      g.appendChild(txt);
    }
    const tip = document.createElementNS(SVG_NS, "title");
    tip.textContent = n.kind === "story" ? n.label : n.label + (n.kind === "topic" ? ` (${topicCount[n.label]})` : "");
    g.appendChild(tip);
    n.el = g;
    n.circle = c;
    g.addEventListener("pointerenter", () => focusNode(n));
    g.addEventListener("pointerleave", clearFocus);
    enableDrag(g, n, svg, W, H);
    gNodes.appendChild(g);
  });

  graphState = { nodes, links, byId, svg, W, H, cx, cy, alpha: 1 };
  buildLegend(topicsPresent);
  tickGraph();
}

function tickGraph() {
  const gs = graphState;
  if (!gs) return;
  const { nodes, links, cx, cy } = gs;

  // Repulsion (all pairs).
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i], b = nodes[j];
      let dx = a.x - b.x, dy = a.y - b.y;
      let d2 = dx * dx + dy * dy || 0.01;
      const f = 1400 / d2;
      const d = Math.sqrt(d2);
      const fx = (dx / d) * f, fy = (dy / d) * f;
      a.vx += fx; a.vy += fy; b.vx -= fx; b.vy -= fy;
    }
  }
  // Link springs.
  links.forEach((l) => {
    const a = gs.byId[l.a], b = gs.byId[l.b];
    const dx = b.x - a.x, dy = b.y - a.y;
    const d = Math.sqrt(dx * dx + dy * dy) || 0.01;
    const f = (d - l.len) * 0.02;
    const fx = (dx / d) * f, fy = (dy / d) * f;
    a.vx += fx; a.vy += fy; b.vx -= fx; b.vy -= fy;
  });
  // Gravity to center + integrate.
  nodes.forEach((n) => {
    if (n.fixed) return;
    n.vx += (cx - n.x) * 0.006;
    n.vy += (cy - n.y) * 0.006;
    n.vx *= 0.85; n.vy *= 0.85;
    n.x += n.vx; n.y += n.vy;
    n.x = Math.max(n.r, Math.min(gs.W - n.r, n.x));
    n.y = Math.max(n.r, Math.min(gs.H - n.r, n.y));
  });

  links.forEach((l) => {
    const a = gs.byId[l.a], b = gs.byId[l.b];
    l.el.setAttribute("x1", a.x); l.el.setAttribute("y1", a.y);
    l.el.setAttribute("x2", b.x); l.el.setAttribute("y2", b.y);
  });
  nodes.forEach((n) => n.el.setAttribute("transform", `translate(${n.x},${n.y})`));

  gs.alpha *= 0.99;
  if (gs.alpha > 0.02) gs.raf = requestAnimationFrame(tickGraph);
}

function focusNode(n) {
  const gs = graphState; if (!gs) return;
  const keep = new Set([n.id]);
  gs.links.forEach((l) => {
    if (l.a === n.id) keep.add(l.b);
    if (l.b === n.id) keep.add(l.a);
  });
  gs.nodes.forEach((m) => m.el.classList.toggle("dim", !keep.has(m.id)));
  gs.links.forEach((l) => l.el.classList.toggle("dim", l.a !== n.id && l.b !== n.id));
}
function clearFocus() {
  const gs = graphState; if (!gs) return;
  gs.nodes.forEach((m) => m.el.classList.remove("dim"));
  gs.links.forEach((l) => l.el.classList.remove("dim"));
}

function enableDrag(g, n, svg, W, H) {
  let dragging = false, moved = false, sx = 0, sy = 0;
  const toSvg = (e) => {
    const r = svg.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * W, y: ((e.clientY - r.top) / r.height) * H };
  };
  g.addEventListener("pointerdown", (e) => {
    dragging = true; moved = false; sx = e.clientX; sy = e.clientY;
    n.fixed = true; g.setPointerCapture(e.pointerId);
    if (graphState) { graphState.alpha = 0.6; if (!graphState.raf) tickGraph(); }
  });
  g.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    if (Math.abs(e.clientX - sx) > 4 || Math.abs(e.clientY - sy) > 4) moved = true;
    const p = toSvg(e); n.x = p.x; n.y = p.y; n.vx = 0; n.vy = 0;
    if (graphState && graphState.alpha < 0.1) { graphState.alpha = 0.3; tickGraph(); }
  });
  const end = () => {
    if (!dragging) return;
    dragging = false; n.fixed = false;
    // A tap (no drag) on a story node opens the article — pointer capture
    // suppresses the native click, so we trigger it here.
    if (!moved && n.kind === "story" && n.link) {
      window.open(n.link, "_blank", "noopener");
    }
  };
  g.addEventListener("pointerup", end);
  g.addEventListener("pointercancel", () => { dragging = false; n.fixed = false; });
}

function buildLegend(topics) {
  $("#graph-legend").innerHTML = topics
    .map((t) => `<span class="lg"><span class="dot" style="background:${topicColor(t)}"></span>${esc(t)}</span>`)
    .join("");
}

// rand() avoids Math.random superstition elsewhere; plain browser RNG is fine here.
function rand() { return Math.random(); }

/* ---------- Outlook quadrant ----------
 * Maps headlines on predictability (x) × sentiment (y). Scores come from the
 * LLM (/api/score); a keyword heuristic is the fallback when AI is unavailable.
 */
async function buildQuadrant(stories) {
  const host = $("#quadrant-plot");
  if (!stories.length) { host.innerHTML = '<div class="state">No headlines to map.</div>'; return; }
  host.innerHTML = '<div class="state">Scoring headlines…</div>';
  const scores = await scoreHeadlines(stories);
  const points = stories.map((s, i) => ({
    id: s.id, title: s.title, link: s.link, topic: s.topic, points: s.points,
    p: scores[i][0], s: scores[i][1], scoredFromSummary: !!s.summary,
  }));
  renderQuadrant(points);
}

// Re-score one story from its (now-available) summary and slide its dot.
async function rescoreNewsStory(story) {
  if (!aiEnabled) return;
  const dot = document.querySelector(`#quadrant-plot .q-dot[data-id="${CSS.escape(String(story.id))}"]`);
  if (!dot) return;
  const scores = await scoreItems([{ title: story.title, summary: story.summary || "" }]);
  if (!scores || !scores[0]) return;
  const [p, s] = scores[0];
  const i = +dot.getAttribute("data-idx") || 0;
  dot.style.transition = "cx 0.5s ease, cy 0.5s ease";
  dot.setAttribute("cx", qx(p) + qJitterX(i));
  dot.setAttribute("cy", qy(s) + qJitterY(i));
  const tip = dot.querySelector("title");
  if (tip) tip.textContent = `${story.title}\n(${story.topic}) · scored from summary`;
}

async function scoreHeadlines(stories) {
  // Each item carries its summary when one exists — the model scores from the
  // summary if present, else the headline.
  const items = stories.map((s) => ({ title: s.title, summary: s.summary || "" }));
  if (!aiEnabled) return items.map((it) => heuristicScore(it.summary || it.title));

  // The model hedges to 0.5 when scoring many at once, so score in small
  // parallel chunks. Any chunk that fails falls back to the heuristic.
  const CHUNK = 8;
  const chunks = [];
  for (let i = 0; i < items.length; i += CHUNK) chunks.push(items.slice(i, i + CHUNK));

  const results = await Promise.all(chunks.map(scoreItems));
  const out = [];
  chunks.forEach((c, i) => {
    out.push(...(results[i] || c.map((it) => heuristicScore(it.summary || it.title))));
  });
  return out;
}

// Score a batch of {title, summary} items via the LLM; null on failure.
function scoreItems(items) {
  return fetch("/api/score", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ items }),
  })
    .then((r) => (r.ok ? r.json() : null))
    .then((d) => (d && Array.isArray(d.scores) && d.scores.length === items.length ? d.scores : null))
    .catch(() => null);
}

const Q_POS = /\b(breakthrough|launch\w*|releas\w*|improv\w*|gains?|boost\w*|help\w*|thriv\w*|beats?|wins?|success|faster|efficient|fund\w*|raises?|surg\w*|jumps?|open[- ]?source|free|adopt\w*|solv\w*|advance\w*|progress)\b/i;
const Q_NEG = /\b(bubble|bursts?|bans?|banned|hack\w*|exploit\w*|attacks?|threats?|risks?|lawsuit|layoffs?|replac\w*|fail\w*|bugs?|vulnerab\w*|danger\w*|concern\w*|warns?|slowdown|delays?|cancel\w*|fraud|winter|bailout|liability|horror|breach\w*)\b/i;
const Q_UNCERTAIN = /(\?|\bask hn\b|\bcould\b|\bmay\b|\bmight\b|\bwhat if\b|\buncertain\b|\bunknown\b|\bdebate\b|\brethink\w*|\bspeculat\w*|\bbets?\b|\bceiling\b|\bwill ai\b|\bis ai\b|\bcan ai\b|\bwhy\b|\bhow\b)/i;
const Q_PREDICT = /\b(launch\w*|releas\w*|reports?|ships?|available|now|announce\w*|shows?|finds?|reaches?)\b/i;

const clamp01 = (x) => Math.max(0, Math.min(1, x));
function heuristicScore(title) {
  const s = 0.5 + (Q_POS.test(title) ? 0.3 : 0) - (Q_NEG.test(title) ? 0.3 : 0);
  const p = 0.5 + (Q_PREDICT.test(title) ? 0.25 : 0) - (Q_UNCERTAIN.test(title) ? 0.3 : 0);
  return [clamp01(p), clamp01(s)];
}

// Quadrant geometry (shared so a single dot can be repositioned on re-score).
const Q_W = 900, Q_H = 560, Q_M = 56;
const qx = (p) => Q_M + p * (Q_W - 2 * Q_M);
const qy = (s) => (Q_H - Q_M) - s * (Q_H - 2 * Q_M); // sentiment 1 = top
const qJitterX = (i) => (((i * 53) % 17) - 8) * 0.7;
const qJitterY = (i) => (((i * 31) % 17) - 8) * 0.7;

function renderQuadrant(points) {
  const host = $("#quadrant-plot");
  const W = Q_W, H = Q_H, m = Q_M;
  const x = qx, y = qy;
  const mx = x(0.5), my = y(0.5);

  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);

  const quads = [
    { x: mx, y: m, w: W - m - mx, h: my - m, c: "#22c55e", label: "Reliable wins", lx: W - m - 8, ly: m + 20, a: "end" },
    { x: m, y: m, w: mx - m, h: my - m, c: "#6366f1", label: "Promising bets", lx: m + 8, ly: m + 20, a: "start" },
    { x: mx, y: my, w: W - m - mx, h: H - m - my, c: "#f59e0b", label: "Known risks", lx: W - m - 8, ly: H - m - 10, a: "end" },
    { x: m, y: my, w: mx - m, h: H - m - my, c: "#ef4444", label: "Wildcards", lx: m + 8, ly: H - m - 10, a: "start" },
  ];
  quads.forEach((q) => {
    const r = document.createElementNS(SVG_NS, "rect");
    r.setAttribute("class", "q-fill");
    r.setAttribute("x", q.x); r.setAttribute("y", q.y);
    r.setAttribute("width", q.w); r.setAttribute("height", q.h);
    r.setAttribute("fill", q.c);
    r.setAttribute("fill-opacity", "0.12"); // faint tint so dots stay visible
    svg.appendChild(r);
    const t = document.createElementNS(SVG_NS, "text");
    t.setAttribute("class", "q-corner"); t.setAttribute("x", q.lx); t.setAttribute("y", q.ly);
    t.setAttribute("text-anchor", q.a); t.setAttribute("fill", q.c); t.textContent = q.label;
    svg.appendChild(t);
  });

  [[m, my, W - m, my], [mx, m, mx, H - m]].forEach(([x1, y1, x2, y2]) => {
    const l = document.createElementNS(SVG_NS, "line");
    l.setAttribute("class", "q-axis");
    l.setAttribute("x1", x1); l.setAttribute("y1", y1); l.setAttribute("x2", x2); l.setAttribute("y2", y2);
    svg.appendChild(l);
  });

  [
    { t: "Uncertain", x: m, y: H - 20, a: "start" },
    { t: "Predictable", x: W - m, y: H - 20, a: "end" },
    { t: "↑ Positive", x: mx + 10, y: m + 4, a: "start" },
    { t: "↓ Negative", x: mx + 10, y: H - m - 2, a: "start" },
  ].forEach((a) => {
    const t = document.createElementNS(SVG_NS, "text");
    t.setAttribute("class", "q-axis-label"); t.setAttribute("x", a.x); t.setAttribute("y", a.y);
    t.setAttribute("text-anchor", a.a); t.textContent = a.t;
    svg.appendChild(t);
  });

  const maxPts = Math.max(1, ...points.map((p) => p.points));
  points.forEach((pt, i) => {
    const c = document.createElementNS(SVG_NS, "circle");
    c.setAttribute("class", "q-dot");
    c.setAttribute("cx", x(pt.p) + qJitterX(i)); // tiny jitter so identical scores don't fully overlap
    c.setAttribute("cy", y(pt.s) + qJitterY(i));
    c.setAttribute("r", 4 + Math.sqrt(pt.points / maxPts) * 9);
    c.setAttribute("fill", topicColor(pt.topic));
    if (pt.id != null) { c.setAttribute("data-id", pt.id); c.setAttribute("data-idx", i); }
    const tip = document.createElementNS(SVG_NS, "title");
    tip.textContent = `${pt.title}\n(${pt.topic})${pt.scoredFromSummary ? " · scored from summary" : ""}`;
    c.appendChild(tip);
    c.addEventListener("click", () => window.open(pt.link, "_blank", "noopener"));
    svg.appendChild(c);
  });

  host.innerHTML = "";
  host.appendChild(svg);

  const topics = [...new Set(points.map((p) => p.topic))];
  $("#quadrant-legend").innerHTML = topics
    .map((t) => `<span class="lg"><span class="dot" style="background:${topicColor(t)}"></span>${esc(t)}</span>`)
    .join("");
}

/* ---------- Trend Radar ----------
 * Buckets the last 6 months of AI stories on Hacker News by topic and shows
 * which topics are gaining or losing attention. This is an *attention* signal
 * (what's discussed), not a capability forecast — framed accordingly.
 */
const TREND_MONTHS = 6;
const MONTH_SECS = 30 * 24 * 60 * 60;

async function loadTrends() {
  const grid = $("#trend-grid");
  const outlook = $("#trend-outlook");
  grid.innerHTML = '<div class="state">Analyzing 6 months of AI discussion…</div>';

  const now = Math.floor(Date.now() / 1000);
  const windows = []; // oldest -> newest
  for (let m = TREND_MONTHS - 1; m >= 0; m--) {
    const end = now - m * MONTH_SECS;
    windows.push({ start: end - MONTH_SECS, end });
  }

  try {
    const monthly = await Promise.all(
      windows.map((w) => {
        const nf = encodeURIComponent(`created_at_i>=${w.start},created_at_i<${w.end}`);
        const url =
          "https://hn.algolia.com/api/v1/search_by_date?" +
          `${HN_QUERY}&tags=story&hitsPerPage=100&numericFilters=${nf}`;
        return fetch(url)
          .then((r) => r.json())
          .then((d) => d.hits || [])
          .catch(() => []);
      })
    );

    // Aggregate counts per defined topic per month (skip the "Other" bucket).
    const topics = TOPICS.map((t) => t.key);
    const counts = {};
    topics.forEach((t) => (counts[t] = Array(TREND_MONTHS).fill(0)));
    monthly.forEach((hits, mi) =>
      hits.forEach((h) => {
        if (!h.title) return;
        const topic = classifyTopic(h.title);
        if (topic !== "Other") counts[topic][mi]++;
      })
    );

    renderTrends(counts, topics, windows);
  } catch (err) {
    grid.innerHTML = `<div class="state error">Couldn't load trends: ${esc(err.message)}.</div>`;
    outlook.textContent = "";
  }
}

function momentum(series) {
  const half = Math.floor(TREND_MONTHS / 2);
  const older = series.slice(0, half).reduce((a, b) => a + b, 0) / half;
  const recent = series.slice(half).reduce((a, b) => a + b, 0) / (TREND_MONTHS - half);
  const pct = older > 0 ? ((recent - older) / older) * 100 : recent > 0 ? 100 : 0;
  return { pct: Math.round(pct), older, recent };
}

function trendBadge(pct, total) {
  if (total < 2) return { cls: "flat", label: "→ Sparse", note: "Too few stories to read a trend." };
  if (pct >= 40) return { cls: "up2", label: "🔥 Surging", note: "Heating up fast — on track to dominate the near-term conversation." };
  if (pct >= 15) return { cls: "up1", label: "📈 Rising", note: "Gaining momentum." };
  if (pct <= -40) return { cls: "down2", label: "❄️ Cooling", note: "Attention dropping off sharply." };
  if (pct <= -15) return { cls: "down1", label: "📉 Slowing", note: "Losing momentum." };
  return { cls: "flat", label: "→ Steady", note: "Holding roughly steady." };
}

function renderTrends(counts, topics, windows) {
  const grid = $("#trend-grid");
  const monthLabels = windows.map((w) =>
    new Date(w.end * 1000).toLocaleString(undefined, { month: "short" })
  );

  const rows = topics
    .map((t) => {
      const series = counts[t];
      const total = series.reduce((a, b) => a + b, 0);
      return { topic: t, series, total, ...momentum(series) };
    })
    .filter((r) => r.total > 0)
    .sort((a, b) => b.total - a.total);

  if (!rows.length) {
    grid.innerHTML = '<div class="state">No topic signal in this window.</div>';
    $("#trend-outlook").textContent = "";
    return;
  }

  grid.innerHTML = rows
    .map((r) => {
      const max = Math.max(1, ...r.series);
      const b = trendBadge(r.pct, r.total);
      const bars = r.series
        .map(
          (v, i) =>
            `<span class="spark-bar${i === r.series.length - 1 ? " last" : ""}" ` +
            `style="height:${Math.max(8, Math.round((v / max) * 100))}%" ` +
            `title="${monthLabels[i]}: ${v} stories"></span>`
        )
        .join("");
      const sign = r.pct > 0 ? "+" : "";
      return `
        <div class="trend-cell">
          <div class="t-head">
            <span class="t-name">${esc(r.topic)}</span>
            <span class="t-badge ${b.cls}">${b.label}</span>
          </div>
          <div class="spark">${bars}</div>
          <div class="t-meta">${r.total} stories · ${sign}${r.pct}% vs. prior 3 mo</div>
          <p class="t-note">${b.note}</p>
        </div>`;
    })
    .join("");

  renderOutlook(rows);
}

// Speculative, forward-looking synthesis (clearly caveated in the HTML).
function renderOutlook(rows) {
  const ranked = rows.filter((r) => r.total >= 2);
  const riser = [...ranked].sort((a, b) => b.pct - a.pct)[0];
  const faller = [...ranked].sort((a, b) => a.pct - b.pct)[0];

  let body;
  if (riser && riser.pct >= 15) {
    body =
      `If current momentum holds, <strong>${esc(riser.topic)}</strong> is the storyline to watch ` +
      `heading into next quarter — discussion is up <strong>${riser.pct}%</strong> over six months`;
    if (faller && faller.pct <= -15 && faller.topic !== riser.topic) {
      body += `, while <strong>${esc(faller.topic)}</strong> looks to be cooling (${faller.pct}%)`;
    }
    body += ".";
  } else if (faller && faller.pct <= -15) {
    body = `Attention is broadly flat, with <strong>${esc(faller.topic)}</strong> fading the fastest (${faller.pct}%). No single topic is breaking out yet.`;
  } else {
    body = "AI attention is spread fairly evenly across topics right now — no single storyline is breaking away.";
  }
  $("#trend-outlook").innerHTML = `<span class="lead">Speculative outlook</span>${body}`;
}

async function checkAi() {
  try {
    const res = await fetch("/api/ai_status");
    const status = res.ok ? await res.json() : {};
    aiEnabled = status.enabled === true;
  } catch (_) {
    aiEnabled = false;
  }
}

/* ---------- Newsletter signup ----------
 * Demo: stores subscribers in localStorage. To go live, POST the email
 * to your provider (Mailchimp, Buttondown, ConvertKit, Resend, …) inside
 * the try block below instead of writing to localStorage.
 */

function handleSubscribe(event) {
  event.preventDefault();
  const input = $("#email");
  const msg = $("#form-msg");
  const email = input.value.trim();

  const valid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  if (!valid) {
    msg.textContent = "Please enter a valid email address.";
    msg.className = "form-msg err";
    input.focus();
    return;
  }

  try {
    const KEY = "ai-pulse-subscribers";
    const subs = JSON.parse(localStorage.getItem(KEY) || "[]");
    if (subs.includes(email)) {
      msg.textContent = "You're already subscribed — thanks!";
      msg.className = "form-msg ok";
      return;
    }
    subs.push(email);
    localStorage.setItem(KEY, JSON.stringify(subs));
    msg.textContent = "🎉 You're in! Check your inbox to confirm.";
    msg.className = "form-msg ok";
    input.value = "";
  } catch (_) {
    msg.textContent = "Something went wrong. Please try again.";
    msg.className = "form-msg err";
  }
}

/* ---------- wire up ---------- */

document.addEventListener("DOMContentLoaded", async () => {
  await checkAi();
  loadPapers($("#paper-cat").value);
  loadNews();
  loadTrends();

  $("#paper-cat").addEventListener("change", (e) => loadPapers(e.target.value));
  $("#paper-refresh").addEventListener("click", () => loadPapers($("#paper-cat").value));
  $("#news-refresh").addEventListener("click", () => loadNews());
  $("#news-sort").addEventListener("change", () => renderNews());
  $("#newsletter-form").addEventListener("submit", handleSubscribe);
});
