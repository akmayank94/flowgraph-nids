"""Build dashboard data files from a Phase-6 zip folder (reports/ + dashboard/) and the Phase-5 reports.
usage: python build_data.py <phase6_root_or_test_root> <p5_reports_dir> <out_data_dir>"""
import sys, json, shutil, glob, os
import pandas as pd

p6, p5r, out = sys.argv[1], sys.argv[2], sys.argv[3]
os.makedirs(out, exist_ok=True)
L = {"unsw_nb15": "UNSW-NB15", "cse_cic_ids2018": "CSE-CIC-IDS2018", "ton_iot": "ToN-IoT"}
rec = lambda df: json.loads(df.to_json(orient="records"))

# Phase 1-5 summary (real Kaggle results)
d = pd.read_csv(f"{p5r}/D_results.csv")
base = d[(d.threshold_policy == "fpr0.01") & (d.train_set == d.test_set) & (~d.model.isin(["LightGBM-P4", "LightGBM+TTL"]))]
p1 = base.groupby(["test_set", "model"])[["PR_AUC", "ROC_AUC", "recall_DR", "precision", "F1", "FPR_FAR", "flows_per_sec"]].mean().reset_index()
p1["seeds"] = base.groupby(["test_set", "model"]).size().values
p1["network"] = p1.test_set.map(L)
f = pd.read_csv(f"{p5r}/F_results.csv")
fu = f[(f.threshold_policy == "fpr0.01") & (f.train_set == f.test_set)][["model", "test_set", "PR_AUC", "recall_DR", "precision", "FPR_FAR"]]
fu["network"] = fu.test_set.map(L)
f4 = pd.read_csv(f"{p5r}/F4_p3_cross_dataset.csv"); f4 = f4[f4.threshold_policy == "fpr0.01"]
f4 = f4[["model", "train_set", "test_set", "PR_AUC", "ROC_AUC", "recall_DR", "precision", "FPR_FAR"]].assign(train=lambda x: x.train_set.map(L), test=lambda x: x.test_set.map(L))
f5 = pd.read_csv(f"{p5r}/F5_p4_results.csv"); f5 = f5[f5.threshold_policy == "fpr0.01"][["model", "test_set", "PR_AUC", "recall_DR", "precision", "FPR_FAR"]]
f5["network"] = f5.test_set.map(L)
f5c = pd.read_csv(f"{p5r}/F5_p4_per_class.csv"); f5c = f5c[f5c.threshold_policy == "fpr0.01"][["model", "test_set", "attack", "seen_in_training", "test_flows", "recall"]]
S = {"p1": rec(p1), "fusion_split": rec(fu), "alerting_p5": rec(pd.read_csv(f"{p5r}/F2_alerting_test.csv")),
     "p2": rec(pd.read_csv(f"{p5r}/F3_p2_leave_one_family_out.csv")), "p3": rec(f4), "p4": rec(f5), "p4_class": rec(f5c),
     "edge_attr": rec(pd.read_csv(f"{p5r}/E5_edge_type_attribution.csv")), "rates": rec(pd.read_csv(f"{p5r}/A2_flow_rates.csv"))}
json.dump(S, open(f"{out}/summary.json", "w"), separators=(",", ":"))

# Phase 6 engine results
rd = lambda n: pd.read_csv(glob.glob(f"{p6}/**/{n}.csv", recursive=True)[0])
P6 = {"policy": rec(rd("G1_alert_policy")), "proofs": rec(rd("G2_stream_equivalence").astype(str)),
      "throughput": rec(rd("G2_stream_throughput")), "latency": rec(rd("G3_latency"))}
json.dump(P6, open(f"{out}/phase6.json", "w"), separators=(",", ":"))
dash = os.path.dirname(glob.glob(f"{p6}/**/manifest.json", recursive=True)[0])
for fn in glob.glob(f"{dash}/*.json"): shutil.copy(fn, out)
print("data written to", out, sorted(os.listdir(out)))
