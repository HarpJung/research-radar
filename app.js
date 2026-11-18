/*
 * Research Radar: app logic (plain JavaScript, no build step).
 * Papers come live from the OpenAlex API (https://openalex.org); the journal lists live in journals.js.
 */
(function () {
  "use strict";

  const CFG = window.RADAR_CONFIG;
  const API = "https://api.openalex.org/works";
  const CROSSREF = "https://api.crossref.org/works";
  const STOPWORDS = new Set(
    ("a about across among an and are as at be been between by can could do does for from has have " +
      "how in into is it its of on or should than that the their them these this those to was were " +
      "what when where which who why will with would").split(" ")
  );
  const SELECT =
    "id,doi,title,publication_date,type,authorships,primary_location," +
    "abstract_inverted_index,open_access,cited_by_count,relevance_score";
  const SSRN_SELECT =
    "id,doi,title,publication_date,created_date,type,authorships,primary_location," +
    "abstract_inverted_index,open_access,cited_by_count,relevance_score";
  const PER_PAGE = { home: 12, neighbors: 12, workingPapers: 6, ssrn: 50 };
  const MONTH_OPTIONS = ["3", "6", "12", "24"];
  const CACHE_PREFIX = "radar.v3:";
  const CACHE_MS = 12 * 60 * 60 * 1000;
  const KEY_STORAGE = "radar.openalexKey";
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

  // ---------- config lookups ----------
  const sourceInfo = new Map();
  Object.entries(CFG.fields).forEach(([fid, f]) =>
    f.journals.forEach((j) => j.ids.forEach((id) => sourceInfo.set(id, { field: fid, journal: j.name })))
  );
  CFG.workingPapers.ids.forEach((id) =>
    sourceInfo.set(id, { field: "nber", journal: CFG.workingPapers.name })
  );
  const SSRN = CFG.ssrn && CFG.ssrn.ids && CFG.ssrn.ids.length ? CFG.ssrn : null;
  if (SSRN) SSRN.ids.forEach((id) => sourceInfo.set(id, { field: "ssrn", journal: SSRN.name }));
  const fieldIds = Object.keys(CFG.fields);
  const idsFor = (fid) => CFG.fields[fid].journals.flatMap((j) => j.ids);
  const idsExcept = (fid) => fieldIds.filter((f) => f !== fid).flatMap(idsFor);
  const trustedIds = fieldIds.flatMap(idsFor);
  const totalJournals = fieldIds.reduce((n, f) => n + CFG.fields[f].journals.length, 0);
  const wpSources = SSRN ? "NBER and SSRN working papers" : "NBER working papers";
  const shortName = (fid) =>
    CFG.fields[fid] ? CFG.fields[fid].short : fid === "nber" ? "NBER" : fid === "ssrn" ? "SSRN" : "Other";
  const idOf = (u) => String(u || "").split("/").pop();
  const BSKY = CFG.bluesky || null;
  const BSKY_API = "https://api.bsky.app/xrpc/app.bsky.feed.searchPosts";
  let bskyState = { query: null, status: "idle", data: null };

  // ---------- DOM ----------
  const $ = (s) => document.querySelector(s);
  const els = {
    form: $("#search-form"),
    topic: $("#topic"),
    field: $("#field"),
    months: $("#months"),
    scan: $("#scan-btn"),
    samples: $("#samples"),
    status: $("#status"),
    results: $("#results"),
    summary: $("#summary"),
    note: $("#snapshot-note"),
    sections: $("#sections"),
    sort: document.querySelector(".sort"),
    journalList: $("#journal-list"),
    about: $("#about"),
    keyInput: $("#api-key"),
    keySave: $("#save-key"),
    keyClear: $("#clear-key"),
    keyStatus: $("#key-status"),
    radarTpl: $("#tpl-radar"),
  };

  let current = null; // the result set on screen
  let sortMode = "relevance";
  let controller = null; // aborts an in-flight search when a new one starts

  // ---------- helpers ----------
  function el(tag, attrs, ...children) {
    const node = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v == null || v === false) continue;
        if (k === "class") node.className = v;
        else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2), v);
        else node.setAttribute(k, v === true ? "" : String(v));
      }
    }
    for (const c of children.flat()) {
      if (c == null || c === false) continue;
      node.append(c instanceof Node ? c : String(c));
    }
    return node;
  }

  // Strip tags and decode entities. Repeats because some abstracts (e.g. SSRN's in Crossref)
  // are HTML that was escaped twice: "&lt;div&gt;We use&amp;nbsp;...".
  const decoder = document.createElement("textarea");
  function cleanText(s) {
    if (!s) return "";
    let t = String(s);
    for (let i = 0; i < 3; i += 1) {
      t = t.replace(/<[^>]*>/g, " ");
      decoder.innerHTML = t;
      const decoded = decoder.value;
      if (decoded === t) break;
      t = decoded;
    }
    return t.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  }
  const titleKey = (t) => cleanText(t).toLowerCase().replace(/[^a-z0-9]+/g, "");

  function safeUrl(u) {
    if (!u) return null;
    try {
      const url = new URL(u);
      return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
    } catch (e) {
      return null;
    }
  }

  const store = {
    get(k) {
      try { return window.localStorage.getItem(k); } catch (e) { return null; }
    },
    set(k, v) {
      try { window.localStorage.setItem(k, v); return true; } catch (e) { return false; }
    },
    del(k) {
      try { window.localStorage.removeItem(k); } catch (e) { /* storage unavailable */ }
    },
  };

  function cleanQuery(q) {
    const words = String(q).match(/[\p{L}\p{N}_'-]+/gu) || [];
    const kept = words.filter((w) => !STOPWORDS.has(w.toLowerCase()));
    return (kept.length ? kept : words).join(" ").trim();
  }

  function sinceDate(months) {
    const d = new Date(Date.now() - Math.round(months * 30.44) * 86400000);
    return d.toISOString().slice(0, 10);
  }

  function fmtMonth(iso) {
    if (!iso) return "";
    const [y, m] = iso.split("-");
    const mi = Number(m) - 1;
    return MONTHS[mi] ? `${MONTHS[mi]} ${y}` : y;
  }

  function fmtDay(iso) {
    if (!iso) return "";
    const [y, m, d] = iso.split("-");
    return `${MONTHS[Number(m) - 1] || ""} ${Number(d)}, ${y}`;
  }

  // ---------- OpenAlex ----------
  function buildFilter(ids, since, journalsOnly) {
    return [
      `from_publication_date:${since}`,
      `primary_location.source.id:${ids.join("|")}`,
      "is_retracted:false",
      journalsOnly ? "type:article|review" : "type:report|preprint|article",
    ].join(",");
  }

  function abstractFromIndex(idx) {
    if (!idx) return "";
    const words = [];
    for (const [w, positions] of Object.entries(idx)) for (const p of positions) words[p] = w;
    return words.filter(Boolean).join(" ");
  }

  function toPaper(w) {
    const loc = w.primary_location || {};
    const src = loc.source || {};
    const sid = (src.id || "").split("/").pop();
    const info = sourceInfo.get(sid) || { field: null, journal: src.display_name || "" };
    const authors = (w.authorships || [])
      .map((a) => (a.author && a.author.display_name) || "")
      .filter(Boolean);
    const oa = w.open_access || {};
    return {
      id: (w.id || "").split("/").pop(),
      title: w.title || "(untitled)",
      url: w.doi || loc.landing_page_url || w.id,
      authors: authors.slice(0, 3),
      authorCount: authors.length,
      journal: info.journal,
      sourceId: sid,
      field: info.field,
      date: w.publication_date,
      abstract: abstractFromIndex(w.abstract_inverted_index),
      oaUrl: oa.is_oa ? oa.oa_url : null,
      citedBy: w.cited_by_count || 0,
      relevance: w.relevance_score,
      type: w.type,
    };
  }

  class RadarError extends Error {
    constructor(kind, message, wait) {
      super(message);
      this.kind = kind;
      this.wait = wait || 0;
    }
  }

  const sleep = (ms, signal) =>
    new Promise((resolve, reject) => {
      const t = setTimeout(resolve, ms);
      if (signal) {
        signal.addEventListener(
          "abort",
          () => {
            clearTimeout(t);
            reject(new DOMException("Aborted", "AbortError"));
          },
          { once: true }
        );
      }
    });

  async function getJson(params, key, signal) {
    if (key) params.set("api_key", key);
    for (let attempt = 0; ; attempt += 1) {
      let res;
      try {
        res = await fetch(`${API}?${params.toString()}`, { signal });
      } catch (e) {
        if (e.name === "AbortError") throw e;
        throw new RadarError("network", "Couldn't reach OpenAlex.");
      }
      if (res.status === 429) {
        // OpenAlex says how long to wait. Short waits (per-second limits) are retried quietly.
        // Longer ones mean keyless search is throttled while OpenAlex is busy (about a minute),
        // or, when the wait runs to midnight UTC, that today's free budget is used up.
        let wait = Number(res.headers.get("Retry-After"));
        if (!Number.isFinite(wait) || wait <= 0) {
          const body = await res.text().catch(() => "");
          const m = body.match(/retry in (\d+)\s*s/i);
          wait = m ? Number(m[1]) : 0;
        }
        if (wait <= 3 && attempt < 2) {
          await sleep((wait || 1) * 1000 + 300, signal);
          continue;
        }
        throw new RadarError(wait > 0 && wait < 3600 ? "busy" : "limit", "Rate limited.", wait);
      }
      if (res.status === 402) throw new RadarError("limit", "Daily limit reached.");
      if (res.status === 401 || res.status === 403) throw new RadarError(key ? "key" : "limit", "Access refused.");
      if (!res.ok) throw new RadarError("http", `OpenAlex returned an error (${res.status}).`);
      return res.json();
    }
  }

  const roundWait = (s) => Math.max(10, Math.ceil((s || 30) / 10) * 10);

  async function fetchSection(query, ids, since, journalsOnly, perPage, key, signal) {
    const params = new URLSearchParams({
      search: query,
      filter: buildFilter(ids, since, journalsOnly),
      per_page: String(perPage),
      select: SELECT,
    });
    const json = await getJson(params, key, signal);
    return {
      count: (json.meta && json.meta.count) || 0,
      papers: (json.results || []).map(toPaper),
    };
  }

  // SSRN has no quality screen, and OpenAlex only gets the posting *year* from it. So:
  //  1. take the 50 best keyword matches from the window's years,
  //  2. keep those that appeared in OpenAlex inside the window (its created_date ≈ posting date),
  //  3. keep only papers with at least one author who has published in the listed journals.
  async function fetchSsrn(query, since, key, signal) {
    const json = await getJson(
      new URLSearchParams({
        search: query,
        filter: `primary_location.source.id:${SSRN.ids.join("|")},from_publication_date:${since.slice(0, 4)}-01-01`,
        per_page: String(PER_PAGE.ssrn),
        select: SSRN_SELECT,
      }),
      key,
      signal
    );
    const seen = new Set();
    const recent = (json.results || []).filter((w) => {
      if (String(w.created_date || "").slice(0, 10) < since) return false;
      const k = titleKey(w.title);
      if (!k || seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    const authorIds = [
      ...new Set(recent.flatMap((w) => (w.authorships || []).map((a) => idOf(a.author && a.author.id)).filter(Boolean))),
    ].slice(0, 100);
    const authorCheck = authorIds.length
      ? getJson(
          new URLSearchParams({
            filter: `authorships.author.id:${authorIds.join("|")},primary_location.source.id:${trustedIds.join("|")}`,
            group_by: "authorships.author.id",
            per_page: "200",
          }),
          key,
          signal
        ).then((g) => new Set((g.group_by || []).map((x) => idOf(x.key))))
      : Promise.resolve(new Set());
    const [published, abstracts] = await Promise.all([authorCheck, crossrefAbstracts(recent, signal)]);
    const papers = recent
      .filter((w) => (w.authorships || []).some((a) => published.has(idOf(a.author && a.author.id))))
      .map((w) => {
        const p = toPaper(w);
        p.date = String(w.created_date || "").slice(0, 10) || null;
        if (!p.abstract) p.abstract = abstracts.get(bareDoi(w.doi)) || "";
        return p;
      });
    return { count: papers.length, candidates: recent.length, papers };
  }

  function bareDoi(u) {
    const m = String(u || "").match(/10\.\d{4,9}\/\S+/);
    return m ? m[0].toLowerCase() : null;
  }

  // OpenAlex doesn't carry SSRN abstracts, but SSRN deposits them with Crossref, whose open API
  // allows calls from web pages. One batch request; if Crossref is slow or down, SSRN cards
  // simply show no abstract.
  async function crossrefAbstracts(works, signal) {
    const dois = [...new Set(works.map((w) => bareDoi(w.doi)).filter(Boolean))].slice(0, 50);
    if (!dois.length) return new Map();
    const params = new URLSearchParams({
      filter: dois.map((d) => `doi:${d}`).join(","),
      rows: String(dois.length),
      select: "DOI,abstract",
    });
    const timeout = new Promise((resolve) => setTimeout(() => resolve(null), 6000));
    try {
      const res = await Promise.race([fetch(`${CROSSREF}?${params.toString()}`, { signal }), timeout]);
      if (!res || !res.ok) return new Map();
      const json = await res.json();
      const items = (json.message && json.message.items) || [];
      return new Map(items.filter((i) => i.abstract).map((i) => [String(i.DOI).toLowerCase(), i.abstract]));
    } catch (e) {
      if (e.name === "AbortError") throw e;
      return new Map();
    }
  }

  // ---------- cache ----------
  function readCache(key) {
    const raw = store.get(CACHE_PREFIX + key);
    if (!raw) return null;
    try {
      const { t, data } = JSON.parse(raw);
      return Date.now() - t < CACHE_MS ? data : null;
    } catch (e) {
      return null;
    }
  }

  function writeCache(key, data) {
    const value = JSON.stringify({ t: Date.now(), data });
    if (store.set(CACHE_PREFIX + key, value)) return;
    try {
      Object.keys(window.localStorage)
        .filter((k) => k.startsWith(CACHE_PREFIX))
        .forEach((k) => store.del(k));
    } catch (e) {
      return;
    }
    store.set(CACHE_PREFIX + key, value);
  }

  // ---------- searching ----------
  async function runLive({ topic, field, months }) {
    const query = cleanQuery(topic);
    if (!query) {
      showMessage("Type a topic first. A few keywords work best.", { error: true });
      els.topic.focus();
      return;
    }
    if (controller) controller.abort();
    controller = new AbortController();
    const { signal } = controller;
    const since = sinceDate(months);
    updateUrl(topic, field, months);

    const cacheKey = [query.toLowerCase(), field, months, since].join("|");
    const cached = readCache(cacheKey);
    if (cached) {
      show(cached);
      return;
    }

    showLoading(`Scanning ${totalJournals} journals plus ${wpSources} for “${query}”…`);
    setBusy(true);
    const key = (store.get(KEY_STORAGE) || "").trim();
    const jobs = [
      ["home", () => fetchSection(query, idsFor(field), since, true, PER_PAGE.home, key, signal)],
      ["neighbors", () => fetchSection(query, idsExcept(field), since, true, PER_PAGE.neighbors, key, signal)],
      ["workingPapers", () => fetchSection(query, CFG.workingPapers.ids, since, false, PER_PAGE.workingPapers, key, signal)],
    ];
    if (SSRN) jobs.push(["ssrn", () => fetchSsrn(query, since, key, signal)]);
    const settled = await Promise.allSettled(jobs.map(([, run]) => run()));
    if (signal.aborted) return;
    setBusy(false);

    const sections = {};
    let failures = 0;
    let firstError = null;
    settled.forEach((r, i) => {
      const name = jobs[i][0];
      if (r.status === "fulfilled") {
        sections[name] = r.value;
      } else {
        failures += 1;
        firstError = firstError || r.reason;
        sections[name] = { error: true, count: 0, papers: [] };
      }
    });
    if (failures === jobs.length) {
      showError(firstError, { topic, field, months });
      return;
    }
    const problem = failures ? { kind: (firstError && firstError.kind) || "network", wait: (firstError && firstError.wait) || 0 } : null;
    const data = { topic, field, months, query, since, savedAt: null, sections, problem };
    if (!failures) writeCache(cacheKey, data);
    show(data, { scroll: true });
  }

  async function runSample(sample) {
    els.topic.value = sample.topic;
    els.field.value = sample.field;
    els.months.value = String(sample.months);
    if (controller) controller.abort();
    setBusy(false);
    try {
      const res = await fetch(sample.file);
      if (!res.ok) throw new Error(String(res.status));
      const data = await res.json();
      updateUrl(sample.topic, sample.field, sample.months);
      show(data, { scroll: true });
    } catch (e) {
      // Saved file unavailable (e.g., page opened straight from disk): search live instead.
      runLive({ topic: sample.topic, field: sample.field, months: sample.months });
    }
  }

  function updateUrl(topic, field, months) {
    const p = new URLSearchParams({ q: topic, field, months: String(months) });
    try {
      history.replaceState(null, "", `${location.pathname}?${p.toString()}`);
    } catch (e) {
      /* some embedded viewers block history changes */
    }
  }

  function readUrl() {
    const p = new URLSearchParams(location.search);
    const q = (p.get("q") || "").trim().slice(0, 200);
    if (!q) return null;
    const field = CFG.fields[p.get("field")] ? p.get("field") : fieldIds[0];
    const months = MONTH_OPTIONS.includes(p.get("months")) ? Number(p.get("months")) : 12;
    return { topic: q, field, months };
  }

  // ---------- status ----------
  function setBusy(busy) {
    els.scan.disabled = busy;
    els.scan.textContent = busy ? "Scanning…" : "Scan";
    els.form.setAttribute("aria-busy", busy ? "true" : "false");
  }

  function showLoading(text) {
    els.results.hidden = true;
    els.status.className = "status";
    els.status.replaceChildren(els.radarTpl.content.cloneNode(true), el("p", null, text));
    els.status.hidden = false;
  }

  function showMessage(text, { error = false, actions = [] } = {}) {
    els.status.className = error ? "status is-error" : "status";
    const body = el("div", null, el("p", null, text));
    if (actions.length) body.append(el("div", { class: "status-actions" }, actions));
    els.status.replaceChildren(body);
    els.status.hidden = false;
  }

  function openKeySettings() {
    els.about.open = true;
    els.keyInput.focus();
    els.keyInput.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  function showError(err, params) {
    const kind = (err && err.kind) || "network";
    const keyBtn = el("button", { type: "button", class: "btn btn-secondary", onclick: openKeySettings }, "Add a free key");
    let text;
    let actions = [keyBtn];
    if (kind === "busy") {
      text = `OpenAlex is limiting searches made without an API key right now (its servers are busy). Try again in about ${roundWait(err.wait)} seconds, or add a free key for uninterrupted access. The sample topics always work.`;
      if (params) {
        actions = [el("button", { type: "button", class: "btn btn-secondary", onclick: () => runLive(params) }, "Try again"), keyBtn];
      }
    } else if (kind === "limit") {
      text = "Your network has used up today's free OpenAlex searches. The sample topics still work. To keep searching, add a free OpenAlex key (takes about a minute).";
    } else if (kind === "key") {
      text = "OpenAlex didn't accept your saved API key. Check it or remove it under “How it works”.";
      actions = [el("button", { type: "button", class: "btn btn-secondary", onclick: openKeySettings }, "Check key")];
    } else if (kind === "http") {
      text = `${err.message} Please try again in a moment.`;
      actions = [];
    } else {
      text = "Couldn't reach OpenAlex. Check your connection and try again. If you've run many searches today, your network may have hit OpenAlex's free daily limit; the sample topics still work, or add a free key.";
    }
    els.results.hidden = true;
    showMessage(text, { error: true, actions });
  }

  // ---------- relevance tiers ----------
  // Papers whose title/abstract contain the topic words go first; the rest (matched by OpenAlex
  // on the full text) are listed after them with a "Weaker match" tag. Nothing is dropped.
  const expandAI = (s) => String(s || "").toLowerCase().replace(/\b(gen)?ai\b/g, "artificial intelligence");
  const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  function termPatterns(query) {
    const words = (expandAI(query).match(/[\p{L}\p{N}_'-]+/gu) || []).filter((w) => !STOPWORDS.has(w));
    return words.map((t) =>
      t.length <= 3
        ? new RegExp(`\\b${escapeRe(t)}\\b`)
        : new RegExp(`\\b${escapeRe(t.slice(0, Math.max(4, Math.round(t.length * 0.6))))}`)
    );
  }

  function isStrongMatch(p, patterns) {
    if (!patterns.length) return true;
    // Journal papers without an abstract: can't tell, so trust OpenAlex's match.
    // SSRN papers whose abstract Crossref couldn't supply are judged on the title alone.
    if (!p.abstract && p.field !== "ssrn") return true;
    const text = expandAI(cleanText(p.title) + " " + cleanText(p.abstract));
    const hits = patterns.filter((re) => re.test(text)).length;
    return hits > 0 && hits * 2 >= patterns.length;
  }

  // ---------- Bluesky: links people are sharing ----------
  // Public Bluesky posts from the last few weeks that mention the topic AND link somewhere.
  // Posts are grouped by the page they link to; each account counts once per link (so one account
  // re-posting can't inflate it); links are ranked by how many accounts shared them. Known news,
  // research and policy sites come first. Only links and counts are shown, not names or post text.
  const hostMatches = (host, domains) => (domains || []).some((d) => host === d || host.endsWith(`.${d}`));

  function linkKind(host) {
    if (/\.gov(\.[a-z]{2})?$/.test(host)) return "Policy";
    for (const [kind, domains] of Object.entries(BSKY.trusted || {})) if (hostMatches(host, domains)) return kind;
    return null;
  }

  function postLinks(post) {
    const out = new Map();
    const emb = post.embed || {};
    const ext = emb.external || (emb.media && emb.media.external);
    if (ext && ext.uri) out.set(ext.uri, { title: ext.title || "", description: ext.description || "" });
    for (const facet of (post.record && post.record.facets) || []) {
      for (const feat of facet.features || []) {
        if (feat.$type === "app.bsky.richtext.facet#link" && feat.uri && !out.has(feat.uri)) {
          out.set(feat.uri, { title: "", description: "" });
        }
      }
    }
    return out;
  }

  function postUrl(post) {
    const rkey = String(post.uri || "").split("/").pop();
    const who = (post.author && (post.author.handle || post.author.did)) || "";
    return who && rkey ? `https://bsky.app/profile/${who}/post/${rkey}` : null;
  }

  async function fetchBluesky(query) {
    const since = new Date(Date.now() - (BSKY.days || 30) * 86400000).toISOString();
    const params = new URLSearchParams({ q: query, sort: "top", limit: "100", lang: "en", since });
    const res = await fetch(`${BSKY_API}?${params.toString()}`);
    if (!res.ok) throw new Error(`Bluesky returned ${res.status}`);
    const posts = (await res.json()).posts || [];
    const groups = new Map();
    for (const post of posts) {
      const author = (post.author && post.author.did) || "";
      const engagement = (post.likeCount || 0) + 2 * (post.repostCount || 0);
      for (const [uri, meta] of postLinks(post)) {
        let u;
        try {
          u = new URL(uri);
        } catch (e) {
          continue;
        }
        if (u.protocol !== "https:" && u.protocol !== "http:") continue;
        const host = u.hostname.toLowerCase().replace(/^www\./, "");
        if (hostMatches(host, BSKY.blocked)) continue;
        const key = host + u.pathname.replace(/\/+$/, "");
        let g = groups.get(key);
        if (!g) {
          g = { url: u.href, host, path: u.pathname, kind: linkKind(host), title: "", description: "", who: new Set(), likes: 0, top: null, topEng: -1 };
          groups.set(key, g);
        }
        if (!g.who.has(author)) {
          g.who.add(author);
          g.likes += post.likeCount || 0;
        }
        if (!g.title && meta.title) g.title = meta.title;
        if (!g.description && meta.description) g.description = meta.description;
        if (engagement > g.topEng) {
          g.topEng = engagement;
          g.top = postUrl(post);
        }
      }
    }
    const links = [...groups.values()]
      .map((g) => ({ url: g.url, host: g.host, path: g.path, kind: g.kind, title: g.title, description: g.description, accounts: g.who.size, likes: g.likes, top: g.top }))
      .sort((a, b) => b.accounts - a.accounts || b.likes - a.likes);
    return { posts: posts.length, links };
  }

  function startBluesky(query) {
    bskyState = { query, status: "loading", data: null };
    fetchBluesky(query)
      .then((data) => {
        if (bskyState.query !== query) return;
        bskyState = { query, status: "ok", data };
        updateBlueskySlot();
      })
      .catch(() => {
        if (bskyState.query !== query) return;
        bskyState = { query, status: "error", data: null };
        updateBlueskySlot();
      });
  }

  function updateBlueskySlot() {
    const slot = document.getElementById("bsky-slot");
    if (slot) slot.replaceChildren(renderBlueskySection());
  }

  function renderBlueskySection() {
    const baseSub = `Links in public Bluesky posts about this topic, last ${BSKY.days || 30} days`;
    const head = (sub, extra) =>
      el(
        "header",
        { class: "section-head" },
        el("h2", { id: "sec-bluesky" }, el("span", { class: "dot", "data-field": "bluesky", "aria-hidden": "true" }), "Shared on Bluesky"),
        el("p", { class: "section-sub" }, sub),
        extra || null
      );
    const wrap = (...kids) => el("section", { class: "section", "aria-labelledby": "sec-bluesky" }, ...kids);

    if (bskyState.status === "loading" || bskyState.status === "idle") return wrap(head(`${baseSub} · loading…`));
    if (bskyState.status === "error") {
      return wrap(head(baseSub), el("p", { class: "empty" }, "Bluesky didn't load this time. Try scanning again later."));
    }
    const { posts, links } = bskyState.data;
    const trusted = links.filter((l) => l.kind);
    const other = links.filter((l) => !l.kind).slice(0, 10);
    const ordered = trusted.concat(other);
    const sub = `${baseSub} · ${links.length} ${links.length === 1 ? "link" : "links"} found in ${posts} posts`;
    if (!ordered.length) {
      return wrap(
        head(sub),
        el("p", { class: "empty" }, "No links shared on Bluesky about this topic lately. This list works best for topics that are in the news.")
      );
    }
    const mix = new Map();
    trusted.forEach((l) => mix.set(l.kind, (mix.get(l.kind) || 0) + 1));
    if (other.length) mix.set("Other sites", other.length);
    const chips = [...mix.entries()].map(([k, n]) => el("span", { class: "badge", "data-kind": k }, `${k} · ${n}`));

    const visibleCount = Math.min(5, trusted.length || ordered.length);
    const visible = ordered.slice(0, visibleCount);
    const rest = ordered.slice(visibleCount);
    const body = [el("ol", { class: "cards" }, visible.map(renderLinkCard))];
    if (rest.length) {
      const more = el("ol", { class: "cards", hidden: true, id: "more-bluesky" }, rest.map(renderLinkCard));
      const n = rest.length;
      const label = rest.every((l) => !l.kind)
        ? `Show ${n} ${n === 1 ? "link" : "links"} from other sites`
        : `Show ${n} more ${n === 1 ? "link" : "links"}`;
      body.push(
        el(
          "button",
          {
            type: "button",
            class: "more-btn",
            "aria-expanded": "false",
            "aria-controls": "more-bluesky",
            onclick: (e) => {
              more.hidden = false;
              e.currentTarget.remove();
            },
          },
          label
        ),
        more
      );
    }
    return wrap(head(sub, el("div", { class: "mix", "aria-label": "Kinds of sites" }, chips)), ...body);
  }

  function renderLinkCard(l) {
    const url = safeUrl(l.url);
    const title = cleanText(l.title) || `${l.host}${l.path && l.path !== "/" ? l.path : ""}`;
    const badge = l.kind
      ? el("span", { class: "badge", "data-kind": l.kind }, l.kind)
      : el("span", { class: "tag-weak", title: "Not on Research Radar's list of news, research and policy sites" }, "Other site");
    const shared =
      `shared by ${l.accounts} ${l.accounts === 1 ? "account" : "accounts"}` +
      (l.likes ? ` · ${l.likes.toLocaleString("en-US")} ${l.likes === 1 ? "like" : "likes"}` : "");
    const desc = cleanText(l.description);
    const topUrl = safeUrl(l.top);
    return el(
      "li",
      { class: l.kind ? "card" : "card is-weak", "data-kind": l.kind || "none" },
      el("div", { class: "card-badges" }, badge),
      el("h3", { class: "card-title" }, url ? el("a", { href: url, target: "_blank", rel: "noopener" }, title) : title),
      el("p", { class: "card-source" }, el("span", { class: "journal" }, l.host), ` · ${shared}`),
      desc ? el("p", { class: "card-abstract" }, desc) : null,
      topUrl ? el("a", { class: "post-link", href: topUrl, target: "_blank", rel: "noopener" }, "See the most-liked post on Bluesky ↗") : null
    );
  }

  // ---------- rendering ----------
  function show(data, { scroll = false } = {}) {
    current = data;
    els.status.hidden = true;
    render();
    els.results.hidden = false;
    if (scroll) {
      const top = els.results.getBoundingClientRect().top;
      if (top > window.innerHeight * 0.6) els.results.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }

  function render() {
    const d = current;
    if (!d) return;
    const homeField = CFG.fields[d.field] || CFG.fields[fieldIds[0]];
    const patterns = termPatterns(d.query);

    // Same paper in two lists (e.g. NBER version and journal version): keep the first.
    const seen = new Set();
    const prepare = (section) => {
      const unique = (section.papers || []).filter((p) => {
        const k = titleKey(p.title);
        if (!k || seen.has(k)) return false;
        seen.add(k);
        return true;
      });
      const tagged = unique.map((p, i) => ({ p, i, strong: isStrongMatch(p, patterns) }));
      tagged.sort((a, b) => {
        if (a.strong !== b.strong) return a.strong ? -1 : 1;
        if (sortMode === "newest") return String(b.p.date || "").localeCompare(String(a.p.date || ""));
        return a.i - b.i;
      });
      return tagged;
    };

    const home = prepare(d.sections.home || { papers: [] });
    const neighbors = prepare(d.sections.neighbors || { papers: [] });
    const nber = prepare(d.sections.workingPapers || { papers: [] });
    const ssrn = prepare(d.sections.ssrn || { papers: [] });
    const wps = mergeWorkingPapers(nber, ssrn);
    const nberResult = d.sections.workingPapers || { papers: [] };
    const ssrnResult = d.sections.ssrn || null;
    const wpResult = {
      error: Boolean(nberResult.error && (!ssrnResult || ssrnResult.error)),
      count: (nberResult.count || 0) + ((ssrnResult && ssrnResult.count) || 0),
    };
    const ssrnFailed = Boolean(SSRN && ssrnResult && ssrnResult.error && !nberResult.error);

    els.summary.replaceChildren(
      "Searched ",
      el("strong", null, `${totalJournals} journals`),
      ` plus ${wpSources} for `,
      el("strong", null, `“${d.query}”`),
      ` · published since ${fmtMonth(d.since)}`
    );

    if (d.savedAt) {
      els.note.replaceChildren(
        el("span", null, `Saved results for this sample (from ${fmtDay(d.savedAt)}).`),
        el(
          "button",
          { type: "button", class: "link-btn", onclick: () => runLive({ topic: d.topic, field: d.field, months: d.months }) },
          "Run a live search"
        )
      );
      els.note.hidden = false;
    } else if (d.problem) {
      // Some lists loaded and some didn't: keep what we have and say why the rest is missing.
      const reasons = {
        busy: `OpenAlex is limiting searches without an API key right now. Try again in about ${roundWait(d.problem.wait)} seconds.`,
        limit: "Your network has used up today's free OpenAlex searches.",
        key: "OpenAlex didn't accept your saved API key.",
      };
      els.note.replaceChildren(
        el("span", null, `Some lists didn't load. ${reasons[d.problem.kind] || "Try again in a moment."}`),
        el("button", { type: "button", class: "link-btn", onclick: () => runLive({ topic: d.topic, field: d.field, months: d.months }) }, "Try again"),
        el("button", { type: "button", class: "link-btn", onclick: openKeySettings }, "Add a free key")
      );
      els.note.hidden = false;
    } else {
      els.note.hidden = true;
    }

    // Field mix for the neighboring-fields section.
    const mix = new Map();
    neighbors.forEach(({ p }) => mix.set(p.field, (mix.get(p.field) || 0) + 1));
    const mixChips = [...mix.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([fid, n]) => el("span", { class: "badge", "data-field": fid }, `${shortName(fid)} · ${n}`));

    els.sections.replaceChildren(
      renderSection({
        id: "home",
        dotField: d.field,
        title: `From your field: ${homeField.short}`,
        sub: `${homeField.journals.length} top ${homeField.short} journals`,
        result: d.sections.home,
        items: home,
        showField: false,
        empty: `No matches in ${homeField.short} journals in this window. Try broader keywords or a longer time window. The neighboring fields below may still have work on it.`,
      }),
      renderSection({
        id: "neighbors",
        dotField: null,
        title: "From neighboring fields",
        sub: "Other fields' top journals that publish on this topic",
        result: d.sections.neighbors,
        items: neighbors,
        showField: true,
        extra: mixChips.length ? el("div", { class: "mix", "aria-label": "Neighboring fields found" }, mixChips) : null,
        empty: "No matches in the other fields' journals. This topic looks specific to your field.",
      }),
      renderSection({
        id: "working-papers",
        dotField: "nber",
        title: "New working papers",
        sub: SSRN
          ? `NBER and SSRN (SSRN only from authors who have published in the listed journals)${ssrnFailed ? "; SSRN didn't load this time" : ""}`
          : "NBER · research that often circulates before journal publication",
        result: wpResult,
        items: wps,
        showField: false,
        workingPaper: true,
        limit: SSRN ? 6 : 4,
        empty: `No matching ${wpSources} in this window.`,
      })
    );

    // Bluesky loads separately (it's free and needs no key), so the paper lists never wait for it.
    if (BSKY) {
      if (bskyState.query !== d.query || bskyState.status === "error") startBluesky(d.query);
      els.sections.append(el("div", { id: "bsky-slot" }, renderBlueskySection()));
    }
  }

  // Alternate NBER and SSRN so neither source crowds out the other; weaker matches go last.
  function mergeWorkingPapers(nber, ssrn) {
    const interleave = (a, b) => {
      const out = [];
      for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
        if (a[i]) out.push(a[i]);
        if (b[i]) out.push(b[i]);
      }
      return out;
    };
    const strong = interleave(nber.filter((x) => x.strong), ssrn.filter((x) => x.strong));
    const weak = interleave(nber.filter((x) => !x.strong), ssrn.filter((x) => !x.strong));
    if (sortMode === "newest") {
      const byDate = (x, y) => String(y.p.date || "").localeCompare(String(x.p.date || ""));
      strong.sort(byDate);
      weak.sort(byDate);
    }
    return strong.concat(weak);
  }

  function countText(result, shown) {
    if (!result || result.error) return "couldn't load";
    const n = result.count || 0;
    if (n > shown) return `top ${shown} of ${n.toLocaleString("en-US")} matches`;
    return `${n} ${n === 1 ? "match" : "matches"}`;
  }

  function renderSection({ id, dotField, title, sub, result, items, showField, workingPaper, extra, empty, limit = 5 }) {
    const head = el(
      "header",
      { class: "section-head" },
      el(
        "h2",
        { id: `sec-${id}` },
        el("span", { class: "dot", "data-field": dotField || "none", "aria-hidden": "true" }),
        title
      ),
      el("p", { class: "section-sub" }, `${sub} · ${countText(result, items.length)}`),
      extra || null
    );
    const cardsFor = (list) => list.map(({ p, strong }) => renderCard(p, { showField, workingPaper, strong }));
    let body;
    if (result && result.error) {
      body = el("p", { class: "empty" }, "This part of the search didn't load. Try scanning again in a moment.");
    } else if (!items.length) {
      body = el("p", { class: "empty" }, empty);
    } else {
      // Keep each list short so all three sections fit on a screen or two: show the top few
      // strong matches and fold the rest (including full-text-only matches) behind "Show more".
      const strongCount = items.filter((x) => x.strong).length;
      const visibleCount = Math.min(limit, strongCount || items.length);
      const visible = items.slice(0, visibleCount);
      const rest = items.slice(visibleCount);
      if (!rest.length) {
        body = el("ol", { class: "cards" }, cardsFor(visible));
      } else {
        const more = el("ol", { class: "cards cards-more", hidden: true, id: `more-${id}` }, cardsFor(rest));
        const n = rest.length;
        const onlyWeak = rest.every((x) => !x.strong);
        const label = onlyWeak
          ? `Show ${n} weaker ${n === 1 ? "match" : "matches"}`
          : `Show ${n} more ${n === 1 ? "paper" : "papers"}`;
        const btn = el(
          "button",
          {
            type: "button",
            class: "more-btn",
            "aria-expanded": "false",
            "aria-controls": `more-${id}`,
            onclick: (e) => {
              more.hidden = false;
              e.currentTarget.remove();
            },
          },
          label
        );
        body = el("div", null, el("ol", { class: "cards" }, cardsFor(visible)), btn, more);
      }
    }
    return el("section", { class: "section", "aria-labelledby": `sec-${id}` }, head, body);
  }

  function renderCard(p, { showField, workingPaper, strong }) {
    const title = cleanText(p.title) || "(untitled)";
    const url = safeUrl(p.url);
    const oaUrl = safeUrl(p.oaUrl);
    const abstract = cleanText(p.abstract).replace(/^abstract\s*[:.\-–—]?\s*/i, "");

    const badges = [];
    if (showField && p.field) badges.push(el("span", { class: "badge", "data-field": p.field }, shortName(p.field)));
    if (workingPaper) {
      const isSsrn = p.field === "ssrn";
      badges.push(el("span", { class: "badge", "data-field": isSsrn ? "ssrn" : "nber" }, isSsrn ? "SSRN" : "NBER"));
    }
    if (oaUrl) badges.push(el("a", { class: "badge badge-oa", href: oaUrl, target: "_blank", rel: "noopener" }, "Free to read"));
    if (!strong) {
      badges.push(
        el(
          "span",
          { class: "tag-weak", title: "Your keywords don't appear in this paper's title or abstract, so it may be less central to your topic." },
          "Weaker match"
        )
      );
    }

    const authorLine = p.authors && p.authors.length
      ? p.authors.join(", ") + (p.authorCount > p.authors.length ? " et al." : "")
      : null;

    const sourceBits = [el("span", { class: "journal" }, p.journal || "")];
    if (p.date) {
      const dateTip = p.field === "ssrn" ? "When the paper appeared in OpenAlex (SSRN shares only the year)" : null;
      sourceBits.push(" · ", el("time", { datetime: p.date, title: dateTip }, fmtMonth(p.date)));
    }
    if (p.citedBy > 0) sourceBits.push(` · cited by ${p.citedBy}`);

    const abstractId = `abs-${p.id}`;
    let abstractNode;
    let toggle = null;
    if (abstract) {
      abstractNode = el("p", { class: "card-abstract", id: abstractId }, abstract);
      if (abstract.length > 240) {
        toggle = el(
          "button",
          {
            type: "button",
            class: "toggle",
            "aria-expanded": "false",
            "aria-controls": abstractId,
            onclick: (e) => {
              const open = abstractNode.classList.toggle("is-open");
              e.currentTarget.setAttribute("aria-expanded", String(open));
              e.currentTarget.textContent = open ? "Show less" : "Show full abstract";
            },
          },
          "Show full abstract"
        );
      }
    } else {
      abstractNode = el(
        "p",
        { class: "card-abstract is-missing" },
        p.field === "ssrn"
          ? "No abstract available here. Open the paper to read it on SSRN."
          : "No abstract available from the publisher. Open the paper for details."
      );
    }

    return el(
      "li",
      { class: strong ? "card" : "card is-weak", "data-field": p.field || "none" },
      badges.length ? el("div", { class: "card-badges" }, badges) : null,
      el(
        "h3",
        { class: "card-title" },
        url ? el("a", { href: url, target: "_blank", rel: "noopener" }, title) : title
      ),
      authorLine ? el("p", { class: "card-authors" }, authorLine) : null,
      el("p", { class: "card-source" }, sourceBits),
      abstractNode,
      toggle
    );
  }

  // ---------- static parts ----------
  function renderFieldSelect() {
    els.field.replaceChildren(
      ...CFG.groups.map((g) =>
        el("optgroup", { label: g.label }, g.fields.map((fid) => el("option", { value: fid }, CFG.fields[fid].name)))
      )
    );
  }

  function renderSamples() {
    CFG.samples.forEach((s) => {
      els.samples.append(
        el(
          "button",
          { type: "button", class: "chip", onclick: () => runSample(s) },
          s.label,
          el("span", { class: "chip-field" }, shortName(s.field))
        )
      );
    });
  }

  function renderJournalList() {
    const blocks = CFG.groups.flatMap((g) => g.fields).map((fid) => {
      const f = CFG.fields[fid];
      return el(
        "div",
        { class: "jl-block" },
        el("h3", null, el("span", { class: "dot", "data-field": fid, "aria-hidden": "true" }), f.name),
        el("ul", null, f.journals.map((j) => el("li", null, j.name)))
      );
    });
    blocks.push(
      el(
        "div",
        { class: "jl-block" },
        el("h3", null, el("span", { class: "dot", "data-field": "nber", "aria-hidden": "true" }), "Working papers"),
        el(
          "ul",
          null,
          el("li", null, CFG.workingPapers.name),
          SSRN ? el("li", null, `${SSRN.name} (only papers by authors who have published in the journals above)`) : null
        )
      )
    );
    els.journalList.replaceChildren(...blocks);
  }

  function initKeyUi() {
    const refresh = (msg) => {
      const has = Boolean(store.get(KEY_STORAGE));
      els.keyStatus.textContent = msg || (has ? "A key is saved in this browser." : "");
      els.keyClear.hidden = !has;
    };
    els.keySave.addEventListener("click", () => {
      const v = els.keyInput.value.trim();
      if (!v) {
        refresh("Paste a key first.");
        return;
      }
      if (store.set(KEY_STORAGE, v)) {
        els.keyInput.value = "";
        refresh("Saved. Your searches now use your own key.");
      } else {
        refresh("This browser blocked saving the key (private mode?).");
      }
    });
    els.keyClear.addEventListener("click", () => {
      store.del(KEY_STORAGE);
      refresh("Key removed.");
    });
    refresh();
  }

  function init() {
    if (!CFG || !CFG.fields) {
      showMessage("Couldn't load the journal list (journals.js).", { error: true });
      return;
    }
    renderFieldSelect();
    renderSamples();
    renderJournalList();
    initKeyUi();

    els.form.addEventListener("submit", (e) => {
      e.preventDefault();
      runLive({ topic: els.topic.value.trim(), field: els.field.value, months: Number(els.months.value) });
    });

    els.sort.addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-sort]");
      if (!btn) return;
      sortMode = btn.dataset.sort;
      els.sort.querySelectorAll("button[data-sort]").forEach((b) => b.setAttribute("aria-pressed", String(b === btn)));
      render();
    });

    const fromUrl = readUrl();
    if (fromUrl) {
      // A shared link to a sample topic loads the saved results (no API budget used).
      const sample = CFG.samples.find(
        (s) =>
          s.topic.toLowerCase() === fromUrl.topic.toLowerCase() &&
          s.field === fromUrl.field &&
          s.months === fromUrl.months
      );
      if (sample) {
        runSample(sample);
        return;
      }
      els.topic.value = fromUrl.topic;
      els.field.value = fromUrl.field;
      els.months.value = String(fromUrl.months);
      runLive(fromUrl);
    }
  }

  init();
})();
