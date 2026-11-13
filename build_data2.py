"""Build dashboard v2 data files from the v2 Kaggle outputs (zips unpacked in the scratchpad) + the v1 dashboard data.
usage: python build_data2.py <scratchpad_dir>"""
import json, sys, os, re, shutil, csv, glob
SP = sys.argv[1]; HERE = os.path.dirname(os.path.abspath(__file__)); OUT = f"{HERE}/data"; os.makedirs(OUT, exist_ok=True)
V1D = f"{HERE}/../dash/data"
NETS = [("unsw_nb15", "UNSW-NB15"), ("cse_cic_ids2018", "CSE-CIC-IDS2018"), ("ton_iot", "ToN-IoT")]
LBL = dict(NETS)
def rcsv(p): return list(csv.DictReader(open(p)))
def num(v):
    try: f = float(v); return int(f) if f.is_integer() and "." not in v else f
    except (ValueError, TypeError): return {"True": True, "False": False}.get(v, v)
def rows(p): return [{k: num(v) for k, v in r.items()} for r in rcsv(p)]

# 1) replay scenarios (v1, unchanged) + evidence cards (V7 step 2), trimmed to the replay rows
for d, _ in NETS:
    rep = json.load(open(f"{V1D}/replay_{d}.json")); json.dump(rep, open(f"{OUT}/replay_{d}.json", "w"), separators=(",", ":"))
    ev = json.load(open(f"{SP}/v7bout/dashboard_v2/evidence_{d}.json"))
    keep = set()
    for s in rep["scenarios"]: keep |= set(range(s["first_row"], s["first_row"] + s["n"]))
    cards = {k: v for k, v in ev["cards"].items() if int(k) in keep}
    # check: every flagged flow of every scenario has a card
    miss = 0; tot = 0
    for s in rep["scenarios"]:
        for i in range(s["n"]):
            if s["cols"]["su"][i]:
                tot += 1; miss += str(s["first_row"] + i) not in cards
    print(f"{d}: {len(cards):,} cards, flagged flows in scenarios {tot:,}, without card {miss}")
    json.dump({**ev, "cards": cards}, open(f"{OUT}/evidence_{d}.json", "w"), separators=(",", ":"))
shutil.copy(f"{V1D}/summary.json", OUT); shutil.copy(f"{V1D}/phase6.json", OUT); shutil.copy(f"{V1D}/manifest.json", OUT)

# 2) v2 results
R6 = f"{SP}/v6out/reports"
v7a = {d: json.load(open(f"{SP}/v7aout/reports/V7A_{d}.json")) for d, _ in NETS}
v7c = {d: json.load(open(f"{SP}/v7bout/reports/V7C_{d}.json")) for d, _ in NETS}
evidence_acc = {LBL[d]: {"overall": v7a[d]["accuracy_natural"], "all5": v7a[d]["accuracy_when_all5_agree"], "share_all5": v7a[d]["share_all5_agree"],
                         "fa_benign": v7a[d]["false_alarms_voted_benign"], "baseline": v7a[d]["most_frequent_class_baseline"],
                         "per_class": {r["attack"]: r["accuracy"] for r in v7a[d]["per_class"]}} for d, _ in NETS}
engine = [{"network": v7c[d]["network"], "flows": v7c[d]["flows"], "proofs": v7c[d]["proofs_pass"], "max_diff": v7c[d]["proofs"]["TF-GNN max abs score diff"],
           "fps": v7c[d]["engine_flows_per_s"], "fps_all_susp": v7c[d]["engine_flows_per_s_cards_for_all_suspicious"], "alerts": v7c[d]["alerts"],
           "false_alerts": v7c[d]["false_alerts"], "days": v7c[d]["days"], "hosts_day": v7c[d]["median_hosts_per_day"],
           "fa_hosts_day": v7c[d]["median_false_alarm_hosts_per_day"], "fa_hosts_day_max": v7c[d]["max_false_alarm_hosts_per_day"],
           "per_day": [{"day": int(x["day"]), "hosts": int(x["hosts"]), "alerts": int(x["alerts"]), "false_alerts": int(x["false_alerts"]),
                        "fa_hosts": int(x["false_alarm_hosts"])} for x in v7c[d]["per_day"]]} for d, _ in NETS]
fam = rows(f"{R6}/V5D_family_classes.csv"); seeds = rows(f"{R6}/V6C_fewshot_cse_seeds.csv")
newnet = rows(f"{R6}/V5D_new_network.csv"); runs = rows(f"{R6}/V5D_family_runs.csv"); diag = rows(f"{R6}/V5E_ton_diagnostic.csv")
tf_seeds = rows(f"{R6}/V6C_tfgnn_seeds.csv"); tf_ci = rows(f"{R6}/V6C_tfgnn_ci.csv"); tf_cls = rows(f"{R6}/V6C_tfgnn_class_ci.csv")
for r in tf_ci + tf_cls:
    for k in list(r):
        if "95CI" in k and isinstance(r[k], str): lo, hi = r[k].split("–"); r[k] = [float(lo), float(hi)]
v2 = {"evidence_accuracy": evidence_acc, "engine": engine, "fewshot_family": fam, "fewshot_seeds_cse": seeds, "fewshot_runs": runs,
      "fewshot_newnet": newnet, "ton_diag": diag, "tfgnn_seeds": tf_seeds, "tfgnn_ci": tf_ci, "tfgnn_class_ci": tf_cls,
      "v3": rows(f"{R6}/V3B_results.csv"), "v4": rows(f"{R6}/V4C_results.csv")}
json.dump(v2, open(f"{OUT}/v2.json", "w"), separators=(",", ":"))

# 3) glossary from TERMS.md
T = open(f"{HERE}/../deliver/TERMS.md").read(); terms = []; group = None
for line in T.splitlines():
    m = re.match(r"^## \d+\. (.*)", line)
    if m: group = m.group(1); continue
    if group and line.startswith("| ") and not line.startswith("| Term ") and not line.startswith("|---"):
        parts = [p.strip() for p in re.split(r"(?<!\\)\|", line)[1:-1]]
        if len(parts) == 3: terms.append({"g": group, "t": parts[0], "d": parts[1], "c": parts[2]})
json.dump(terms, open(f"{OUT}/terms.json", "w"), separators=(",", ":"))
print("terms", len(terms), "| v2.json", os.path.getsize(f"{OUT}/v2.json"), "bytes")
for f in sorted(os.listdir(OUT)): print(f"  {f:34s} {os.path.getsize(f'{OUT}/{f}')/1e6:6.2f} MB")
