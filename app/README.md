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

Open `index.html` in a browser. It works straight from disk; no server or install needed. Click **Try sample Grade 6 class** to see it with a fictional class in the PRoPL interim export layout.

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
- **PRoPL interim exports** load as-is. Performance Level and Scale Score are shown next to each student. National Norm percentile is shown too, including each group's range and median. The other report columns (Quantile, RC1–RC4) are skipped. `sample-data/propl-grade6-interim-sample.csv` is a fictional class in that layout.
- **PRoPL Individual Student Reports (ISR PDF)** can be dropped in on their own or together with the CSV. The app reads each student's math "Topics Covered" table and matches each topic's description to its Common Core cluster. The table gives the questions seen and percent correct per cluster. With the CSV, students are joined by ID. The app then:
  - shows "correct/seen" for every score (e.g. `1/2`);
  - pools group results (e.g. 9 of 16 questions correct) instead of averaging percents;
  - treats a cluster with no questions as not assessed, not 0%;
  - gives clusters measured by more questions more weight when forming groups;
  - flags students who appear in only one file, and any scores the two files disagree on.

  PDFs are read in the browser with the bundled [pdf.js](https://mozilla.github.io/pdf.js/) (`vendor/pdfjs`, Apache-2.0).
- Students who scored 0% on every cluster usually didn't take or submit the test. They're set aside in a "Check these students" list instead of being grouped. A setting includes them if needed.

### How the recommendations work

- **Groups** come from k-means clustering on the students' cluster scores. A fixed random seed means the same file always gives the same groups. "Auto" picks 3–5 groups by best fit (silhouette score), or 2–4 for classes under 12 students. In simulated interim data, allowing just 2 groups mostly split "higher" from "lower" students and hid the skill patterns. Teachers can move any student to another group using the dropdown on their name.
- **Bands** are set by the thresholds in the settings: Proficient (default 80%+), Approaching (60%+) and Needs support.
- **Next steps** follow fixed rules applied to Knowledge Graph data, with no AI involved:
  - Weak clusters get reteaching (Needs support) or targeted practice (Approaching).
  - If one weak cluster builds toward another weak cluster in the Coherence Map, it's listed first.
  - Prerequisites come from the Coherence Map's "builds towards" links.
  - Learning components and IM lesson alignments come from the Knowledge Graph.

### Curriculum awareness (optional)

**Settings → Curriculum awareness** switches a curriculum layer on or off. **Off** is the curriculum-neutral app. **Reveal Math (McGraw Hill)** adds:

- **Taught through Unit N:** ticks every cluster whose first Reveal unit is at or before N.
- **Unit tags** on clusters in the settings and heatmap.
- **Next steps** that name the Reveal grade, unit and skills to revisit for each priority cluster, and where Reveal teaches each earlier-grade prerequisite. IM lessons and the IM follow-up quiz stay, labelled as a free supplement.
- **Looking ahead** ordered by Reveal's unit sequence. Group cards name the upcoming unit, e.g. "6.EE.A (Unit 6)" or "7.RP.A (Grade 7 Unit 3, 4)".

`data/curriculum-reveal.js` is built from McGraw Hill's *Reveal Math K–8 Scope & Sequence Alignment Guide* by `tools/build_curriculum_reveal.py`. The script reads unit numbers by their position under the grade columns, and checks every standard code against the Knowledge Graph:
- 8 codes printed in the guide were corrected, e.g. 6.SP.A.4 → 6.SP.B.4.
- 92 of 93 K–8 clusters are mapped; 3.MD.D isn't in the guide.
- The guide lists skills by topic, so clusters that share a topic (e.g. 6.SP.A and 6.SP.B) show the same skills.

Another curriculum can be added by writing a similar `window.CURRICULA.<id>` file and adding it to the selector.

### Same data, same groups

- **Repeatable:** grouping is deterministic. Students are put in a fixed order (by ID, then name), and the same fixed set of starting points is tried each time. So the same class data always gives the same recommended groups, whatever the file names, upload order (CSV or PDF first) or row order. A browser test covers this (repeat uploads, both upload orders, shuffled rows).
- **Remembered:** settings (clusters taught, bands, cutoffs, number of groups) and students moved by hand are saved in the teacher's own browser, keyed to the class data itself. Uploading the same files again restores them, with a **Reset to the recommended groups** link.
- **Not shared:** the saved work stays on that device and browser. It isn't shared with other teachers, and clearing the browser's site data removes it.

### Follow-up quiz

Each group card ends with a **follow-up quiz** for rechecking the group's priority clusters before the next interim. It's built from Illustrative Mathematics v.360 items listed in the Knowledge Graph:
- for each priority cluster, up to 2 **Cool-downs** (the short end-of-lesson check), spread across the cluster's standards;
- the **Section Checkpoint** whose section covers the most of the cluster's standards.

Each item is located by grade, unit, lesson or section. Teachers open the items free on [AccessIM](https://accessim.org/). The Knowledge Graph holds the item titles and alignments; the item content is gated there. **Copy quiz list** copies the plan as plain text.

Released Smarter Balanced or PARCC/New Meridian items aren't included. Their terms allow classroom use, but not copying the items into another product without permission.

### Looking ahead (readiness forecast)

The **Looking ahead** tab uses the Coherence Map's "builds towards" links between standards to find clusters that build on the taught clusters in the data. Those are clusters in this grade not yet taught, and clusters in the next grade. It does not predict scores.

- **Students:** each student gets a readiness level for each upcoming cluster: **On track**, **Watch** or **At risk**, using the same cutoffs as the bands. It's a weighted average of their scores on the clusters that feed into that cluster. Feeders with more standard-to-standard links count more, and with the ISR, feeders with more questions count more too.
- **Groups:** each group card gets a "Looking ahead" line naming the upcoming clusters the group is at risk for.
- **Forecast check:** where an "upcoming" cluster was itself taught and assessed, the tab compares the forecast with the actual result, so teachers can see how well it holds up in their own class.
- **Earlier-grade links** that aren't in the data are listed but not used, e.g. 6.G.A builds on 4.MD.A, 5.G.A, 5.MD.C and 5.NF.B.

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

To regenerate the sample class, run `python3 app/tools/make_propl_sample.py`.
