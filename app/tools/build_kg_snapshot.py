#!/usr/bin/env python3
"""
Build the compact Knowledge Graph snapshot used by the Student Grouping app.

Reads the full Knowledge Graph export (nodes.jsonl + relationships.jsonl) and
writes app/data/kg-math-k8.js (window.KG_DATA = {...}) with Common Core Math K-8 clusters, standards,
learning components, Coherence Map progressions and aligned IM lessons.

Usage:
    python3 app/tools/build_kg_snapshot.py --nodes nodes.jsonl \
        --relationships relationships.jsonl --version v1.17.0

Download the export files from
https://cdn.learningcommons.org/knowledge-graph/<version>/exports/nodes.jsonl
https://cdn.learningcommons.org/knowledge-graph/<version>/exports/relationships.jsonl
"""

import argparse
import json
import os
import re
from collections import defaultdict

GRADES = ["K", "1", "2", "3", "4", "5", "6", "7", "8"]
CODE_RE = re.compile(r"^(K|[1-8])\.[A-Z]+\.[A-Z]\.\d+")
CLUSTER_RE = re.compile(r"^(K|[1-8])\.[A-Z]+\.[A-Z]$")
DOMAIN_RE = re.compile(r"^(K|[1-8])\.[A-Z]+$")
MAX_LESSONS = 6
MAX_COOLDOWNS = 4
MAX_CHECKPOINTS = 3
IM_COURSE_RE = re.compile(r"^im360:(K|[1-8])$", re.I)  # grade courses only (no accelerated)


def parse_list(value):
    if not value:
        return []
    if isinstance(value, list):
        return value
    try:
        out = json.loads(value)
        return out if isinstance(out, list) else [out]
    except (ValueError, TypeError):
        return [value]


def clean_text(text):
    """Turn simple LaTeX ($\\frac{a}{b}$, \\times, ...) into plain text."""
    t = text or ""
    # Only treat $...$ as math when it holds LaTeX; otherwise it is a dollar amount.
    t = re.sub(r"\$([^$]*[\\^{][^$]*)\$", r"\1", t)
    t = re.sub(r"(\d)\\[dt]?frac", r"\1 \\frac", t)  # mixed numbers: 9\frac{3}{4} -> 9 3/4
    while True:  # innermost first, so nested fractions work
        t2 = re.sub(r"\\[dt]?frac\{([^{}]*)\}\{([^{}]*)\}",
                    lambda m: "/".join(f"({x})" if "/" in x else x for x in m.groups()), t)
        if t2 == t:
            break
        t = t2
    for a, b in (("\\times", "×"), ("\\div", "÷"), ("\\cdot", "·"), ("\\leq", "≤"),
                 ("\\geq", "≥"), ("\\le", "≤"), ("\\ge", "≥"), ("\\left", ""), ("\\right", ""), ("\\neq", "≠"), ("\\pi", "π"), ("\\Box", "□"), ("\\sqrt", "√"),
                 ("\\%", "%"), ("\\$", "$")):
        t = t.replace(a, b)
    t = re.sub(r"\^\{([^{}]*)\}", r"^\1", t)
    return re.sub(r"\s+", " ", t).strip()


def lc_key(desc):
    """Key that treats 'X (denominators limited to ...)' and 'X' as the same component."""
    return re.sub(r"\s*\([^)]*\)", "", desc).strip().lower()


def standard_code(code):
    """Roll a component code (3.MD.C.5.b) up to its standard (3.MD.C.5)."""
    m = CODE_RE.match(code or "")
    return m.group(0) if m else None


def cluster_of(code):
    return ".".join(code.split(".")[:3])


def domain_of(code):
    return ".".join(code.split(".")[:2])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--nodes", required=True)
    ap.add_argument("--relationships", required=True)
    ap.add_argument("--version", required=True)
    ap.add_argument(
        "--out",
        default=os.path.join(os.path.dirname(__file__), "..", "data", "kg-math-k8.js"),
    )
    args = ap.parse_args()

    ccss = {}          # node id -> props (CCSS math items, K-8)
    lcs = {}           # node id -> props (learning components)
    lessons = {}       # node id -> props (IM lessons)
    groupings = {}     # node id -> props (IM units / sections)
    assessments = {}   # node id -> props (IM cool-downs, checkpoints, unit assessments)
    attributions = set()

    with open(args.nodes) as f:
        for line in f:
            d = json.loads(line)
            label = d["labels"][0]
            p = d["properties"]
            if label == "StandardsFrameworkItem":
                if p.get("jurisdiction") == "Multi-State" and p.get("academicSubject") == "Mathematics":
                    ccss[d["identifier"]] = p
            elif label == "LearningComponent":
                if p.get("academicSubject") == "Mathematics":
                    lcs[d["identifier"]] = p
            elif label == "Lesson":
                if IM_COURSE_RE.match(str(p.get("courseCode", ""))):
                    lessons[d["identifier"]] = p
            elif label == "LessonGrouping":
                groupings[d["identifier"]] = p
            elif label == "Assessment":
                if IM_COURSE_RE.match(str(p.get("courseCode", ""))):
                    assessments[d["identifier"]] = p

    domains, clusters, standards, alt_codes = {}, {}, {}, {}
    id_to_std = {}  # CCSS node id -> standard code (components roll up)
    domain_ids = {}  # CCSS domain node id -> name (domains have no statement code)
    cluster_ids = {}  # CCSS cluster node id -> cluster code
    for nid, p in ccss.items():
        code = p.get("statementCode") or ""
        if p.get("statementType") == "Domain":
            domain_ids[nid] = clean_text(p.get("description", ""))
        elif DOMAIN_RE.match(code):
            domains[code] = clean_text(p.get("description", ""))
        elif CLUSTER_RE.match(code):
            cluster_ids[nid] = code
            clusters[code] = {
                "d": clean_text(p.get("description", "")),
                "g": code.split(".")[0],
                "dom": domain_of(code),
                "s": [],
            }
            attributions.add(p.get("attributionStatement", ""))
        else:
            sc = standard_code(code)
            if not sc:
                continue
            id_to_std[nid] = sc
            if code == sc:
                alt = p.get("alternateStatementCode")
                if alt and alt != sc:
                    alt_codes[alt] = sc
                standards[sc] = {
                    "d": clean_text(p.get("description", "")),
                    "g": sc.split(".")[0],
                    "cl": cluster_of(sc),
                    "lc": [],
                    "pre": set(),
                    "next": set(),
                    "rel": set(),
                    "les": [],
                }

    lc_seen = defaultdict(dict)
    lesson_to_std = defaultdict(set)
    cooldown_to_std = defaultdict(set)
    section_to_std = defaultdict(set)
    parent = {}  # lesson / assessment / grouping -> containing lesson or grouping
    with open(args.relationships) as f:
        for line in f:
            d = json.loads(line)
            lab = d["label"]
            s, t = d["source_identifier"], d["target_identifier"]
            if lab == "supports" and s in lcs and t in id_to_std:
                sc = id_to_std[t]
                if sc in standards:
                    desc = clean_text(lcs[s].get("description", ""))
                    if not desc:
                        continue
                    seen = lc_seen[sc]
                    key = lc_key(desc)
                    # Keep the shorter wording when two versions differ only by a parenthetical.
                    if key not in seen or len(desc) < len(seen[key]):
                        seen[key] = desc
                    attributions.add(d["properties"].get("attributionStatement", ""))
            elif lab == "buildsTowards" and s in id_to_std and t in id_to_std:
                a, b = id_to_std[s], id_to_std[t]
                if a != b and a in standards and b in standards:
                    standards[b]["pre"].add(a)
                    standards[a]["next"].add(b)
                    attributions.add(d["properties"].get("attributionStatement", ""))
            elif lab == "hasChild" and s in domain_ids and t in cluster_ids:
                domains[domain_of(cluster_ids[t])] = domain_ids[s]
            elif lab == "relatesTo" and s in id_to_std and t in id_to_std:
                a, b = id_to_std[s], id_to_std[t]
                if a != b and a in standards and b in standards:
                    standards[a]["rel"].add(b)
                    standards[b]["rel"].add(a)
            elif lab == "hasEducationalAlignment" and t in id_to_std:
                if s in lessons:
                    lesson_to_std[s].add(id_to_std[t])
                elif s in assessments and assessments[s].get("curriculumLabel") == "Cool-down":
                    cooldown_to_std[s].add(id_to_std[t])
                elif s in groupings and groupings[s].get("curriculumLabel") == "Section":
                    section_to_std[s].add(id_to_std[t])
            elif lab == "hasPart" and (t in lessons or t in assessments or t in groupings) and (s in lessons or s in groupings):
                parent[t] = s

    def where(node_id):
        """Walk up to the containing lesson, section and unit."""
        out, seen, nid = {}, set(), parent.get(node_id)
        while nid and nid not in seen:
            seen.add(nid)
            if nid in lessons:
                out.setdefault("lesson", lessons[nid])
            elif nid in groupings:
                kind = groupings[nid].get("curriculumLabel")
                if kind in ("Section", "Unit"):
                    out.setdefault(kind.lower(), groupings[nid])
            nid = parent.get(nid)
        return out

    def unit_label(w):
        u = w.get("unit")
        if not u:
            return ""
        return f"{u.get('ordinalName', '')}: {u.get('name', '')}".strip(": ")

    def grade_of(p):
        return str(p.get("courseCode", "")).split(":")[-1].upper()

    for lid, codes in lesson_to_std.items():
        p = lessons[lid]
        attributions.add(p.get("attributionStatement", ""))
        grade = p.get("courseCode", "").split(":")[-1].upper()
        entry = {
            "n": p.get("name", ""),
            "o": p.get("ordinalName", ""),
            "g": grade,
            "u": unit_label(where(lid)),
        }
        for sc in codes:
            if sc in standards:
                standards[sc]["les"].append(entry)

    # Cool-downs: the short end-of-lesson check, aligned to standards directly.
    for aid, codes in cooldown_to_std.items():
        p = assessments[aid]
        w = where(aid)
        lesson = w.get("lesson", {})
        entry = {
            "n": p.get("name", "").strip(),
            "l": f"{lesson.get('ordinalName', '')}: {lesson.get('name', '')}".strip(": "),
            "u": unit_label(w),
            "g": grade_of(p),
        }
        for sc in codes:
            if sc in standards:
                standards[sc].setdefault("cd", []).append(entry)

    # Section checkpoints: aligned through their section's standards.
    for aid, p in assessments.items():
        label = p.get("curriculumLabel") or p.get("name") or ""
        if "Checkpoint" not in label:
            continue
        sec = parent.get(aid)
        if sec not in section_to_std:
            continue
        w = where(aid)
        entry = {"n": label, "s": groupings[sec].get("name", ""), "u": unit_label(w), "g": grade_of(p)}
        for sc in section_to_std[sec]:
            if sc in standards:
                standards[sc].setdefault("ck", []).append(entry)

    for sc, st in standards.items():
        st["lc"] = list(lc_seen[sc].values())
        # Prefer lessons from the standard's own grade, then keep a few.
        st["les"].sort(key=lambda e: (e["g"] != st["g"], e["g"], e["u"], e["o"]))
        st["les"] = st["les"][:MAX_LESSONS]
        for key, cap in (("cd", MAX_COOLDOWNS), ("ck", MAX_CHECKPOINTS)):
            items = st.get(key, [])
            uniq = list({json.dumps(e, sort_keys=True): e for e in items}.values())
            uniq.sort(key=lambda e: (e["g"] != st["g"], e["g"], e["u"], e.get("l", e.get("s", ""))))
            if uniq:
                st[key] = uniq[:cap]
            else:
                st.pop(key, None)
        for k in ("pre", "next", "rel"):
            st[k] = sorted(st[k])
        if st["cl"] in clusters:
            clusters[st["cl"]]["s"].append(sc)

    def sort_key(code):
        parts = code.split(".")
        g = GRADES.index(parts[0]) if parts[0] in GRADES else 99
        return [g] + [int(x) if x.isdigit() else x for x in parts[1:]]

    for c in clusters.values():
        c["s"].sort(key=sort_key)
    clusters = {k: clusters[k] for k in sorted(clusters, key=sort_key) if clusters[k]["s"]}

    out = {
        "meta": {
            "source": "Learning Commons Knowledge Graph",
            "version": args.version,
            "framework": "Common Core State Standards for Math",
            "attribution": sorted(a for a in attributions if a),
        },
        "domains": domains,
        "clusters": clusters,
        "standards": {k: standards[k] for k in sorted(standards, key=sort_key)},
        "alt": alt_codes,
    }
    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    with open(args.out, "w") as f:
        f.write("// Generated by app/tools/build_kg_snapshot.py from the Learning Commons Knowledge Graph.\n")
        f.write("// Do not edit by hand; rebuild instead.\n")
        f.write("window.KG_DATA = ")
        json.dump(out, f, separators=(",", ":"), ensure_ascii=False)
        f.write(";\n")

    n_lc = sum(len(s["lc"]) for s in standards.values())
    n_pre = sum(len(s["pre"]) for s in standards.values())
    n_les = sum(1 for s in standards.values() if s["les"])
    n_cd = sum(1 for s in standards.values() if s.get("cd"))
    n_ck = sum(1 for s in standards.values() if s.get("ck"))
    print(f"standards_with_cooldowns={n_cd} standards_with_checkpoints={n_ck}")
    print(f"clusters={len(clusters)} standards={len(standards)} learning_components={n_lc} "
          f"prereq_links={n_pre} standards_with_lessons={n_les}")
    print(f"wrote {os.path.abspath(args.out)} ({os.path.getsize(args.out)//1024} KB)")


if __name__ == "__main__":
    main()
