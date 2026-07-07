#!/usr/bin/env python3
# One-time seed of Malaysia raw draw history from the public deadboy18/malaysia-4d CSVs
# (Magnum 1985+, Sports Toto 1992+, Da Ma Cai 2005+) into my_draws. Idempotent (INSERT OR REPLACE
# on operator+draw_date). Lottery results are public facts. Run: python3 scraper/my/import-github-csv.py
import csv, json, sqlite3, os, urllib.request
DB = os.path.join(os.path.dirname(__file__), "..", "..", "huatlottery.db")
BASE = "https://raw.githubusercontent.com/deadboy18/malaysia-4d/HEAD/data"
z4 = lambda s: str(s).strip().zfill(4) if str(s).strip().isdigit() else None
con = sqlite3.connect(DB); con.execute("PRAGMA journal_mode=WAL")
ins = "INSERT OR REPLACE INTO my_draws (operator,draw_date,first_prize,second_prize,third_prize,special_prizes,consolation_prizes,source) VALUES (?,?,?,?,?,?,?,?)"
total = 0
for op in ["magnum", "sportstoto", "damacai"]:
    p = f"/tmp/my_csv/{op}.csv"
    if not os.path.exists(p):
        urllib.request.urlretrieve(f"{BASE}/{op}_draws.csv", p)
    with open(p) as fh:
        rd = csv.DictReader(fh); cols = rd.fieldnames
        sp = [c for c in cols if c.lower().startswith("special")]
        cn = [c for c in cols if c.lower().startswith(("consol", "con_"))]
        n = 0
        for r in rd:
            d, p1 = (r.get("date") or "").strip(), z4(r.get("prize_1"))
            if not d or not p1: continue
            con.execute(ins, (op, d, p1, z4(r.get("prize_2")), z4(r.get("prize_3")),
                              json.dumps([z4(r[c]) for c in sp if z4(r.get(c))]),
                              json.dumps([z4(r[c]) for c in cn if z4(r.get(c))]), "github:deadboy18"))
            n += 1
        total += n; print(f"{op}: {n} draws")
con.commit(); con.execute("PRAGMA wal_checkpoint(TRUNCATE)"); con.close()
print(f"TOTAL: {total}")
