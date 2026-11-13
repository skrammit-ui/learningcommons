/* Student Grouping Planner
 * Everything runs in the browser. Student data is never sent anywhere.
 * Knowledge Graph data: window.KG_DATA (data/kg-math-k8.js).
 */
(function () {
  "use strict";

  const KG = window.KG_DATA;
  const GRADE_ORDER = ["K", "1", "2", "3", "4", "5", "6", "7", "8"];
  const state = { data: null, result: null, overrides: {} };

  // ---------- helpers ----------
  const $ = (sel) => document.querySelector(sel);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
  const round = (x) => (Number.isFinite(x) ? Math.round(x) : "—");
  const gradeIdx = (g) => GRADE_ORDER.indexOf(g);
  const gradeName = (g) => (g === "K" ? "Kindergarten" : `Grade ${g}`);
  const codeSort = (a, b) => {
    const pa = a.split("."), pb = b.split(".");
    const ga = gradeIdx(pa[0]), gb = gradeIdx(pb[0]);
    if (ga !== gb) return ga - gb;
    for (let i = 1; i < Math.max(pa.length, pb.length); i++) {
      const x = pa[i] ?? "", y = pb[i] ?? "";
      const nx = Number(x), ny = Number(y);
      const c = !isNaN(nx) && !isNaN(ny) && x !== "" && y !== "" ? nx - ny : x.localeCompare(y);
      if (c) return c;
    }
    return 0;
  };

  function thresholds() {
    const prof = Number($("#t-prof").value) || 80;
    let app = Number($("#t-app").value);
    if (!Number.isFinite(app)) app = 60;
    return { prof, app: Math.min(app, prof - 1) };
  }
  function band(v, t = thresholds()) {
    if (!Number.isFinite(v)) return "none";
    return v >= t.prof ? "prof" : v >= t.app ? "app" : "need";
  }
  const BAND_LABEL = { prof: "Proficient", app: "Approaching", need: "Needs support", none: "No data" };

  // Seeded RNG so the same file always gives the same groups.
  function rng(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // ---------- CSV parsing ----------
  function parseCSV(text) {
    text = text.replace(/^﻿/, "");
    const firstLine = text.split(/\r?\n/, 1)[0];
    const delim = (firstLine.match(/\t/g) || []).length > (firstLine.match(/,/g) || []).length ? "\t"
      : (firstLine.match(/;/g) || []).length > (firstLine.match(/,/g) || []).length ? ";" : ",";
    const rows = [];
    let row = [], field = "", q = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (q) {
        if (c === '"') {
          if (text[i + 1] === '"') { field += '"'; i++; } else q = false;
        } else field += c;
      } else if (c === '"') q = true;
      else if (c === delim) { row.push(field); field = ""; }
      else if (c === "\n" || c === "\r") {
        if (c === "\r" && text[i + 1] === "\n") i++;
        row.push(field); field = "";
        if (row.some((f) => f.trim() !== "")) rows.push(row);
        row = [];
      } else field += c;
    }
    row.push(field);
    if (row.some((f) => f.trim() !== "")) rows.push(row);
    return rows.map((r) => r.map((f) => f.trim()));
  }

  // Find a Common Core math code in a header or cell, e.g. "4.NF.B", "4.NF.B.3", "4.NF.3", "CCSS.MATH.CONTENT.4.NF.B.3".
  function matchCode(str) {
    const s = String(str || "").toUpperCase().replace(/^CCSS\.MATH\.CONTENT\./, "");
    let m = s.match(/(?:^|[^A-Z0-9.])?(K|[1-8])\.([A-Z]{1,4})\.([A-Z])(?:\.(\d+)(?:\.?([A-Z]))?)?(?![A-Z0-9])/);
    if (m) {
      const cluster = `${m[1]}.${m[2]}.${m[3]}`;
      if (KG.clusters[cluster]) {
        const std = m[4] ? `${cluster}.${m[4]}` : null;
        return { cluster, standard: std && KG.standards[std] ? std : null };
      }
    }
    m = s.match(/(K|[1-8])\.([A-Z]{1,4})\.(\d+)/);
    if (m) {
      const std = KG.alt[`${m[1]}.${m[2]}.${m[3]}`];
      if (std) return { cluster: KG.standards[std].cl, standard: std };
    }
    return null;
  }

  function parseScore(raw) {
    if (raw == null) return NaN;
    let s = String(raw).trim();
    if (!s || /^(n\/?a|na|-|—|absent|ex|excused)$/i.test(s)) return NaN;
    let pct = false;
    if (s.endsWith("%")) { pct = true; s = s.slice(0, -1); }
    const frac = s.match(/^(\d+(?:\.\d+)?)\s*(?:\/|out of)\s*(\d+(?:\.\d+)?)$/i);
    if (frac) return Number(frac[2]) ? (Number(frac[1]) / Number(frac[2])) * 100 : NaN;
    const v = Number(s.replace(/,/g, ""));
    if (!Number.isFinite(v)) return NaN;
    return pct ? v : v; // scale decided per column later
  }

  // Turn rows into { students:[{name, scores:{cluster: value}}], clusters, notes }
  function interpret(rows) {
    const notes = [];
    if (rows.length < 2) throw new Error("The file needs a header row and at least one student row.");
    const header = rows[0];
    const body = rows.slice(1);
    const lower = header.map((h) => h.toLowerCase());

    const nameCol = (() => {
      const i = lower.findIndex((h) => /^(student|name|student name|full name|learner|id|student id)$/.test(h));
      if (i >= 0) return i;
      const j = lower.findIndex((h) => /student|name|learner/.test(h));
      return j >= 0 ? j : 0;
    })();
    const codeCols = header.map((h, i) => (i === nameCol ? null : matchCode(h)));
    const isWide = codeCols.some(Boolean);

    // Assessment-report columns (PRoPL and similar exports) kept as student info, not scores.
    const META = [
      ["level", /^(performance|achievement|proficiency) level$|^level$/i],
      ["scale", /^scale ?score$/i],
      ["id", /^(identifier|student id|id|sis id|state id)$/i],
    ];
    const metaCols = {};
    META.forEach(([key, re]) => { const i = header.findIndex((h, j) => j !== nameCol && re.test(h)); if (i >= 0) metaCols[key] = i; });
    const known = /^(quantile|lexile|national norm|percentile|national percentile|rc\d+|reporting category.*|test|assessment|form|subject)$/i;

    let entries = []; // {name, cluster, standard, raw}
    const meta = {};
    if (isWide) {
      const unmatched = header.filter((h, i) => i !== nameCol && !codeCols[i] && h);
      const ignorable = unmatched.filter((h, i) => !Object.values(metaCols).includes(header.indexOf(h)) && !known.test(h) &&
        !/^(first|last|first name|last name|grade|class|section|period|teacher|school|email|date)$/i.test(h));
      if (ignorable.length) notes.push({ type: "warn", text: `Ignored columns that aren't Common Core math K–8 cluster or standard codes: ${ignorable.map(esc).join(", ")}.` });
      body.forEach((r) => {
        const name = r[nameCol];
        if (!name) return;
        meta[name] = Object.fromEntries(Object.entries(metaCols).map(([k, i]) => [k, r[i] || ""]));
        codeCols.forEach((cc, i) => { if (cc) entries.push({ name, ...cc, raw: r[i], col: i }); });
      });
    } else {
      const codeCol = lower.findIndex((h) => /cluster|standard|code|skill/.test(h));
      const scoreCol = lower.findIndex((h) => /score|percent|pct|%|mastery|result|points|grade/.test(h) && !/standard|cluster/.test(h));
      if (codeCol < 0 || scoreCol < 0) {
        throw new Error("Couldn't find cluster codes. Use cluster codes like 4.NF.B as column headers, or a long file with Student, Cluster and Score columns.");
      }
      const bad = new Set();
      body.forEach((r) => {
        const cc = matchCode(r[codeCol]);
        if (!cc) { if (r[codeCol]) bad.add(r[codeCol]); return; }
        if (r[nameCol]) entries.push({ name: r[nameCol], ...cc, raw: r[scoreCol], col: `${cc.standard || cc.cluster}` });
      });
      if (bad.size) notes.push({ type: "warn", text: `Skipped rows with unrecognized codes: ${[...bad].slice(0, 8).map(esc).join(", ")}${bad.size > 8 ? "…" : ""}.` });
    }
    if (!entries.length) throw new Error("No scores were found for recognized Common Core math K–8 clusters.");

    // Decide scale per source column: if every value is 0–1, treat as proportions.
    const byCol = {};
    entries.forEach((e) => { e.v = parseScore(e.raw); (byCol[e.col] ||= []).push(e); });
    Object.values(byCol).forEach((list) => {
      const vals = list.map((e) => e.v).filter(Number.isFinite);
      const rawIsFrac = list.some((e) => /\/|out of/i.test(String(e.raw)));
      if (!rawIsFrac && vals.length && vals.every((v) => v >= 0 && v <= 1) && vals.some((v) => v > 0 && v < 1)) {
        list.forEach((e) => { if (Number.isFinite(e.v)) e.v *= 100; });
      }
    });
    const over = entries.filter((e) => e.v > 100).length;
    if (over) notes.push({ type: "warn", text: `${over} score(s) were above 100 and were capped at 100. Scores should be percents.` });
    entries.forEach((e) => { if (Number.isFinite(e.v)) e.v = Math.max(0, Math.min(100, e.v)); });

    // Aggregate to student x cluster (averaging standard-level columns).
    const students = new Map();
    const clusterStandards = {};
    entries.forEach((e) => {
      if (!students.has(e.name)) students.set(e.name, {});
      const s = students.get(e.name);
      (s[e.cluster] ||= []);
      if (Number.isFinite(e.v)) s[e.cluster].push(e.v);
      if (e.standard) (clusterStandards[e.cluster] ||= new Set()).add(e.standard);
    });
    const clusters = [...new Set(entries.map((e) => e.cluster))]; // keep the file's column order
    const list = [...students.entries()].map(([name, sc]) => {
      const scores = {};
      clusters.forEach((c) => { scores[c] = sc[c] && sc[c].length ? mean(sc[c]) : NaN; });
      return { name, scores, meta: meta[name] || {} };
    });
    const empty = list.filter((s) => clusters.every((c) => !Number.isFinite(s.scores[c])));
    if (empty.length) notes.push({ type: "warn", text: `Left out ${empty.length} student(s) with no scores: ${empty.map((s) => esc(s.name)).join(", ")}.` });
    const withScores = list.filter((s) => !empty.includes(s));
    // Students with 0% on every cluster almost always didn't take or submit the test.
    const allZero = withScores.filter((s) => clusters.every((c) => !Number.isFinite(s.scores[c]) || s.scores[c] === 0));
    const setAside = $("#zero-aside") ? $("#zero-aside").checked : true;
    const notTested = setAside && allZero.length < withScores.length ? allZero : [];
    if (allZero.length) {
      notes.push({
        type: "warn",
        text: setAside && notTested.length
          ? `${allZero.length} student(s) scored 0% on every cluster. That usually means the test wasn't taken or submitted, so they're listed separately under "Check these students" and not grouped.`
          : `${allZero.length} student(s) scored 0% on every cluster and are included in the groups.`,
      });
    }
    const kept = withScores.filter((s) => !notTested.includes(s));
    if (kept.length < 2) throw new Error("At least two students with scores are needed to form groups.");

    const metaFound = Object.keys(metaCols).filter((k) => k !== "id").map((k) => header[metaCols[k]]);
    if (metaFound.length) notes.push({ type: "ok", text: `Also read ${metaFound.map(esc).join(" and ")}; they're shown next to each student.` });
    const missing = kept.reduce((n, s) => n + clusters.filter((c) => !Number.isFinite(s.scores[c])).length, 0);
    if (missing) notes.push({ type: "warn", text: `${missing} blank score(s). Blanks are filled with the class average for grouping only and shown as "—".` });
    const rolled = Object.keys(clusterStandards);
    if (rolled.length) notes.push({ type: "ok", text: `Standard-level columns were averaged into their clusters (${rolled.join(", ")}).` });
    return { students: kept, notTested, clusters, hasMeta: { level: "level" in metaCols, scale: "scale" in metaCols }, notes };
  }

  // ---------- grouping (k-means on cluster scores) ----------
  function prepareMatrix(data) {
    const colMean = {};
    data.clusters.forEach((c) => { colMean[c] = mean(data.students.map((s) => s.scores[c]).filter(Number.isFinite)); });
    return data.students.map((s) => data.clusters.map((c) => (Number.isFinite(s.scores[c]) ? s.scores[c] : colMean[c])));
  }
  const dist2 = (a, b) => a.reduce((sum, x, i) => sum + (x - b[i]) ** 2, 0);

  function kmeans(X, k, seed) {
    const rand = rng(seed);
    const n = X.length;
    const centers = [X[Math.floor(rand() * n)].slice()];
    while (centers.length < k) { // k-means++
      const d = X.map((x) => Math.min(...centers.map((c) => dist2(x, c))));
      const total = d.reduce((a, b) => a + b, 0);
      if (!total) break;
      let r = rand() * total, i = 0;
      while (r > d[i] && i < n - 1) { r -= d[i]; i++; }
      centers.push(X[i].slice());
    }
    let assign = new Array(n).fill(0);
    for (let iter = 0; iter < 100; iter++) {
      let changed = false;
      for (let i = 0; i < n; i++) {
        let best = 0, bd = Infinity;
        centers.forEach((c, j) => { const d = dist2(X[i], c); if (d < bd) { bd = d; best = j; } });
        if (assign[i] !== best) { assign[i] = best; changed = true; }
      }
      centers.forEach((c, j) => {
        const members = X.filter((_, i) => assign[i] === j);
        if (members.length) for (let d = 0; d < c.length; d++) c[d] = mean(members.map((m) => m[d]));
      });
      if (!changed && iter > 0) break;
    }
    const inertia = X.reduce((s, x, i) => s + dist2(x, centers[assign[i]]), 0);
    return { assign, centers, inertia };
  }

  function bestKmeans(X, k) {
    let best = null;
    for (let s = 1; s <= 25; s++) {
      const r = kmeans(X, k, s * 7919);
      const sizes = new Array(k).fill(0); r.assign.forEach((a) => sizes[a]++);
      if (sizes.some((z) => z === 0)) continue;
      if (!best || r.inertia < best.inertia - 1e-9) best = r;
    }
    return best;
  }

  function silhouette(X, assign, k) {
    const n = X.length;
    let total = 0;
    for (let i = 0; i < n; i++) {
      const sums = new Array(k).fill(0), counts = new Array(k).fill(0);
      for (let j = 0; j < n; j++) if (i !== j) { const d = Math.sqrt(dist2(X[i], X[j])); sums[assign[j]] += d; counts[assign[j]]++; }
      const own = assign[i];
      if (!counts[own]) continue;
      const a = sums[own] / counts[own];
      let b = Infinity;
      for (let c = 0; c < k; c++) if (c !== own && counts[c]) b = Math.min(b, sums[c] / counts[c]);
      total += (b - a) / Math.max(a, b);
    }
    return total / n;
  }

  function group(data, kChoice) {
    const X = prepareMatrix(data);
    const n = X.length;
    let k, res;
    if (kChoice === "auto") {
      let bestScore = -Infinity;
      // Classroom-sized classes: 3–5 small groups. On noisy interim scores, letting the fit pick 2
      // usually just splits "higher" from "lower" and hides the skill patterns.
      const lo = n >= 12 ? 3 : 2;
      const hi = n >= 12 ? Math.min(5, Math.floor(n / 3)) : Math.min(4, n - 1);
      for (let kk = lo; kk <= hi; kk++) {
        const r = bestKmeans(X, kk);
        if (!r) continue;
        const sizes = new Array(kk).fill(0); r.assign.forEach((a) => sizes[a]++);
        // Prefer groups a teacher can work with: penalize groups of one.
        const score = silhouette(X, r.assign, kk) - 0.05 * sizes.filter((z) => z < 2).length;
        if (score > bestScore) { bestScore = score; k = kk; res = r; }
      }
      if (!res) { k = Math.min(2, n); res = bestKmeans(X, k); }
    } else {
      k = Math.min(Number(kChoice), n);
      res = bestKmeans(X, k) || kmeans(X, k, 1);
    }
    let assign = res.assign.slice();
    // Teacher moves override the algorithm.
    data.students.forEach((s, i) => { if (state.overrides[s.name] != null && state.overrides[s.name] < k) assign[i] = state.overrides[s.name]; });
    return { k, assign };
  }

  // ---------- Knowledge Graph lookups ----------
  const clusterInfo = (c) => KG.clusters[c];
  const stdInfo = (s) => KG.standards[s];
  const domainName = (c) => KG.domains[clusterInfo(c)?.dom] || "";

  // Standards (outside this cluster) that the Coherence Map says build toward this cluster.
  function prerequisites(cluster) {
    const own = new Set(clusterInfo(cluster).s);
    const out = new Set();
    own.forEach((s) => stdInfo(s).pre.forEach((p) => { if (!own.has(p)) out.add(p); }));
    return [...out].sort(codeSort);
  }
  function buildsToward(cluster) {
    const own = new Set(clusterInfo(cluster).s);
    const out = new Set();
    own.forEach((s) => stdInfo(s).next.forEach((p) => { if (!own.has(p)) out.add(p); }));
    return [...out].sort(codeSort);
  }
  function lessonsFor(standards, max) {
    const seen = new Set(), out = [];
    standards.forEach((s) => (stdInfo(s)?.les || []).forEach((l) => {
      const key = `${l.g}|${l.u}|${l.o}|${l.n}`;
      if (!seen.has(key)) { seen.add(key); out.push({ ...l, std: s }); }
    }));
    return out.slice(0, max);
  }
  // Pick learning components spread across a cluster's standards.
  function focusComponents(cluster, max) {
    const lists = clusterInfo(cluster).s.map((s) => stdInfo(s).lc.map((d) => ({ d, s })));
    const out = [];
    for (let i = 0; out.length < max && lists.some((l) => l[i]); i++) lists.forEach((l) => { if (l[i] && out.length < max) out.push(l[i]); });
    return out;
  }
  const lessonText = (l) => `IM 360 ${gradeName(l.g)}${l.u ? `, ${l.u}` : ""}: ${l.o ? `${l.o} – ` : ""}${l.n}`;

  // ---------- analysis ----------
  function analyze() {
    const data = state.data;
    const t = thresholds();
    const { k, assign } = group(data, $("#k").value);
    const classMean = {};
    data.clusters.forEach((c) => { classMean[c] = mean(data.students.map((s) => s.scores[c]).filter(Number.isFinite)); });

    let groups = Array.from({ length: k }, (_, j) => {
      const members = data.students.filter((_, i) => assign[i] === j);
      const means = {};
      data.clusters.forEach((c) => { means[c] = mean(members.map((m) => m.scores[c]).filter(Number.isFinite)); });
      const overall = mean(data.clusters.map((c) => means[c]).filter(Number.isFinite));
      return { id: j, members, means, overall };
    }).filter((g) => g.members.length);

    groups.sort((a, b) => a.overall - b.overall); // most support first
    groups.forEach((g, i) => {
      g.num = i + 1;
      g.needs = data.clusters.filter((c) => band(g.means[c], t) === "need").sort((a, b) => g.means[a] - g.means[b]);
      g.approaching = data.clusters.filter((c) => band(g.means[c], t) === "app").sort((a, b) => g.means[a] - g.means[b]);
      g.strengths = data.clusters.filter((c) => band(g.means[c], t) === "prof").sort((a, b) => g.means[b] - g.means[a]);
      g.distinct = data.clusters
        .map((c) => ({ c, d: g.means[c] - classMean[c] }))
        .filter((x) => Number.isFinite(x.d))
        .sort((a, b) => Math.abs(b.d) - Math.abs(a.d))
        .slice(0, 3);
      g.label = groupLabel(g, data.clusters);
      g.priorities = orderPriorities(g.needs.concat(g.approaching), g);
      g.steps = nextSteps(g, t);
    });
    state.result = { groups, classMean, t };
  }

  function groupLabel(g, clusters) {
    if (!g.needs.length && !g.approaching.length) return "Ready to extend";
    // "Broad" only when needs span nearly every domain tested; otherwise name the weak domains.
    const allDoms = new Set(clusters.map((c) => clusterInfo(c).dom));
    const needDoms = new Set(g.needs.map((c) => clusterInfo(c).dom));
    if (g.overall < thresholds().app && needDoms.size >= Math.max(2, Math.ceil(allDoms.size * 0.75))) return "Broad foundational support";
    const focus = (g.needs.length ? g.needs : g.approaching).slice(0, 2);
    const doms = [...new Set(focus.map((c) => domainName(c)).filter(Boolean))];
    return `Focus: ${doms.length ? doms.join(" & ") : focus.join(", ")}`;
  }

  // If one weak cluster builds toward another weak cluster, teach it first.
  function orderPriorities(weak, g) {
    const set = new Set(weak);
    const feeds = {};
    weak.forEach((c) => {
      const pre = new Set(prerequisites(c).map((s) => stdInfo(s).cl));
      feeds[c] = weak.filter((o) => o !== c && pre.has(o));
    });
    const out = [], done = new Set();
    const visit = (c, stack = new Set()) => {
      if (done.has(c) || stack.has(c)) return;
      stack.add(c);
      feeds[c].slice().sort((a, b) => g.means[a] - g.means[b]).forEach((p) => visit(p, stack));
      done.add(c); out.push(c);
    };
    weak.slice().sort((a, b) => g.means[a] - g.means[b]).forEach((c) => visit(c));
    return out.filter((c) => set.has(c)).map((c) => ({ c, feeds: weak.filter((o) => feeds[o].includes(c)) }));
  }

  function nextSteps(g, t) {
    const steps = [];
    const data = state.data;
    const scoredClusters = new Set(data.clusters);

    g.priorities.slice(0, 3).forEach(({ c, feeds }) => {
      const info = clusterInfo(c);
      const isNeed = band(g.means[c], t) === "need";
      const lcs = focusComponents(c, isNeed ? 5 : 4);
      const pre = prerequisites(c).filter((s) => gradeIdx(stdInfo(s).g) < gradeIdx(info.g));
      const weakPre = pre.filter((s) => scoredClusters.has(stdInfo(s).cl) && band(g.means[stdInfo(s).cl], t) === "need");
      const lessons = lessonsFor(info.s, 3);
      steps.push({
        kind: isNeed ? "reteach" : "practice",
        cluster: c,
        title: isNeed
          ? `Reteach ${c} (group average ${round(g.means[c])}%)`
          : `Targeted practice on ${c} (group average ${round(g.means[c])}%)`,
        why: [
          info.d,
          feeds.length ? `Start here: ${c} builds toward ${feeds.join(", ")}, which this group also finds hard.` : "",
        ].filter(Boolean),
        lcs,
        pre: pre.slice(0, 4),
        weakPre,
        lessons,
        cadence: isNeed ? "Small group, 3× a week for about 20 minutes, using concrete models and visuals first." : "Small group or stations, 2× a week, with short mixed practice and feedback.",
      });
    });

    if (!g.priorities.length || g.strengths.length >= Math.ceil(data.clusters.length / 2)) {
      const top = g.strengths.slice(0, 2);
      top.forEach((c) => {
        const nxt = buildsToward(c).filter((s) => !scoredClusters.has(stdInfo(s).cl)).slice(0, 4);
        steps.push({
          kind: "extend",
          cluster: c,
          title: `Extend ${c} (group average ${round(g.means[c])}%)`,
          why: [`Strong in ${c}. The Coherence Map shows where this understanding goes next.`],
          next: nxt,
          lessons: lessonsFor(nxt, 2),
          cadence: "Independent or partner challenge tasks; invite these students to explain strategies to peers.",
        });
      });
    }
    return steps;
  }

  // ---------- rendering ----------
  function renderMessages(notes) {
    $("#messages").innerHTML = notes.map((n) => `<div class="msg ${n.type}">${n.text}</div>`).join("");
  }

  function stdLine(s) {
    const st = stdInfo(s);
    return `<strong>${esc(s)}</strong> — ${esc(st.d)}`;
  }

  function clusterDetails(c, opts = {}) {
    const info = clusterInfo(c);
    const pre = prerequisites(c);
    const nxt = buildsToward(c);
    const stds = info.s.map((s) => {
      const st = stdInfo(s);
      return `<div class="std"><div><span class="std-code">${esc(s)}</span> ${esc(st.d)}</div>
        ${st.lc.length ? `<ul class="lc-list">${st.lc.map((d) => `<li>${esc(d)}</li>`).join("")}</ul>` : ""}</div>`;
    }).join("");
    return `<details class="cluster"${opts.open ? " open" : ""}>
      <summary>${esc(c)} · ${esc(info.d)}</summary>
      <p class="small muted">${esc(gradeName(info.g))} · ${esc(domainName(c))} · ${info.s.length} standard(s), ${info.s.reduce((n, s) => n + stdInfo(s).lc.length, 0)} learning components</p>
      ${stds}
      ${pre.length ? `<p class="links"><strong>Builds on:</strong> ${pre.map(esc).join(", ")}</p>` : ""}
      ${nxt.length ? `<p class="links"><strong>Leads to:</strong> ${nxt.map(esc).join(", ")}</p>` : ""}
    </details>`;
  }

  function renderSummary() {
    const { groups } = state.result;
    const d = state.data;
    const grades = [...new Set(d.clusters.map((c) => clusterInfo(c).g))].sort((a, b) => gradeIdx(a) - gradeIdx(b));
    const classAvg = mean(d.clusters.map((c) => state.result.classMean[c]));
    $("#summary").innerHTML = [
      [d.students.length, "students grouped"],
      ...(d.notTested.length ? [[d.notTested.length, "set aside (all 0%)"]] : []),
      [d.clusters.length, `clusters (${grades.map(gradeName).join(", ")})`],
      [groups.length, "groups"],
      [`${round(classAvg)}%`, "average of grouped students"],
    ].map(([v, l]) => `<div class="stat"><div class="v">${esc(v)}</div><div class="l">${esc(l)}</div></div>`).join("");
  }

  function renderGroups() {
    const { groups, classMean, t } = state.result;
    const opts = (cur) => groups.map((g) => `<option value="${g.id}"${g.id === cur ? " selected" : ""}>Group ${g.num}</option>`).join("");
    $("#tab-groups").innerHTML = groups.map((g) => {
      const profile = state.data.clusters.map((c) => {
        const b = band(g.means[c], t);
        const delta = g.means[c] - classMean[c];
        return `<div class="pcell ${b}" title="${esc(clusterInfo(c).d)}"><span>${esc(c)}</span><span>${round(g.means[c])}% <span class="delta">(${delta >= 0 ? "+" : ""}${round(delta)})</span></span></div>`;
      }).join("");
      const distinct = g.distinct.map((x) => `${esc(x.c)} ${x.d >= 0 ? "above" : "below"} class average by ${Math.abs(round(x.d))} pts`).join("; ");
      const insightClusters = [...new Set(g.priorities.map((p) => p.c).concat(g.priorities.length ? [] : g.strengths.slice(0, 2)))].slice(0, 4);
      return `<article class="group">
        <div class="group-head">
          <h3>Group ${g.num}: ${esc(g.label)}</h3>
          <span class="muted small">${g.members.length} student${g.members.length === 1 ? "" : "s"} · average ${round(g.overall)}%</span>
        </div>
        <div class="members">${g.members.map((m) => `<span class="chip"${metaTitle(m)}>${esc(m.name)}
          <select aria-label="Move ${esc(m.name)} to another group" data-student="${esc(m.name)}">${opts(g.id)}</select></span>`).join("")}</div>
        <div class="profile">${profile}</div>
        <p class="small"><strong>What sets this group apart:</strong> ${distinct || "—"}.</p>
        <div class="cols">
          <div>
            <p class="kicker">Recommended next steps</p>
            <ol class="steps">${g.steps.map(renderStep).join("")}</ol>
          </div>
          <div>
            <p class="kicker">Inside the clusters behind this group</p>
            <p class="small muted">The standards and learning components (smaller teachable skills) that make up each cluster this group was grouped on.</p>
            ${insightClusters.map((c) => clusterDetails(c)).join("")}
          </div>
        </div>
      </article>`;
    }).join("") + (state.data.notTested.length ? `<article class="group aside">
        <div class="group-head"><h3>Check these students</h3><span class="muted small">${state.data.notTested.length} student(s) · not grouped</span></div>
        <p class="small">These students scored 0% on every cluster. Check whether they took and submitted the test before planning for them. If they did, untick "Set aside students who scored 0%" above to include them.</p>
        <div class="members">${state.data.notTested.map((m) => `<span class="chip"${metaTitle(m)}>${esc(m.name)}</span>`).join("")}</div>
      </article>` : "");
    $("#tab-groups").querySelectorAll("select[data-student]").forEach((sel) => sel.addEventListener("change", () => {
      state.overrides[sel.dataset.student] = Number(sel.value);
      run(false);
    }));
  }

  function metaTitle(m) {
    const bits = [m.meta?.level, m.meta?.scale ? `Scale score ${m.meta.scale}` : "", m.meta?.id ? `ID ${m.meta.id}` : ""].filter(Boolean);
    return bits.length ? ` title="${esc(bits.join(" · "))}"` : "";
  }

  function renderStep(s) {
    const parts = [`<strong>${esc(s.title)}</strong>`];
    s.why.forEach((w) => parts.push(`<div class="small muted">${esc(w)}</div>`));
    if (s.lcs?.length) parts.push(`<div class="small">Focus on these learning components:</div><ul>${s.lcs.map((l) => `<li>${esc(l.d)} <span class="muted">(${esc(l.s)})</span></li>`).join("")}</ul>`);
    if (s.weakPre?.length) parts.push(`<div class="small"><strong>Foundational gap:</strong> this group is also low on ${[...new Set(s.weakPre.map((p) => stdInfo(p).cl))].map(esc).join(", ")}, a prerequisite. Address it first.</div>`);
    if (s.pre?.length) parts.push(`<div class="small">Quick-check prerequisites from earlier grades:</div><ul>${s.pre.map((p) => `<li>${stdLine(p)}</li>`).join("")}</ul>`);
    if (s.next?.length) parts.push(`<div class="small">Stretch toward:</div><ul>${s.next.map((p) => `<li>${stdLine(p)}</li>`).join("")}</ul>`);
    if (s.lessons?.length) parts.push(`<div class="small">Aligned lessons:</div><ul>${s.lessons.map((l) => `<li>${esc(lessonText(l))}</li>`).join("")}</ul>`);
    parts.push(`<div class="small"><em>${esc(s.cadence)}</em></div>`);
    return `<li>${parts.join("")}</li>`;
  }

  function renderHeatmap() {
    const { groups, t, classMean } = state.result;
    const d = state.data;
    const cl = d.clusters;
    const extra = [d.hasMeta.level && ["level", "Level"], d.hasMeta.scale && ["scale", "Scale score"]].filter(Boolean);
    const ncol = cl.length + 1 + extra.length;
    const head = `<tr><th scope="col">Student</th>${extra.map(([, l]) => `<th scope="col">${l}</th>`).join("")}${cl.map((c) => `<th scope="col" title="${esc(clusterInfo(c).d)}">${esc(c)}</th>`).join("")}</tr>`;
    const row = (m) => `<tr><td>${esc(m.name)}</td>${extra.map(([k]) => `<td>${esc(m.meta?.[k] || "")}</td>`).join("")}${cl.map((c) => {
      const v = m.scores[c];
      return `<td class="${band(v, t)}">${Number.isFinite(v) ? round(v) : "—"}</td>`;
    }).join("")}</tr>`;
    const body = groups.map((g) => `<tr class="grp"><td colspan="${ncol}">Group ${g.num}: ${esc(g.label)}</td></tr>` + g.members.map(row).join("")).join("") +
      (d.notTested.length ? `<tr class="grp"><td colspan="${ncol}">Set aside: 0% on every cluster</td></tr>` + d.notTested.map(row).join("") : "");
    const avg = `<tr class="grp"><td>Average (grouped)</td>${extra.map(() => "<td></td>").join("")}${cl.map((c) => `<td class="${band(classMean[c], t)}">${round(classMean[c])}</td>`).join("")}</tr>`;
    $("#tab-heatmap").innerHTML = `<div class="legend">${["prof", "app", "need"].map((b) => `<span class="band ${b}">${BAND_LABEL[b]}</span>`).join("")}<span class="muted">Cells show percent scores. "—" means no score.</span></div>
      <div class="table-wrap"><table class="heat"><thead>${head}</thead><tbody>${body}${avg}</tbody></table></div>`;
  }

  function renderClusters() {
    const { t, classMean, groups } = state.result;
    const groupOf = {};
    groups.forEach((g) => g.members.forEach((m) => { groupOf[m.name] = g.num; }));
    $("#tab-clusters").innerHTML = `<p class="small muted">Use this view for quick skill-based pull-outs on a single cluster, regardless of overall group.</p>` +
      state.data.clusters.slice().sort((a, b) => classMean[a] - classMean[b]).map((c) => {
        const bands = { prof: [], app: [], need: [], none: [] };
        state.data.students.forEach((s) => bands[band(s.scores[c], t)].push(s));
        const n = state.data.students.length;
        const pct = (b) => (bands[b].length / n) * 100;
        const list = (b) => bands[b].sort((x, y) => x.scores[c] - y.scores[c]).map((s) => `${esc(s.name)} <span class="muted">${round(s.scores[c])} · G${groupOf[s.name]}</span>`).join("<br>") || "<span class=\"muted\">None</span>";
        return `<div class="cl-card">
          <div class="group-head"><h3>${esc(c)}</h3><span class="band ${band(classMean[c], t)}">Class average ${round(classMean[c])}%</span></div>
          <p class="small">${esc(clusterInfo(c).d)}</p>
          <div class="bar" aria-hidden="true"><span class="need" style="width:${pct("need")}%"></span><span class="app" style="width:${pct("app")}%"></span><span class="prof" style="width:${pct("prof")}%"></span></div>
          <div class="bands">
            <div class="need"><strong>Needs support (${bands.need.length})</strong><br>${list("need")}</div>
            <div class="app"><strong>Approaching (${bands.app.length})</strong><br>${list("app")}</div>
            <div class="prof"><strong>Proficient (${bands.prof.length})</strong><br>${list("prof")}</div>
          </div>
          ${clusterDetails(c)}
        </div>`;
      }).join("");
  }

  function run(resetOverrides) {
    if (!state.data) return;
    if (resetOverrides) state.overrides = {};
    analyze();
    renderSummary();
    renderGroups();
    renderHeatmap();
    renderClusters();
    $("#settings").hidden = false;
    $("#results").hidden = false;
  }

  function load(text, label, scroll = true) {
    state.raw = { text, label };
    try {
      const data = interpret(parseCSV(text));
      state.data = data;
      const total = data.students.length + data.notTested.length;
      renderMessages([{ type: "ok", text: `Loaded ${esc(label)}: ${total} students, ${data.clusters.length} clusters.` }, ...data.notes]);
      run(true);
      if (scroll) $("#results").scrollIntoView({ behavior: "smooth", block: "start" });
    } catch (e) {
      state.data = null;
      $("#settings").hidden = true;
      $("#results").hidden = true;
      renderMessages([{ type: "error", text: esc(e.message) }]);
    }
  }

  function exportCSV() {
    const { groups } = state.result;
    const cl = state.data.clusters;
    const q = (s) => (/[",\n]/.test(s) ? `"${String(s).replace(/"/g, '""')}"` : s);
    const lines = [["Student", "Group", "Group focus", ...cl].map(q).join(",")];
    const line = (m, grp, label) => lines.push([m.name, grp, label, ...cl.map((c) => (Number.isFinite(m.scores[c]) ? Math.round(m.scores[c]) : ""))].map(q).join(","));
    groups.forEach((g) => g.members.forEach((m) => line(m, `Group ${g.num}`, g.label)));
    state.data.notTested.forEach((m) => line(m, "Not grouped", "0% on every cluster - check test status"));
    const blob = new Blob([lines.join("\n") + "\n"], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "student-groups.csv";
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  // ---------- wiring ----------
  function init() {
    if (!KG) { renderMessages([{ type: "error", text: "Knowledge Graph data (data/kg-math-k8.js) didn't load." }]); return; }
    $("#kg-version").textContent = `(${KG.meta.version})`;
    $("#attribution").innerHTML = KG.meta.attribution.map((a) => `<li>${esc(a)}</li>`).join("");

    const file = $("#file"), dz = $("#dropzone");
    const readFile = (f) => { if (!f) return; const r = new FileReader(); r.onload = () => load(String(r.result), f.name); r.readAsText(f); };
    dz.addEventListener("click", () => file.click());
    dz.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); file.click(); } });
    file.addEventListener("change", () => { readFile(file.files[0]); file.value = ""; });
    ["dragenter", "dragover"].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add("drag"); }));
    ["dragleave", "drop"].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove("drag"); }));
    dz.addEventListener("drop", (e) => readFile(e.dataTransfer.files[0]));
    $("#sample").addEventListener("click", () => load(window.SAMPLE_CSV, "sample Grade 4 class"));
    $("#format-toggle").addEventListener("click", (e) => {
      const h = $("#format-help"); h.hidden = !h.hidden; e.currentTarget.setAttribute("aria-expanded", String(!h.hidden));
    });
    $("#k").addEventListener("change", () => run(true));
    $("#zero-aside").addEventListener("change", () => { if (state.raw) load(state.raw.text, state.raw.label, false); });
    ["#t-prof", "#t-app"].forEach((s) => $(s).addEventListener("change", () => run(false)));
    $("#export")?.addEventListener("click", exportCSV);
    $("#print")?.addEventListener("click", () => window.print());
    document.querySelectorAll(".tab").forEach((tab) => tab.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach((t) => t.setAttribute("aria-selected", String(t === tab)));
      document.querySelectorAll(".tabpanel").forEach((p) => { p.hidden = p.id !== `tab-${tab.dataset.tab}`; });
    }));
  }

  // Expose pure functions for tests.
  window.GroupingApp = { parseCSV, interpret, matchCode, kmeans, prerequisites, buildsToward };
  init();
})();
