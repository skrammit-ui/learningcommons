#!/usr/bin/env python3
"""Generate a fictional Grade 6 class in the PRoPL interim export layout, with realistic score patterns.

Cluster scores are whole-question percents (e.g. 2 questions -> 0/50/100%), like a real interim.
"""

import csv
import os
import random

random.seed(11)

# Cluster -> number of questions on the interim (estimated from a real PRoPL export).
ITEMS = {"6.NS.A": 2, "6.NS.B": 2, "6.NS.C": 3, "6.RP.A": 4, "6.EE.A": 2, "6.EE.B": 3,
         "6.EE.C": 2, "6.G.A": 4, "6.SP.A": 2, "6.SP.B": 3}
CLUSTERS = list(ITEMS)

# Probability of answering a question in each cluster correctly, by learner profile.
PROFILES = {
    "strong": (dict.fromkeys(CLUSTERS, .9), 6),
    "ratios_expressions": ({**dict.fromkeys(CLUSTERS, .75), "6.RP.A": .3, "6.EE.A": .35, "6.EE.B": .3, "6.EE.C": .4}, 7),
    "number_system": ({**dict.fromkeys(CLUSTERS, .75), "6.NS.A": .25, "6.NS.B": .4, "6.NS.C": .3, "6.RP.A": .5}, 6),
    "broad_support": ({**dict.fromkeys(CLUSTERS, .3), "6.G.A": .5, "6.SP.A": .5}, 5),
}
FIRST = ["Alma", "Bruno", "Cleo", "Dev", "Esme", "Finn", "Gia", "Hugo", "Iris", "Jude", "Kira", "Luca",
         "Mina", "Nico", "Opal", "Pax", "Quinn", "Rhea", "Silas", "Tess", "Uma", "Vik", "Wren", "Xavi"]
LAST = ["Alvarez", "Brooks", "Chen", "Diaz", "Evans", "Fofana", "Garcia", "Haddad", "Ito", "Jensen", "Khan",
        "Lopez", "Mensah", "Nguyen", "Okafor", "Patel", "Reyes", "Singh", "Tran", "Ueda", "Vance", "Walsh",
        "Yilmaz", "Zhou"]


def main():
    out = os.path.join(os.path.dirname(__file__), "..", "sample-data", "propl-grade6-interim-sample.csv")
    first, last = FIRST[:], LAST[:]
    random.shuffle(first)
    random.shuffle(last)
    rows = []
    sid = 150000200
    for profile, (p, n) in PROFILES.items():
        for _ in range(n):
            ability = random.gauss(0, .08)
            row = {"Student": f"{last.pop()}, {first.pop()}", "Identifier": str(sid := sid + 1)}
            right = total = 0
            for c in CLUSTERS:
                k = ITEMS[c]
                got = sum(random.random() < min(.97, max(.03, p[c] + ability)) for _ in range(k))
                right += got
                total += k
                row[c] = f"{round(100 * got / k)}%"
            frac = right / total
            scale = int(500 + frac * 300)
            row["Scale Score"] = str(scale)
            row["Performance Level"] = f"Level {1 + min(4, int(frac * 5))}"
            row["National Norm"] = str(max(1, min(99, round(frac * 100 + random.gauss(0, 5)))))
            rows.append(row)
    random.shuffle(rows)
    rows[5]["6.SP.B"] = ""  # a skipped section
    fields = ["Student", "Identifier", "Scale Score", "Performance Level"] + CLUSTERS + ["National Norm"]
    with open(out, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=fields, quoting=csv.QUOTE_ALL)
        w.writeheader()
        w.writerows(rows)
    print(f"wrote {os.path.abspath(out)} ({len(rows)} students)")


if __name__ == "__main__":
    main()
