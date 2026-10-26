"""Crop exported replay scenarios to a time window around the attack start (60 s before, 240 s after) and drop duplicates.
usage: python crop.py <in_dir> <out_dir>"""
import json, sys, os
PRE_MS, POST_MS = 60_000, 240_000
src, dst = sys.argv[1], sys.argv[2]; os.makedirs(dst, exist_ok=True)
man = json.load(open(f"{src}/manifest.json"))
for ds in man["datasets"]:
    rep = json.load(open(f"{src}/{ds['file']}")); out = []; seen = set()
    for s in rep["scenarios"]:
        c = s["cols"]; n = s["n"]
        if s["episode_id"] >= 0:
            k = s["classes"].index(s["title"])
            ia = next(i for i in range(n) if c["y"][i] == 1 and c["a"][i] == k)
            ta = c["t"][ia]; keep = [i for i in range(n) if ta - PRE_MS <= c["t"][i] <= ta + POST_MS]
        else:
            keep = list(range(n))
        if len(keep) < 50: print("  too few flows, dropped:", ds["label"], s["title"]); continue
        key = (keep[0] + s["first_row"], keep[-1] + s["first_row"])
        if key in seen: print("  duplicate window dropped:", ds["label"], s["title"]); continue
        seen.add(key); pos = {i: j for j, i in enumerate(keep)}; t0 = c["t"][keep[0]]
        nc = {}
        for col, v in c.items():
            if col == "nb": nc[col] = [[pos.get(m, -1) if m >= 0 else -1 for m in v[i]] for i in keep]
            elif col == "t": nc[col] = [v[i] - t0 for i in keep]
            else: nc[col] = [v[i] for i in keep]
        used = sorted(set(nc["s"]) | set(nc["d"])); ipm = {o: j for j, o in enumerate(used)}
        nc["s"] = [ipm[x] for x in nc["s"]]; nc["d"] = [ipm[x] for x in nc["d"]]
        acls = sorted(set(nc["a"])); am = {o: j for j, o in enumerate(acls)}; nc["a"] = [am[x] for x in nc["a"]]
        ns = dict(s, n=len(keep), first_row=s["first_row"] + keep[0], t0_ms=s["t0_ms"] + t0, ips=[s["ips"][o] for o in used],
                  classes=[s["classes"][o] for o in acls], cols=nc)
        out.append(ns)
        print(f"  {ds['label']:16s} {s['title'][:38]:38s} {len(keep):5d} flows, {nc['t'][-1]/1000:7.1f} s, attack {sum(nc['y'])}, alerts {sum(nc['al'])}")
    rep["scenarios"] = out; json.dump(rep, open(f"{dst}/{ds['file']}", "w"), separators=(",", ":"))
    ds["scenarios"] = [{"title": s["title"], "n": s["n"]} for s in out]
json.dump(man, open(f"{dst}/manifest.json", "w"), indent=1)
