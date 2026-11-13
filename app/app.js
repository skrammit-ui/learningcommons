/* Student Grouping Planner
 * Everything runs in the browser. Student data is never sent anywhere.
 * Knowledge Graph data: window.KG_DATA (data/kg-math-k8.js).
 */
(function () {
  "use strict";

  const KG = window.KG_DATA;
  const GRADE_ORDER = ["K", "1", "2", "3", "4", "5", "6", "7", "8"];
  const state = { data: null, result: null, overrides: {}, sources: {}, untaught: new Set() };

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

  // CSV rows -> { records:[{name, id, scores:{cluster: pct}, meta}], clusters, notes, hasMeta }
  function interpretCSV(rows) {
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
      ["norm", /^(national norm|national percentile|national norm percentile|math national norm percentile|norm percentile|percentile)$/i],
      ["id", /^(identifier|student id|id|sis id|state id)$/i],
    ];
    const metaCols = {};
    META.forEach(([key, re]) => { const i = header.findIndex((h, j) => j !== nameCol && re.test(h)); if (i >= 0) metaCols[key] = i; });
    const known = /^(quantile|lexile|rc\d+|reporting category.*|test|assessment|form|subject)$/i;

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
    const metaFound = Object.keys(metaCols).filter((k) => k !== "id").map((k) => header[metaCols[k]]);
    if (metaFound.length) notes.push({ type: "ok", text: `Also read ${metaFound.map(esc).join(", ").replace(/, ([^,]*)$/, " and $1")}; they're shown next to each student.` });
    const rolled = Object.keys(clusterStandards);
    if (rolled.length) notes.push({ type: "ok", text: `Standard-level columns were averaged into their clusters (${rolled.join(", ")}).` });
    return {
      records: list.map((s) => ({ ...s, id: s.meta.id || "" })),
      clusters,
      notes,
      hasMeta: { level: "level" in metaCols, scale: "scale" in metaCols, norm: "norm" in metaCols },
    };
  }

  // Shared last step for any source: drop empty rows, set aside all-zero students, add notes.
  function finalize({ records: list, clusters, notes, hasMeta, hasItems }) {
    const empty = list.filter((s) => clusters.every((c) => !Number.isFinite(s.scores[c])));
    if (empty.length) notes.push({ type: "warn", text: `Left out ${empty.length} student(s) with no math scores: ${empty.map((s) => esc(s.name)).join("; ")}.` });
    const withScores = list.filter((s) => !empty.includes(s));
    // Students with 0% on every cluster almost always didn't take or submit the test.
    const allZero = withScores.filter((s) => clusters.every((c) => !Number.isFinite(s.scores[c]) || s.scores[c] === 0));
    const setAside = $("#zero-aside") ? $("#zero-aside").checked : true;
    const notTested = setAside && allZero.length < withScores.length ? allZero : [];
    if (allZero.length) {
      // With ISR counts we know these students saw the questions, so don't assume they skipped the test.
      const sawQuestions = allZero.every((s) => clusters.some((c) => s.items?.[c] > 0));
      const why = sawQuestions
        ? "The reports show they saw the questions but got none right, which can mean the test wasn't completed as intended"
        : "That usually means the test wasn't taken or submitted";
      notes.push({
        type: "warn",
        text: setAside && notTested.length
          ? `${allZero.length} student(s) scored 0% on every cluster. ${why}, so they're listed separately under "Check these students" and not grouped. Untick the setting below to group them.`
          : `${allZero.length} student(s) scored 0% on every cluster and are included in the groups.`,
      });
    }
    // Fixed order (by ID, then name), so the same students always group the same way,
    // whatever order the files were uploaded in or the rows were exported in.
    const canon = (a, b) => String(a.id || "").localeCompare(String(b.id || ""), undefined, { numeric: true }) ||
      a.name.localeCompare(b.name, undefined, { numeric: true });
    const kept = withScores.filter((s) => !notTested.includes(s)).sort(canon);
    notTested.sort(canon);
    if (kept.length < 2) throw new Error("At least two students with scores are needed to form groups.");

    const missing = kept.reduce((n, s) => n + clusters.filter((c) => !Number.isFinite(s.scores[c])).length, 0);
    if (missing) {
      notes.push({ type: "warn", text: hasItems
        ? `${missing} cluster result(s) are blank or had no questions for that student. They're shown as "—" and filled with the class average for grouping only.`
        : `${missing} blank score(s). Blanks are filled with the class average for grouping only and shown as "—".` });
    }
    // allClusters: everything in the file. clusters: the ones the teacher marked as taught (set in analyze).
    return { students: kept, notTested, clusters, allClusters: clusters.slice(), hasMeta, hasItems: !!hasItems, notes };
  }

  // Kept for tests and simple callers: CSV text rows -> finished class data.
  function interpret(rows) { return finalize(interpretCSV(rows)); }

  // ---------- ISR PDF (PRoPL Individual Student Reports) ----------
  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = src;
      s.onload = resolve;
      s.onerror = () => reject(new Error("The PDF reader couldn't be loaded. Check your internet connection, or use the CSV export."));
      document.head.appendChild(s);
    });
  }
  async function pdfLib() {
    if (window.pdfjsLib) return window.pdfjsLib;
    const base = window.PDFJS_BASE || "vendor/pdfjs/";
    // Loading the worker as a plain script makes pdf.js run on the page itself, which also works from disk.
    if (!globalThis.pdfjsWorker) await loadScript(base + "pdf.worker.min.js");
    await loadScript(base + "pdf.min.js");
    if (!window.pdfjsLib) throw new Error("The PDF reader didn't start.");
    return window.pdfjsLib;
  }

  // Rebuild lines of text from positioned PDF text. Wide gaps become runs of spaces, like a table.
  async function pdfToText(buffer) {
    const lib = await pdfLib();
    const doc = await lib.getDocument({ data: buffer, isEvalSupported: false }).promise;
    const pages = [];
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const tc = await page.getTextContent();
      const items = tc.items.filter((it) => it.str && it.str.trim())
        .map((it) => ({ s: it.str, x: it.transform[4], y: it.transform[5], w: it.width, h: Math.abs(it.transform[3]) || 10 }));
      const lines = [];
      items.sort((a, b) => b.y - a.y || a.x - b.x).forEach((it) => {
        const line = lines.find((l) => Math.abs(l.y - it.y) <= Math.max(2, it.h * 0.35));
        if (line) line.items.push(it); else lines.push({ y: it.y, items: [it] });
      });
      pages.push(lines.sort((a, b) => b.y - a.y).map((l) => {
        let out = "", end = null;
        l.items.sort((a, b) => a.x - b.x).forEach((it) => {
          if (end != null) {
            const gap = it.x - end;
            out += gap > it.h * 1.2 ? "   " : gap > it.h * 0.15 && !/\s$/.test(out) ? " " : "";
          }
          out += it.s;
          end = it.x + it.w;
        });
        return out;
      }).join("\n"));
      page.cleanup();
    }
    await doc.destroy();
    return pages.join("\n");
  }

  const words = (s) => String(s).toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter(Boolean);
  // ISRs name clusters by description. Match against the cluster's own wording, or a standard's
  // (PRoPL sometimes uses a standard's text, e.g. 6.SP.B.4 for 6.SP.B), within the student's grade.
  function matchTopic(desc, grade) {
    const dw = words(desc);
    let best = null, score = 0;
    const consider = (cluster, text) => {
      const cw = words(text);
      let k = 0;
      while (k < dw.length && k < cw.length && dw[k] === cw[k]) k++;
      const prefix = k >= 3 ? k / Math.min(dw.length, cw.length) : 0;
      const set = new Set(cw);
      const overlap = (2 * dw.filter((w) => set.has(w)).length) / (dw.length + cw.length);
      const s = Math.max(prefix, overlap * 0.95);
      if (s > score) { score = s; best = cluster; }
    };
    Object.entries(KG.clusters).forEach(([code, c]) => { if (c.g === grade) consider(code, c.d); });
    Object.values(KG.standards).forEach((st) => { if (st.g === grade) consider(st.cl, st.d); });
    return score >= 0.6 ? best : null;
  }

  function parseISRText(text) {
    const notes = [], records = [], noMath = [], unmatched = new Set();
    const blocks = text.split(/(?=^\s*Student:)/m).filter((b) => /^\s*Student:/.test(b));
    if (!blocks.length) throw new Error("This PDF doesn't look like PRoPL Individual Student Reports: no \"Student:\" headers were found.");
    const clusters = [];
    let testName = "";
    blocks.forEach((b) => {
      const h = b.match(/Student:\s*(.+?)\s+ID:\s*(\S+)\s+Grade:\s*(\S+)/);
      if (!h) return;
      const name = h[1].trim(), id = h[2];
      let grade = h[3].replace(/^0+(?=\d)/, "").toUpperCase();
      if (grade === "0" || grade === "KG") grade = "K";
      const det = b.search(/Math Test Details/);
      if (det < 0) { noMath.push(name); return; }
      testName ||= (b.match(/Test:\s*(PRoPL[^\n]*?Math)\b/) || [])[1] || "";
      const tc = b.indexOf("Topics Covered", det);
      if (tc < 0) { noMath.push(name); return; }
      const after = b.slice(tc + 14);
      const stop = after.search(/Test Details/);
      const section = stop >= 0 ? after.slice(0, stop) : after;
      const topics = [];
      let buf = [];
      section.split("\n").forEach((line) => {
        if (/Topics Covered|Item\s+Percent|^\s*Count\s+Correct\s*$/i.test(line)) return;
        const r = line.match(/^(.*?)\s+(\d+)\s+(\d+(?:\.\d+)?)\s*%\s*$/);
        if (r) {
          buf.push(r[1].trim());
          topics.push({ desc: buf.join(" ").trim(), items: Number(r[2]), pct: Number(r[3]) });
          buf = [];
        } else if (line.trim()) {
          if (topics.length && !buf.length) topics[topics.length - 1].desc += " " + line.trim();
          else buf.push(line.trim());
        }
      });
      if (!topics.length) { noMath.push(name); return; }
      const scores = {}, items = {}, correct = {};
      topics.forEach((t) => {
        const c = matchTopic(t.desc, grade);
        if (!c) { unmatched.add(t.desc.slice(0, 80)); return; }
        if (!clusters.includes(c)) clusters.push(c);
        items[c] = (items[c] || 0) + t.items;
        correct[c] = (correct[c] || 0) + Math.round((t.pct * t.items) / 100);
      });
      Object.keys(items).forEach((c) => { scores[c] = items[c] > 0 ? (100 * correct[c]) / items[c] : NaN; });
      const tail = b.slice(det);
      const sc = tail.match(/(\d{3,4})\s*±\s*[\d.]+\s+Level\s*(\d)/) || b.match(/SCALE SCORE\s+(\d{3,4})\s+\d?\s*Level\s*(\d)/);
      const norm = b.match(/Math National Norm Percentile\*?\s+(\d{1,2})\b/);
      records.push({ name, id, scores, items, meta: { id, level: sc ? `Level ${sc[2]}` : "", scale: sc ? sc[1] : "", norm: norm ? norm[1] : "" } });
    });
    if (!records.length) throw new Error("No math results were found in this PDF. It may only contain Reading reports.");
    notes.push({ type: "ok", text: `Read ${records.length} math report(s)${testName ? ` from ${esc(testName)}` : ""}, including how many questions each student saw per cluster.` });
    if (noMath.length) notes.push({ type: "warn", text: `${noMath.length} report(s) had no math results (for example, Reading only) and were skipped: ${noMath.map(esc).join("; ")}.` });
    if (unmatched.size) notes.push({ type: "warn", text: `Couldn't match these report topics to a Common Core cluster, so they were skipped: ${[...unmatched].map(esc).join("; ")}.` });
    const hasLevel = records.some((r) => r.meta.level);
    return { records, clusters, notes, hasMeta: { level: hasLevel, scale: records.some((r) => r.meta.scale), norm: records.some((r) => r.meta.norm) }, hasItems: true };
  }

  // Join CSV and ISR records by student ID (or name), so the CSV roster gains question counts.
  function combineSources() {
    const { csv, isr } = state.sources;
    if (!csv && !isr) return null;
    if (!csv || !isr) {
      const one = csv || isr;
      return finalize({ ...one, notes: [...one.notes] });
    }
    const notes = [...csv.notes, ...isr.notes];
    const key = (r) => (r.id ? `id:${r.id}` : `name:${r.name.toLowerCase().replace(/\s+/g, " ").trim()}`);
    const merged = new Map();
    csv.records.forEach((r) => merged.set(key(r), { name: r.name, id: r.id, scores: { ...r.scores }, items: {}, meta: { ...r.meta }, src: "csv" }));
    const conflicts = [];
    let unassessed = 0;
    isr.records.forEach((r) => {
      const m = merged.get(key(r));
      if (!m) { merged.set(key(r), { ...r, scores: { ...r.scores }, items: { ...r.items }, meta: { ...r.meta }, src: "isr" }); return; }
      m.src = "both";
      m.items = { ...r.items };
      Object.entries(r.items).forEach(([c, n]) => {
        const cv = m.scores[c], iv = r.scores[c];
        if (n === 0) { if (Number.isFinite(cv)) unassessed++; m.scores[c] = NaN; return; }
        if (Number.isFinite(cv) && Number.isFinite(iv) && Math.abs(cv - iv) > 1) conflicts.push(`${esc(m.name)} ${c} (CSV ${round(cv)}%, ISR ${round(iv)}%)`);
        m.scores[c] = iv; // the ISR's percent goes with its question count
      });
      ["level", "scale", "norm"].forEach((f) => { if (!m.meta[f] && r.meta[f]) m.meta[f] = r.meta[f]; });
    });
    const records = [...merged.values()];
    const both = records.filter((r) => r.src === "both").length;
    const onlyCsv = records.filter((r) => r.src === "csv");
    const onlyIsr = records.filter((r) => r.src === "isr");
    notes.unshift({ type: "ok", text: `Matched ${both} student(s) across the CSV and ISR by ID.` });
    if (onlyCsv.length) notes.push({ type: "warn", text: `${onlyCsv.length} student(s) are in the CSV but have no ISR math report, so question counts aren't shown for them: ${onlyCsv.map((r) => esc(r.name)).join("; ")}.` });
    if (onlyIsr.length) notes.push({ type: "warn", text: `${onlyIsr.length} student(s) have an ISR math report but aren't in the CSV. They were added from the ISR: ${onlyIsr.map((r) => esc(r.name)).join("; ")}.` });
    if (conflicts.length) notes.push({ type: "warn", text: `The CSV and ISR disagree on ${conflicts.length} score(s); the ISR values were used: ${conflicts.slice(0, 6).join("; ")}${conflicts.length > 6 ? "…" : ""}.` });
    if (unassessed) notes.push({ type: "ok", text: `${unassessed} CSV score(s) were for clusters where the ISR shows the student saw no questions. They're treated as not assessed instead of 0%.` });
    const clusters = [...csv.clusters, ...isr.clusters.filter((c) => !csv.clusters.includes(c))];
    return finalize({
      records, clusters, notes, hasItems: true,
      hasMeta: { level: csv.hasMeta.level || isr.hasMeta.level, scale: csv.hasMeta.scale || isr.hasMeta.scale, norm: csv.hasMeta.norm || isr.hasMeta.norm },
    });
  }

  // ---------- grouping (k-means on cluster scores) ----------
  function prepareMatrix(data) {
    const colMean = {}, weight = {};
    data.clusters.forEach((c) => {
      colMean[c] = mean(data.students.map((s) => s.scores[c]).filter(Number.isFinite));
      weight[c] = 1;
    });
    // With question counts (ISR), clusters measured by more questions count for more,
    // since a score from 4 questions is steadier than one from 1.
    if (data.hasItems) {
      const avgItems = {};
      data.clusters.forEach((c) => { avgItems[c] = mean(data.students.map((s) => s.items?.[c]).filter((n) => n > 0)); });
      const overall = mean(Object.values(avgItems).filter(Number.isFinite));
      data.clusters.forEach((c) => { if (Number.isFinite(avgItems[c]) && overall) weight[c] = Math.sqrt(avgItems[c] / overall); });
    }
    return data.students.map((s) => data.clusters.map((c) => (Number.isFinite(s.scores[c]) ? s.scores[c] : colMean[c]) * weight[c]));
  }

  // "9 of 16 correct, 56%" when question counts are known, otherwise "group average 56%".
  function groupScore(g, c) {
    const t = g.tally?.[c];
    return t ? `${t.k} of ${t.n} questions correct, ${round(g.means[c])}%` : `group average ${round(g.means[c])}%`;
  }

  // Number correct and number of questions for a student on a cluster, when the ISR gave counts.
  function counts(s, c) {
    const n = s.items?.[c];
    if (!(n > 0) || !Number.isFinite(s.scores[c])) return null;
    return { k: Math.round((s.scores[c] * n) / 100), n };
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
    // Many fixed starting points: finds the best grouping reliably, and the same one every time.
    for (let s = 1; s <= 100; s++) {
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
  // ---------- looking ahead (Coherence Map "builds towards" between clusters) ----------
  // target cluster -> { feeder cluster -> [[fromStandard, toStandard], ...] }
  let FEEDS = null;
  function feeds() {
    if (FEEDS) return FEEDS;
    FEEDS = {};
    Object.entries(KG.standards).forEach(([s, st]) => st.next.forEach((n) => {
      const a = st.cl, b = stdInfo(n).cl;
      if (a !== b) ((FEEDS[b] ||= {})[a] ||= []).push([s, n]);
    }));
    return FEEDS;
  }

  // Upcoming clusters fed by the taught, assessed clusters: not yet taught this year, or next grade.
  function upcomingTargets(data) {
    const taught = new Set(data.clusters);
    const inFile = new Set(data.allClusters);
    const maxGrade = Math.max(...data.allClusters.map((c) => gradeIdx(clusterInfo(c).g)));
    const out = [];
    Object.entries(feeds()).forEach(([target, from]) => {
      const feeders = Object.keys(from).filter((c) => taught.has(c));
      if (!feeders.length || !KG.clusters[target]) return;
      const g = gradeIdx(clusterInfo(target).g);
      let kind;
      if (taught.has(target)) kind = "assessed";
      else if (inFile.has(target)) kind = "later";
      else if (g === maxGrade) kind = "later";
      else if (g === maxGrade + 1) kind = "next";
      else return;
      const others = Object.keys(from).filter((c) => !taught.has(c));
      out.push({ target, kind, feeders, others, links: from });
    });
    return out;
  }

  // A student's (or group's) readiness for a target: feeder scores weighted by number of standard links
  // (and by questions seen, when the ISR gave counts).
  function readiness(scoreOf, itemsOf, t) {
    let num = 0, den = 0, q = 0;
    t.feeders.forEach((c) => {
      const v = scoreOf(c);
      if (!Number.isFinite(v)) return;
      const w = t.links[c].length * (itemsOf(c) || 1);
      num += v * w; den += w; q += itemsOf(c) || 0;
    });
    return den ? { v: num / den, q } : null;
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

  // Follow-up quiz for a group: for each priority cluster, up to 2 IM v.360 Cool-downs (spread across the
  // cluster's standards, same grade first) and the Section Checkpoint that covers the most of its standards.
  function quizPlan(g) {
    const plan = [];
    g.priorities.slice(0, 3).forEach(({ c }) => {
      const info = clusterInfo(c);
      const byStd = info.s.map((s) => {
        const all = (stdInfo(s).cd || []).map((e) => ({ ...e, std: s }));
        return all.filter((e) => e.g === info.g).concat(all.filter((e) => e.g !== info.g));
      });
      const cds = [], seen = new Set();
      for (let i = 0; cds.length < 2 && byStd.some((l) => l[i]); i++) {
        byStd.forEach((l) => {
          const e = l[i];
          if (e && cds.length < 2 && !seen.has(e.n + e.l)) { seen.add(e.n + e.l); cds.push(e); }
        });
      }
      const cks = {};
      info.s.forEach((s) => (stdInfo(s).ck || []).forEach((e) => {
        const k = `${e.g}|${e.u}|${e.n}`;
        (cks[k] ||= { ...e, stds: [] }).stds.push(s);
      }));
      const ck = Object.values(cks).sort((a, b) => (b.g === info.g) - (a.g === info.g) || b.stds.length - a.stds.length)[0];
      if (cds.length || ck) plan.push({ c, cds, ck });
    });
    return plan;
  }
  const cooldownText = (e) => `Cool-down "${e.n}": IM 360 ${gradeName(e.g)}, ${e.u}, ${e.l}`;
  const checkpointText = (e) => `${e.n} (${e.s}): IM 360 ${gradeName(e.g)}, ${e.u}`;
  function quizPlainText(g) {
    const lines = [`Follow-up quiz: Group ${g.num} (${g.label})`, "IM v.360 items, free at accessim.org", ""];
    g.quiz.forEach((q) => {
      lines.push(`${q.c}: ${clusterInfo(q.c).d}`);
      q.cds.forEach((e) => lines.push(`  - ${cooldownText(e)} [${e.std}]`));
      if (q.ck) lines.push(`  - ${checkpointText(q.ck)} [${q.ck.stds.join(", ")}]`);
      lines.push("");
    });
    lines.push(`Students: ${g.members.map((m) => m.name).join("; ")}`);
    return lines.join("\n");
  }
  function renderQuiz(g) {
    if (!g.quiz.length) return "";
    const nCd = g.quiz.reduce((n, q) => n + q.cds.length, 0);
    const nCk = g.quiz.filter((q) => q.ck).length;
    return `<div class="quiz">
      <p class="kicker">Follow-up quiz before the next interim</p>
      <p class="small muted">Recheck this group's priority clusters with Illustrative Mathematics items. Find each one free on
        <a href="https://accessim.org/" target="_blank" rel="noopener">AccessIM</a> by grade, unit and lesson.
        ${nCd} Cool-down${nCd === 1 ? "" : "s"} (about 5 minutes each)${nCk ? ` and ${nCk} Section Checkpoint${nCk === 1 ? "" : "s"}` : ""}.</p>
      <ul class="quiz-list">${g.quiz.map((q) => `<li><strong>${esc(q.c)}</strong> <span class="muted">${esc(clusterInfo(q.c).d)}</span>
        <ul>${q.cds.map((e) => `<li>${esc(cooldownText(e))} <span class="muted">(${esc(e.std)})</span></li>`).join("")}
          ${q.ck ? `<li>${esc(checkpointText(q.ck))} <span class="muted">(covers ${q.ck.stds.map(esc).join(", ")})</span></li>` : ""}</ul></li>`).join("")}</ul>
      <button class="btn ghost copyquiz" type="button" data-group="${g.id}">Copy quiz list</button>
      <span class="small muted copy-status" aria-live="polite"></span>
    </div>`;
  }

  // ---------- analysis ----------
  // A student's overall result: pooled questions when counts are known, else the mean of cluster percents.
  function studentOverall(s, clusters) {
    const cs = clusters.map((c) => counts(s, c)).filter(Boolean);
    if (cs.length) return (100 * cs.reduce((a, x) => a + x.k, 0)) / cs.reduce((a, x) => a + x.n, 0);
    return mean(clusters.map((c) => s.scores[c]).filter(Number.isFinite));
  }
  // Which overall bands the teacher chose to group (all three by default).
  function includedBands() {
    return new Set(["need", "app", "prof"].filter((b) => { const el = $(`#inc-${b}`); return !el || el.checked; }));
  }

  function analyze() {
    const data = state.data;
    const t = thresholds();
    const inc = includedBands();
    // Only clusters the teacher has taught drive grouping, labels, overall scores and next steps.
    data.clusters = data.allClusters.filter((c) => !state.untaught.has(c));
    if (!data.clusters.length) {
      state.result = { groups: [], classMean: {}, t, pool: [], excluded: [], noClusters: true };
      return;
    }
    data.students.forEach((s) => { s.overall = studentOverall(s, data.clusters); s.overallBand = band(s.overall, t); });
    const pool = data.students.filter((s) => inc.has(s.overallBand));
    const excluded = data.students.filter((s) => !inc.has(s.overallBand));
    const classMean = {};
    data.allClusters.forEach((c) => { classMean[c] = mean(pool.map((s) => s.scores[c]).filter(Number.isFinite)); });
    if (pool.length < 2) {
      state.result = { groups: [], classMean, t, pool, excluded, tooFew: true };
      return;
    }
    const { k, assign } = group({ ...data, students: pool }, $("#k").value);

    let groups = Array.from({ length: k }, (_, j) => {
      const members = pool.filter((_, i) => assign[i] === j);
      const means = {}, tally = {};
      data.clusters.forEach((c) => {
        const scored = members.filter((m) => Number.isFinite(m.scores[c]));
        const cs = scored.map((m) => counts(m, c));
        if (scored.length && cs.every(Boolean)) {
          // Pool questions: 9 of 16 correct across the group, not an average of percents.
          const k = cs.reduce((a, x) => a + x.k, 0), n = cs.reduce((a, x) => a + x.n, 0);
          tally[c] = { k, n };
          means[c] = (100 * k) / n;
        } else {
          means[c] = mean(scored.map((m) => m.scores[c]));
        }
      });
      const overall = mean(data.clusters.map((c) => means[c]).filter(Number.isFinite));
      return { id: j, members, means, tally, overall };
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
      g.priorities = orderPriorities(g.needs.concat(g.approaching), g);
      g.label = groupLabel(g, data.clusters);
      if (g.label === "Broad foundational support" && g.needs.length) {
        g.label += `, starting with ${g.priorities[0]?.c || g.needs[0]}`;
      }
      g.steps = nextSteps(g, t);
      g.quiz = quizPlan(g);
    });
    state.result = { groups, classMean, t, pool, excluded };
  }

  function groupLabel(g, clusters) {
    if (!g.needs.length && !g.approaching.length) return "Ready to extend";
    // "Broad" only when needs span nearly every domain tested; otherwise name the weak domains.
    const allDoms = new Set(clusters.map((c) => clusterInfo(c).dom));
    const needDoms = new Set(g.needs.map((c) => clusterInfo(c).dom));
    if (allDoms.size >= 3 && g.overall < thresholds().app && needDoms.size >= Math.ceil(allDoms.size * 0.75)) return "Broad foundational support";
    const focus = (g.priorities?.length ? g.priorities.map((p) => p.c) : g.needs.length ? g.needs : g.approaching).slice(0, 2);
    // With only a few clusters taught (or one domain), domain names don't tell groups apart; name the clusters.
    if (clusters.length <= 5 || allDoms.size < 3) return `Focus: ${focus.join(" & ")}`;
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
          ? `Reteach ${c} (${groupScore(g, c)})`
          : `Targeted practice on ${c} (${groupScore(g, c)})`,
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
          title: `Extend ${c} (${groupScore(g, c)})`,
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
    const grades = [...new Set(d.allClusters.map((c) => clusterInfo(c).g))].sort((a, b) => gradeIdx(a) - gradeIdx(b));
    const classAvg = mean(d.clusters.map((c) => state.result.classMean[c]).filter(Number.isFinite));
    $("#summary").innerHTML = [
      [state.result.pool.length, "students grouped"],
      ...(state.result.excluded.length ? [[state.result.excluded.length, "not in this grouping"]] : []),
      ...(d.notTested.length ? [[d.notTested.length, "set aside (all 0%)"]] : []),
      [d.clusters.length < d.allClusters.length ? `${d.clusters.length} of ${d.allClusters.length}` : d.clusters.length,
        `clusters${d.clusters.length < d.allClusters.length ? " taught so far" : ""} (${grades.map(gradeName).join(", ")})`],
      [groups.length, "groups"],
      [`${round(classAvg)}%`, "average of grouped students"],
    ].map(([v, l]) => `<div class="stat"><div class="v">${esc(v)}</div><div class="l">${esc(l)}</div></div>`).join("");
  }

  function renderGroups() {
    const { groups, classMean, t, excluded, tooFew, noClusters } = state.result;
    if (noClusters) {
      $("#tab-groups").innerHTML = `<p class="msg warn">No clusters are marked as taught, so there's nothing to group on. Tick at least one cluster under "Clusters taught so far" above.</p>`;
      return;
    }
    const opts = (cur) => groups.map((g) => `<option value="${g.id}"${g.id === cur ? " selected" : ""}>Group ${g.num}</option>`).join("");
    const BAND_RANGE = { need: `below ${t.app}%`, app: `${t.app}–${t.prof - 1}%`, prof: `${t.prof}%+` };
    const chosen = [...includedBands()].map((b) => BAND_LABEL[b]).join(" + ");
    const intro = tooFew
      ? `<p class="msg warn">Fewer than two students are ${esc(chosen || "selected")} overall, so there's nothing to group. Change "Group these students" above.</p>`
      : excluded.length ? `<p class="small muted">Grouping ${esc(chosen)} students only, by each student's overall score on the taught clusters.</p>` : "";
    const excludedCard = excluded.length ? `<article class="group aside">
        <div class="group-head"><h3>Not in this grouping</h3><span class="muted small">${excluded.length} student(s)</span></div>
        <p class="small">Left out by the "Group these students" setting. Overall score shown for each.</p>
        ${["need", "app", "prof"].filter((b) => excluded.some((s) => s.overallBand === b)).map((b) => `
          <p class="small"><span class="band ${b}">${BAND_LABEL[b]} (${BAND_RANGE[b]})</span></p>
          <div class="members">${excluded.filter((s) => s.overallBand === b).sort((x, y) => x.overall - y.overall)
            .map((m) => `<span class="chip"${metaTitle(m)}>${esc(m.name)} <span class="muted">${round(m.overall)}%</span></span>`).join("")}</div>`).join("")}
      </article>` : "";
    $("#tab-groups").innerHTML = intro + groups.map((g) => {
      const profile = state.data.clusters.map((c) => {
        const b = band(g.means[c], t);
        const delta = g.means[c] - classMean[c];
        return `<div class="pcell ${b}" title="${esc(clusterInfo(c).d)}"><span>${esc(c)}</span><span>${round(g.means[c])}%${g.tally?.[c] ? ` <span class="delta">${g.tally[c].k}/${g.tally[c].n}</span>` : ""} <span class="delta">(${delta >= 0 ? "+" : ""}${round(delta)})</span></span></div>`;
      }).join("");
      const distinct = g.distinct.map((x) => `${esc(x.c)} ${x.d >= 0 ? "above" : "below"} class average by ${Math.abs(round(x.d))} pts`).join("; ");
      const insightClusters = [...new Set(g.priorities.map((p) => p.c).concat(g.priorities.length ? [] : g.strengths.slice(0, 2)))].slice(0, 4);
      return `<article class="group">
        <div class="group-head">
          <h3>Group ${g.num}: ${esc(g.label)}</h3>
          <span class="muted small">${g.members.length} student${g.members.length === 1 ? "" : "s"} · average ${round(g.overall)}%${normRange(g.members)}</span>
        </div>
        <div class="members">${g.members.map((m) => `<span class="chip"${metaTitle(m)}>${esc(m.name)}
          <select aria-label="Move ${esc(m.name)} to another group" data-student="${esc(m.name)}">${opts(g.id)}</select></span>`).join("")}</div>
        <div class="profile">${profile}</div>
        <p class="small"><strong>What sets this group apart:</strong> ${distinct || "—"}.</p>
        ${(() => {
          const a = groupAhead(g);
          if (!a.need.length && !a.app.length) return "";
          return `<p class="small"><strong>Looking ahead:</strong> ${a.need.length ? `at risk for ${a.need.map(esc).join(", ")}` : ""}${a.need.length && a.app.length ? "; " : ""}${a.app.length ? `watch ${a.app.map(esc).join(", ")}` : ""}. <span class="muted">See the Looking ahead tab.</span></p>`;
        })()}
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
        ${renderQuiz(g)}
      </article>`;
    }).join("") + (state.data.notTested.length ? `<article class="group aside">
        <div class="group-head"><h3>Check these students</h3><span class="muted small">${state.data.notTested.length} student(s) · not grouped</span></div>
        <p class="small">These students scored 0% on every cluster. Check how the test went for them (not submitted, not completed, or a real result) before planning. To group them anyway, untick "Set aside students who scored 0%" above to include them.</p>
        <div class="members">${state.data.notTested.map((m) => `<span class="chip"${metaTitle(m)}>${esc(m.name)}</span>`).join("")}</div>
      </article>` : "") + excludedCard;
    $("#tab-groups").querySelectorAll(".copyquiz").forEach((btn) => btn.addEventListener("click", () => {
      const g = groups.find((x) => String(x.id) === btn.dataset.group);
      const status = btn.nextElementSibling;
      const text = quizPlainText(g);
      const fallback = () => {
        const ta = document.createElement("textarea");
        ta.value = text; ta.rows = 8; ta.className = "copy-fallback"; ta.readOnly = true;
        btn.parentElement.appendChild(ta); ta.focus(); ta.select();
        status.textContent = "Copying isn't allowed here. The list is selected below; copy it with Ctrl+C or Cmd+C.";
      };
      try {
        navigator.clipboard.writeText(text).then(() => { status.textContent = "Copied."; }, fallback);
      } catch { fallback(); }
    }));
    $("#tab-groups").querySelectorAll("select[data-student]").forEach((sel) => sel.addEventListener("change", () => {
      state.overrides[sel.dataset.student] = Number(sel.value);
      run(false);
    }));
  }

  // "National Norm 41–88 (median 64)" for a set of students, when the data has percentiles.
  function normRange(list) {
    const v = list.filter((m) => /^\d+(\.\d+)?$/.test(String(m.meta?.norm ?? "").trim())).map((m) => Number(m.meta.norm)).sort((a, b) => a - b);
    if (!v.length) return "";
    const med = v.length % 2 ? v[(v.length - 1) / 2] : (v[v.length / 2 - 1] + v[v.length / 2]) / 2;
    const range = v[0] === v[v.length - 1] ? `${v[0]}` : `${v[0]}–${v[v.length - 1]}`;
    return ` · National Norm percentile ${range}${v[0] !== v[v.length - 1] ? ` (median ${Math.round(med)})` : ""}`;
  }

  function metaTitle(m) {
    const bits = [m.meta?.level, m.meta?.scale ? `Scale score ${m.meta.scale}` : "", m.meta?.norm ? `National Norm percentile ${m.meta.norm}` : "", m.meta?.id ? `ID ${m.meta.id}` : ""].filter(Boolean);
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
    const cl = d.allClusters;
    const taught = new Set(d.clusters);
    const extra = [d.hasMeta.level && ["level", "Level"], d.hasMeta.scale && ["scale", "Scale score"], d.hasMeta.norm && ["norm", "National Norm %ile"]].filter(Boolean);
    const ncol = cl.length + 1 + extra.length;
    const head = `<tr><th scope="col">Student</th>${extra.map(([, l]) => `<th scope="col">${l}</th>`).join("")}${cl.map((c) => `<th scope="col" class="${taught.has(c) ? "" : "untaught"}" title="${esc(clusterInfo(c).d)}">${esc(c)}${taught.has(c) ? "" : `<span class="sub">not yet taught</span>`}</th>`).join("")}</tr>`;
    const row = (m) => `<tr><td>${esc(m.name)}</td>${extra.map(([k]) => `<td>${esc(m.meta?.[k] || "")}</td>`).join("")}${cl.map((c) => {
      const v = m.scores[c];
      const ct = counts(m, c);
      if (m.items && m.items[c] === 0) return `<td class="none" title="No questions on this cluster">n/a</td>`;
      const cls = taught.has(c) ? band(v, t) : "untaught";
      return `<td class="${cls}"${ct ? ` title="${ct.k} of ${ct.n} questions correct"` : ""}>${Number.isFinite(v) ? round(v) : "—"}${ct ? `<span class="frac">${ct.k}/${ct.n}</span>` : ""}</td>`;
    }).join("")}</tr>`;
    const body = groups.map((g) => `<tr class="grp"><td colspan="${ncol}">Group ${g.num}: ${esc(g.label)}</td></tr>` + g.members.map(row).join("")).join("") +
      (state.result.excluded.length ? `<tr class="grp"><td colspan="${ncol}">Not in this grouping</td></tr>` + state.result.excluded.map(row).join("") : "") +
      (d.notTested.length ? `<tr class="grp"><td colspan="${ncol}">Set aside: 0% on every cluster</td></tr>` + d.notTested.map(row).join("") : "");
    const avg = `<tr class="grp"><td>Average (grouped)</td>${extra.map(() => "<td></td>").join("")}${cl.map((c) => `<td class="${taught.has(c) ? band(classMean[c], t) : "untaught"}">${round(classMean[c])}</td>`).join("")}</tr>`;
    $("#tab-heatmap").innerHTML = `<div class="legend">${["prof", "app", "need"].map((b) => `<span class="band ${b}">${BAND_LABEL[b]}</span>`).join("")}<span class="muted">Cells show percent scores${d.hasItems ? ", with questions correct out of questions seen below" : ""}. "—" means no score${d.hasItems ? "; n/a means the student saw no questions on that cluster" : ""}.</span></div>
      <div class="table-wrap"><table class="heat"><thead>${head}</thead><tbody>${body}${avg}</tbody></table></div>`;
  }

  function renderClusters() {
    const { t, classMean, groups } = state.result;
    const groupOf = {};
    groups.forEach((g) => g.members.forEach((m) => { groupOf[m.name] = g.num; }));
    const d = state.data;
    const untaught = d.allClusters.filter((c) => !d.clusters.includes(c));
    const order = d.clusters.slice().sort((a, b) => classMean[a] - classMean[b]).concat(untaught);
    $("#tab-clusters").innerHTML = `<p class="small muted">Use this view for quick skill-based pull-outs on a single cluster, regardless of overall group.${untaught.length ? " Clusters not yet taught are listed last." : ""}</p>` +
      order.map((c) => {
        const isUntaught = untaught.includes(c);
        const bands = { prof: [], app: [], need: [], none: [] };
        state.data.students.forEach((s) => bands[band(s.scores[c], t)].push(s));
        const n = state.data.students.length;
        const pct = (b) => (bands[b].length / n) * 100;
        const list = (b) => bands[b].sort((x, y) => x.scores[c] - y.scores[c]).map((s) => { const ct = counts(s, c); return `${esc(s.name)} <span class="muted">${ct ? `${ct.k}/${ct.n}` : round(s.scores[c])}${groupOf[s.name] ? ` · G${groupOf[s.name]}` : ""}</span>`; }).join("<br>") || "<span class=\"muted\">None</span>";
        return `<div class="cl-card${isUntaught ? " untaught" : ""}">
          <div class="group-head"><h3>${esc(c)}${isUntaught ? ` <span class="band none">Not yet taught</span>` : ""}</h3><span class="band ${isUntaught ? "none" : band(classMean[c], t)}">Class average ${round(classMean[c])}%</span></div>
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

  // Checkbox list of the file's clusters, so teachers can leave out what they haven't taught yet.
  function renderTaught() {
    const d = state.data;
    const box = $("#taught");
    const key = d.allClusters.join("|");
    if (box.dataset.key !== key) {
      box.dataset.key = key;
      box.innerHTML = d.allClusters.map((c) => `<label class="taught-item">
          <input type="checkbox" data-cluster="${esc(c)}"${state.untaught.has(c) ? "" : " checked"}>
          <span><strong>${esc(c)}</strong> <span class="muted">${esc(clusterInfo(c).d)}</span></span>
        </label>`).join("");
    }
    const n = d.allClusters.length - d.allClusters.filter((c) => state.untaught.has(c)).length;
    $("#taught-count").textContent = `${n} of ${d.allClusters.length} ticked`;
  }

  function showSettings(on) {
    $("#settings-body").hidden = !on;
    $("#settings-empty").hidden = on;
  }

  // Confirm that a settings change regrouped the class.
  let flashTimer = null;
  function flashUpdated() {
    const el = $("#updated");
    const r = state.result;
    const time = new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    el.textContent = r.noClusters || r.tooFew ? `Updated ${time}: no groups with these settings`
      : `✓ Groups updated ${time}: ${r.groups.length} groups, ${r.pool.length} students`;
    el.classList.add("on");
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => el.classList.remove("on"), 1500);
  }

  const READY = { prof: "On track", app: "Watch", need: "At risk" };
  const KIND = { later: "Later this year", next: "Next grade", assessed: "Already assessed (forecast check)" };

  function renderAhead() {
    const d = state.data, { t, groups } = state.result;
    const box = $("#tab-ahead");
    if (!d.clusters.length) { box.innerHTML = `<p class="msg warn">Tick at least one taught cluster to see what's ahead.</p>`; return; }
    const groupOf = {};
    groups.forEach((g) => g.members.forEach((m) => { groupOf[m.name] = g.num; }));
    const students = d.students;
    const targets = upcomingTargets(d);
    if (!targets.length) { box.innerHTML = `<p class="small muted">The Coherence Map has no links from the taught clusters to later clusters in this grade or the next one.</p>`; return; }

    const cards = targets.map((tg) => {
      const per = students.map((s) => ({ s, r: readiness((c) => s.scores[c], (c) => counts(s, c)?.n, tg) })).filter((x) => x.r);
      const bands = { need: [], app: [], prof: [] };
      per.forEach((x) => bands[band(x.r.v, t)].push(x));
      const risk = per.length ? bands.need.length / per.length : 0;
      // Where the target was itself assessed, compare forecast band with the real band.
      let check = "";
      if (tg.kind === "assessed") {
        const both = per.filter((x) => Number.isFinite(x.s.scores[tg.target]));
        const agree = both.filter((x) => band(x.r.v, t) === band(x.s.scores[tg.target], t)).length;
        const close = both.filter((x) => Math.abs(["need", "app", "prof"].indexOf(band(x.r.v, t)) - ["need", "app", "prof"].indexOf(band(x.s.scores[tg.target], t))) <= 1).length;
        check = both.length ? `<p class="small"><strong>Forecast check:</strong> the forecast matched the actual ${esc(tg.target)} result for ${agree} of ${both.length} students, and was within one level for ${close}.</p>` : "";
      }
      const name = (x) => {
        const limited = x.r.q > 0 && x.r.q < 3 ? " · limited evidence" : "";
        return `${esc(x.s.name)} <span class="muted">${round(x.r.v)}%${groupOf[x.s.name] ? ` · G${groupOf[x.s.name]}` : ""}${limited}</span>`;
      };
      const list = (b) => bands[b].sort((x, y) => x.r.v - y.r.v).map(name).join("<br>") || `<span class="muted">None</span>`;
      const linkList = tg.feeders.map((c) => `<li><strong>${esc(c)}</strong> → ${esc(tg.target)}: ${tg.links[c].map(([a, b]) => `${esc(a)} → ${esc(b)}`).join(", ")}
          <ul>${[...new Set(tg.links[c].map(([, b]) => b))].map((b) => `<li class="muted">${esc(b)}: ${esc(stdInfo(b).d)}</li>`).join("")}</ul></li>`).join("");
      const pct = (b) => (per.length ? (bands[b].length / per.length) * 100 : 0);
      const html = `<div class="cl-card">
        <div class="group-head"><h3>${esc(tg.target)} <span class="band none">${KIND[tg.kind]}</span></h3>
          <span class="small muted">${esc(gradeName(clusterInfo(tg.target).g))} · ${esc(domainName(tg.target))}</span></div>
        <p class="small">${esc(clusterInfo(tg.target).d)}</p>
        <p class="small"><strong>Builds on (from your data):</strong> ${tg.feeders.map(esc).join(", ")}${tg.others.length ? ` <span class="muted">· also builds on ${tg.others.map(esc).join(", ")}, which ${tg.others.length === 1 ? "isn't" : "aren't"} in this data or ${tg.others.length === 1 ? "isn't" : "aren't"} ticked as taught</span>` : ""}</p>
        <div class="bar" aria-hidden="true"><span class="need" style="width:${pct("need")}%"></span><span class="app" style="width:${pct("app")}%"></span><span class="prof" style="width:${pct("prof")}%"></span></div>
        <div class="bands">
          <div class="need"><strong>At risk (${bands.need.length})</strong><br>${list("need")}</div>
          <div class="app"><strong>Watch (${bands.app.length})</strong><br>${list("app")}</div>
          <div class="prof"><strong>On track (${bands.prof.length})</strong><br>${list("prof")}</div>
        </div>
        ${check}
        <details class="cluster"><summary>Why: the standard-to-standard links</summary><ul class="lc-list">${linkList}</ul></details>
      </div>`;
      return { tg, risk, html };
    });
    const order = { later: 0, next: 1, assessed: 2 };
    cards.sort((a, b) => order[a.tg.kind] - order[b.tg.kind] || b.risk - a.risk);
    const section = (kind, title, note) => {
      const cs = cards.filter((c) => c.tg.kind === kind);
      return cs.length ? `<h3 class="ahead-h">${title}</h3><p class="small muted">${note}</p>${cs.map((c) => c.html).join("")}` : "";
    };
    box.innerHTML = `<p class="small">Readiness for upcoming clusters, from each student's results on the taught clusters that the
        <a href="https://achievethecore.org/coherence-map/" target="_blank" rel="noopener">Coherence Map</a> says build toward them.
        It's a heads-up about who may need support, based on your cutoffs (On track ${t.prof}%+, Watch ${t.app}–${t.prof - 1}%, At risk below ${t.app}%), not a prediction of scores.</p>` +
      section("later", "Later this year", "Clusters in this grade you haven't taught yet.") +
      section("next", "Next grade", "Where this year's clusters lead.") +
      section("assessed", "Already assessed: how well does the forecast hold up?", "These clusters are taught and scored, so the forecast can be compared with what actually happened in your class.");
  }

  // Group-level "looking ahead": upcoming clusters this group is at risk or on watch for.
  function groupAhead(g) {
    const t = state.result.t;
    const found = { need: [], app: [] };
    upcomingTargets(state.data).filter((tg) => tg.kind !== "assessed").forEach((tg) => {
      const r = readiness((c) => g.means[c], (c) => g.tally?.[c]?.n, tg);
      if (!r) return;
      const b = band(r.v, t);
      if (b !== "prof") found[b].push({ c: tg.target, v: r.v, later: tg.kind === "later" });
    });
    // Keep it scannable: this year's clusters first, then the weakest; at most 3 of each.
    const pick = (list) => {
      list.sort((a, b) => (b.later - a.later) || a.v - b.v);
      const names = list.slice(0, 3).map((x) => x.c);
      if (list.length > 3) names.push(`${list.length - 3} more`);
      return names;
    };
    return { need: pick(found.need), app: pick(found.app) };
  }

  // ---------- remembering a teacher's settings and moves for the same data (this browser only) ----------
  const STORE_PREFIX = "student-grouping-planner:v1:";
  const DEFAULTS = { k: "auto", prof: "80", app: "60", inc: ["need", "app", "prof"], untaught: [], zeroAside: true };

  // Identifies a class's data regardless of file names, upload order or row order.
  function fingerprint(d) {
    const rows = d.students.concat(d.notTested).map((s) => [String(s.id || s.name),
      d.allClusters.map((c) => (Number.isFinite(s.scores[c]) ? Math.round(s.scores[c]) : null)),
      s.items ? d.allClusters.map((c) => s.items[c] ?? null) : null]).sort((a, b) => a[0].localeCompare(b[0]));
    const str = JSON.stringify([d.allClusters.slice().sort(), rows]);
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
    return `${(h >>> 0).toString(36)}-${str.length.toString(36)}`;
  }
  function currentSettings() {
    return {
      k: $("#k").value, prof: $("#t-prof").value, app: $("#t-app").value,
      inc: ["need", "app", "prof"].filter((b) => $(`#inc-${b}`).checked),
      untaught: [...state.untaught], zeroAside: $("#zero-aside").checked,
    };
  }
  function applySettings(s) {
    $("#k").value = s.k; $("#t-prof").value = s.prof; $("#t-app").value = s.app;
    ["need", "app", "prof"].forEach((b) => { $(`#inc-${b}`).checked = s.inc.includes(b); });
    state.untaught = new Set(s.untaught);
    $("#zero-aside").checked = s.zeroAside;
    $("#taught").dataset.key = ""; // redraw the cluster checkboxes
  }
  function saveState() {
    if (!state.data || !state.fp || state.sources.csv?.sample) return;
    try {
      localStorage.setItem(STORE_PREFIX + state.fp, JSON.stringify({ savedAt: Date.now(), settings: currentSettings(), overrides: state.overrides }));
    } catch { /* storage unavailable: nothing to remember */ }
  }
  function loadState(fp) {
    try { return JSON.parse(localStorage.getItem(STORE_PREFIX + fp) || "null"); } catch { return null; }
  }
  function forgetState(fp) {
    try { localStorage.removeItem(STORE_PREFIX + fp); } catch { /* ignore */ }
  }

  function run(resetOverrides) {
    if (!state.data) return;
    if (resetOverrides) state.overrides = {};
    renderTaught();
    analyze();
    renderSummary();
    renderGroups();
    renderHeatmap();
    renderClusters();
    renderAhead();
    showSettings(true);
    flashUpdated();
    $("#results").hidden = false;
    saveState();
  }

  // Rebuild the class from whatever sources are loaded (CSV, ISR or both).
  function rebuild(scroll = true, extraNotes = []) {
    const { csv, isr } = state.sources;
    const used = [csv && `${esc(csv.label)} (CSV)`, isr && `${esc(isr.label)} (ISR PDF)`].filter(Boolean);
    const restart = used.length ? ` <button id="clear" class="linkbtn" type="button">Start over</button>` : "";
    try {
      let data = combineSources();
      if (!data) return;
      // Same class data as a saved session in this browser? Bring back its settings and moved students.
      const fp = fingerprint(data);
      let restored = null;
      if (fp !== state.fp) {
        const saved = csv?.sample ? null : loadState(fp);
        const zeroBefore = $("#zero-aside").checked;
        applySettings(saved ? { ...DEFAULTS, ...saved.settings } : { ...DEFAULTS, untaught: [] });
        state.overrides = saved?.overrides || {};
        restored = saved;
        state.restored = saved;
        // The "set aside 0% students" setting is applied while combining the files, so redo that if it changed.
        if ($("#zero-aside").checked !== zeroBefore) data = combineSources();
        state.fp = fp;
      } else {
        // Same class data (e.g. the CSV added to an ISR with the same results): keep settings and moves.
        restored = state.restored;
      }
      state.data = data;
      const total = data.students.length + data.notTested.length;
      const hint = csv && !isr ? " Add the ISR PDF to see how many questions each student saw per cluster." : isr && !csv ? " You can also add the CSV export." : "";
      const moves = restored ? Object.keys(restored.overrides || {}).length : 0;
      const restoredNote = restored ? [{ type: "ok", text: `Restored the settings${moves ? ` and ${moves} moved student${moves === 1 ? "" : "s"}` : ""} saved in this browser for this class data on ${esc(new Date(restored.savedAt).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }))}. <button id="reset-saved" class="linkbtn" type="button">Reset to the recommended groups</button>` }] : [];
      renderMessages([{ type: "ok", text: `Using ${used.join(" + ")}: ${total} students, ${data.clusters.length} clusters.${hint}${restart}` }, ...restoredNote, ...extraNotes, ...data.notes]);
      run(false);
      if (scroll) $("#results").scrollIntoView({ behavior: "smooth", block: "start" });
    } catch (e) {
      state.data = null;
      showSettings(false);
      $("#results").hidden = true;
      renderMessages([...extraNotes, { type: "error", text: `${esc(e.message)}${restart}` }]);
    }
  }

  function load(text, label, scroll = true) {
    try {
      state.sources = { csv: { ...interpretCSV(parseCSV(text)), label, sample: true } };
      rebuild(scroll);
    } catch (e) {
      renderMessages([{ type: "error", text: esc(e.message) }]);
    }
  }

  async function addFiles(files) {
    const errors = [];
    // Your own files replace the sample class rather than merging with it.
    if (state.sources.csv?.sample) state.sources = {};
    for (const f of [...files]) {
      const isPdf = /\.pdf$/i.test(f.name) || f.type === "application/pdf";
      try {
        if (isPdf) {
          renderMessages([{ type: "ok", text: `Reading ${esc(f.name)}… large report files can take a few seconds.` }]);
          const text = await pdfToText(await f.arrayBuffer());
          state.sources.isr = { ...parseISRText(text), label: f.name };
        } else {
          state.sources.csv = { ...interpretCSV(parseCSV(await f.text())), label: f.name };
        }
      } catch (e) {
        errors.push({ type: "error", text: `${esc(f.name)}: ${esc(e.message)}` });
      }
    }
    if (state.sources.csv || state.sources.isr) rebuild(true, errors);
    else renderMessages(errors);
  }

  function exportCSV() {
    const { groups } = state.result;
    const cl = state.data.allClusters;
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
    dz.addEventListener("click", () => file.click());
    dz.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); file.click(); } });
    file.addEventListener("change", () => { const fs = [...file.files]; file.value = ""; addFiles(fs); });
    ["dragenter", "dragover"].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add("drag"); }));
    ["dragleave", "drop"].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove("drag"); }));
    dz.addEventListener("drop", (e) => addFiles(e.dataTransfer.files));
    $("#messages").addEventListener("click", (e) => {
      if (e.target.id === "reset-saved") {
        forgetState(state.fp);
        state.fp = null; state.restored = null; // treat as new data: defaults, no moves
        rebuild(false);
        return;
      }
      if (e.target.id !== "clear") return;
      state.sources = {}; state.data = null; state.fp = null; state.restored = null;
      showSettings(false); $("#results").hidden = true;
      renderMessages([]);
    });
    $("#sample").addEventListener("click", () => load(window.SAMPLE_CSV, "sample Grade 6 class (fictional PRoPL Interim 1)"));
    $("#format-toggle").addEventListener("click", (e) => {
      const h = $("#format-help"); h.hidden = !h.hidden; e.currentTarget.setAttribute("aria-expanded", String(!h.hidden));
    });
    $("#k").addEventListener("change", () => run(true));
    $("#zero-aside").addEventListener("change", () => rebuild(false));
    $("#regroup").addEventListener("click", () => {
      run(true);
      $("#results").scrollIntoView({ behavior: "smooth", block: "start" });
    });
    $("#taught").addEventListener("change", (e) => {
      const c = e.target.dataset?.cluster;
      if (!c) return;
      if (e.target.checked) state.untaught.delete(c); else state.untaught.add(c);
      run(true);
    });
    ["all", "none"].forEach((w) => $(`#taught-${w}`).addEventListener("click", () => {
      if (!state.data) return;
      state.untaught = new Set(w === "all" ? [] : state.data.allClusters);
      $("#taught").querySelectorAll("input[data-cluster]").forEach((el) => { el.checked = w === "all"; });
      run(true);
    }));
    ["#t-prof", "#t-app", "#inc-need", "#inc-app", "#inc-prof"].forEach((s) => $(s).addEventListener("change", () => run(false)));
    $("#export")?.addEventListener("click", exportCSV);
    $("#print")?.addEventListener("click", () => window.print());
    document.querySelectorAll(".tab").forEach((tab) => tab.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach((t) => t.setAttribute("aria-selected", String(t === tab)));
      document.querySelectorAll(".tabpanel").forEach((p) => { p.hidden = p.id !== `tab-${tab.dataset.tab}`; });
    }));
  }

  // Expose pure functions for tests.
  window.GroupingApp = { parseCSV, interpret, matchCode, kmeans, prerequisites, buildsToward, _state: state };
  init();
})();
