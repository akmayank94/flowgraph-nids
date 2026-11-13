# Flowgraph NIDS — dashboard (version 2)
Static site, no build step. Open `index.html` through any static server (e.g. `python -m http.server`) or deploy the folder on Vercel.
- `data/replay_*.json` — recorded output of the streaming engine on held-out test flows (v1 engine, unchanged).
- `data/evidence_*.json` — evidence cards from engine v2 (V7 step 2), keyed by test-file row.
- `data/v2.json`, `data/summary.json`, `data/phase6.json` — recorded results (v2 and v1); `data/terms.json` — glossary from TERMS.md.
- `build_data2.py` rebuilds `data/` from the Kaggle output zips.
