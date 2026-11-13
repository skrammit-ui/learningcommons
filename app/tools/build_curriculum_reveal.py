#!/usr/bin/env python3
"""
Build app/data/curriculum-reveal.js from McGraw Hill's "Reveal Math K-8 Scope & Sequence Alignment Guide" PDF.

The guide lists topics with their Common Core standards, then skills with the Reveal Math unit(s) that teach
each skill in each grade (columns K-8). This reads the unit numbers by their position under the grade columns
and records, for each Common Core cluster, the Reveal units by grade and the skills listed with them.

Usage:
    python3 app/tools/build_curriculum_reveal.py --pdf alignment-guide.pdf

Requires pdfplumber.
"""

import argparse
import json
import os
import re
from collections import defaultdict

import pdfplumber

GRADES = ["K", "1", "2", "3", "4", "5", "6", "7", "8"]
CODE_RE = re.compile(r"^((K|[1-8])\.[A-Z]{1,4}\.[A-Z])\.\d+(\.[a-z])?,?$")
UNIT_RE = re.compile(r"^\d{1,2},?$")
DOMAINS = {
    "Counting and Cardinality", "Number and Operations in Base Ten", "Number and Operations—Fractions",
    "Ratios and Proportional Relationships", "The Number System", "Operations and Algebraic Thinking",
    "Expressions and Equations", "Functions", "Geometry", "Measurement and Data", "Statistics and Probability",
}
TEXT_MAX_X = 255  # skill text sits left of the K column


def lines_of(words, tol=3):
    lines = []
    for w in sorted(words, key=lambda w: (w["top"], w["x0"])):
        for ln in lines:
            if abs(ln["top"] - w["top"]) <= tol:
                ln["words"].append(w)
                break
        else:
            lines.append({"top": w["top"], "words": [w]})
    for ln in lines:
        ln["words"].sort(key=lambda w: w["x0"])
    return sorted(lines, key=lambda ln: ln["top"])


def parse(pdf_path):
    """Return a list of topics: {"codes": [...standards], "skills": [{"text", "units": {grade: {unit}}}]}."""
    topics = []
    with pdfplumber.open(pdf_path) as pdf:
        for page in pdf.pages:
            words = page.extract_words()
            header = {w["text"]: (w["x0"] + w["x1"]) / 2 for w in words if w["text"] in GRADES and w["top"] < 120}
            if len(header) < len(GRADES):
                continue  # not a scope-and-sequence grid page
            centers = [(g, header[g]) for g in GRADES]
            topic, skill = None, None
            for ln in lines_of([w for w in words if 100 < w["top"] < page.height - 50]):
                codes = [w["text"].rstrip(",") for w in ln["words"] if CODE_RE.match(w["text"])]
                units = [w for w in ln["words"] if w["x0"] >= TEXT_MAX_X and UNIT_RE.match(w["text"])]
                text = " ".join(w["text"] for w in ln["words"]
                                if w["x0"] < TEXT_MAX_X and not CODE_RE.match(w["text"])).strip()
                if "revealmath.com" in text or "Alignment Guide" in text or text in DOMAINS:
                    continue
                if codes:
                    if topic and not text and not topic["skills"]:
                        topic["codes"] += codes  # list of codes wrapped onto a second line
                    else:
                        topic = {"title": text, "codes": codes, "skills": []}
                        topics.append(topic)
                        skill = None
                    continue
                if topic is None:
                    continue
                # A new skill starts with text when there's no open skill, or the open one is finished.
                if text and (skill is None or skill["text"].endswith(".")):
                    skill = {"text": text, "units": defaultdict(set)}
                    topic["skills"].append(skill)
                elif text:
                    skill["text"] += " " + text
                for w in units:
                    if skill is None:
                        continue
                    x = (w["x0"] + w["x1"]) / 2
                    grade = min(centers, key=lambda gc: abs(gc[1] - x))[0]
                    skill["units"][grade].add(int(w["text"].rstrip(",")))
    return topics


def load_kg(path):
    text = open(path).read()
    return json.loads(text[text.index("{"):text.rindex("}") + 1])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--pdf", required=True)
    ap.add_argument("--kg", default=os.path.join(os.path.dirname(__file__), "..", "data", "kg-math-k8.js"))
    ap.add_argument("--out", default=os.path.join(os.path.dirname(__file__), "..", "data", "curriculum-reveal.js"))
    args = ap.parse_args()

    topics = parse(args.pdf)
    kg = load_kg(args.kg)
    fixed = {}

    def real_cluster(code):
        """Cluster for a standard code, correcting codes the guide mislabels (e.g. 6.SP.A.4 is really 6.SP.B.4)."""
        std = ".".join(code.split(".")[:4])
        if std in kg["standards"]:
            return kg["standards"][std]["cl"]
        g, dom, _, num = std.split(".")[:4]
        real = kg["alt"].get(f"{g}.{dom}.{num}")
        if real:
            fixed[code] = real
            return kg["standards"][real]["cl"]
        return None

    clusters = defaultdict(lambda: {"u": defaultdict(set), "sk": []})
    for t in topics:
        by_grade = defaultdict(set)  # grade -> clusters in this topic's standards
        for code in t["codes"]:
            cl = real_cluster(code)
            if cl:
                by_grade[cl.split(".")[0]].add(cl)
        for sk in t["skills"]:
            for grade, units in sk["units"].items():
                for cl in by_grade.get(grade, ()):
                    clusters[cl]["u"][grade] |= units
                    clusters[cl]["sk"].append({"t": sk["text"], "u": sorted(units)})

    out = {}
    for cl in sorted(clusters):
        c = clusters[cl]
        grade = cl.split(".")[0]
        units = sorted(c["u"].get(grade, set()))
        if not units:
            continue
        seen, skills = set(), []
        for s in c["sk"]:
            if s["t"] not in seen:
                seen.add(s["t"])
                skills.append(s)
        out[cl] = {"u": units, "sk": skills}

    data = {
        "id": "reveal",
        "name": "Reveal Math (McGraw Hill)",
        "short": "Reveal",
        "source": "Reveal Math K–8 Scope & Sequence Alignment Guide (McGraw Hill, 2025)",
        "clusters": out,
        "notInGuide": sorted(c for c in kg["clusters"] if c not in out),
        "corrected": fixed,
    }
    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    with open(args.out, "w") as f:
        f.write("// Generated by app/tools/build_curriculum_reveal.py from the Reveal Math alignment guide.\n")
        f.write("window.CURRICULA = window.CURRICULA || {};\n")
        f.write("window.CURRICULA.reveal = ")
        json.dump(data, f, ensure_ascii=False, separators=(",", ":"))
        f.write(";\n")
    n_sk = sum(len(t["skills"]) for t in topics)
    print(f"topics={len(topics)} skills={n_sk} clusters_mapped={len(out)} of {len(kg['clusters'])}")
    print("corrected codes:", fixed)
    print("not in guide:", data["notInGuide"])
    print(f"wrote {os.path.abspath(args.out)} ({os.path.getsize(args.out) // 1024} KB)")


if __name__ == "__main__":
    main()
