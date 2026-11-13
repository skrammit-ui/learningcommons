# Student Grouping Planner

A browser app for teachers. Upload a CSV of student scores on Common Core math clusters (K–8) and it:

1. **Groups students** by their overall pattern of cluster scores, so students who struggle with the same clusters end up together.
2. **Shows what's inside each cluster** behind a group: its standards, the learning components (smaller teachable skills) for each standard, and how the cluster connects to earlier and later standards.
3. **Recommends next steps** for each group:
   - which clusters to reteach or practice, and in what order;
   - which learning components to focus on;
   - prerequisite standards from earlier grades to check;
   - aligned Illustrative Mathematics lessons;
   - for strong groups, standards to stretch toward.

Student data stays in the browser. The CSV is read locally and never uploaded.

## Use it

Open `index.html` in a browser. It works straight from disk; no server or install needed. Click **Try sample Grade 4 class** to see it with fictional data.

### CSV format

One row per student. The first column holds the student's name or ID. Every other column is a cluster code with that student's score:

```csv
Student,4.OA.A,4.NBT.B,4.NF.A,4.NF.B
Ava R.,85,90,62,48
Mateo L.,72,55,80,77
```

- Scores can be percents (0–100), decimals (0–1) or fractions (`3/5`).
- Standard-level columns (`4.NF.B.3` or `4.NF.3`) are averaged into their cluster.
- Headers may include extra text (`4.NF.B Build fractions…`).
- "Long" files work too: one row per student per cluster, with `Student`, `Cluster` (or `Standard`) and `Score` columns.
- **PRoPL interim exports** load as-is. Performance Level and Scale Score are shown next to each student. The other report columns (Quantile, RC1–RC4, National Norm) are skipped. `sample-data/propl-grade6-interim-sample.csv` is a fictional class in that layout.
- Students who scored 0% on every cluster usually didn't take or submit the test. They're set aside in a "Check these students" list instead of being grouped. A setting includes them if needed.

### How the recommendations work

- **Groups** come from k-means clustering on the students' cluster scores. A fixed random seed means the same file always gives the same groups. "Auto" picks 3–5 groups by best fit (silhouette score), or 2–4 for classes under 12 students. In simulated interim data, allowing just 2 groups mostly split "higher" from "lower" students and hid the skill patterns. Teachers can move any student to another group using the dropdown on their name.
- **Bands** are set by the thresholds in the settings: Proficient (default 80%+), Approaching (60%+) and Needs support.
- **Next steps** follow fixed rules applied to Knowledge Graph data, with no AI involved:
  - Weak clusters get reteaching (Needs support) or targeted practice (Approaching).
  - If one weak cluster builds toward another weak cluster in the Coherence Map, it's listed first.
  - Prerequisites come from the Coherence Map's "builds towards" links.
  - Learning components and IM lesson alignments come from the Knowledge Graph.

## Data

`data/kg-math-k8.js` is a snapshot of the [Learning Commons Knowledge Graph](https://docs.learningcommons.org/knowledge-graph/understanding-knowledge-graph/introduction), limited to Common Core Math K–8:

- clusters and standards;
- math learning components (Achievement Network / Learning Commons);
- Coherence Map progressions (Student Achievement Partners);
- IM 360 lesson alignments (Illustrative Mathematics).

Each data source's attribution is listed in the app footer.

To refresh it from a newer Knowledge Graph release:

```bash
curl -O https://cdn.learningcommons.org/knowledge-graph/v1.17.0/exports/nodes.jsonl
curl -O https://cdn.learningcommons.org/knowledge-graph/v1.17.0/exports/relationships.jsonl
python3 app/tools/build_kg_snapshot.py --nodes nodes.jsonl --relationships relationships.jsonl --version v1.17.0
```

To regenerate the sample class, run `python3 app/tools/make_sample_csv.py`.
