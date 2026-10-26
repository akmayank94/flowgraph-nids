# Flowgraph NIDS

Network intrusion detection on a **causal temporal graph of NetFlow records**, evaluated without leakage and run as a streaming engine. This is version 1 of an M.Sc. Computer Science final-year project at the University of Delhi, supervised by Ms. Anjali Thukral.

**Live dashboard:** https://flowgraph-nids.vercel.app/

The dashboard replays the recorded decisions of the streaming engine on held-out test flows from three public NetFlow v3 datasets. It is a replay of real NetFlow records, not live packet capture.

---

## What the system does

1. **Read** each NetFlow v3 record (53 nProbe features) in the order flows finish.
2. **Link to the past.** Connect the flow to at most 9 earlier flows within 120 s:
   - the previous flow of the same conversation;
   - the last 5 flows from the same source;
   - the last 3 flows to the same destination.

   Links never point to later flows, so the method can run live.
3. **Describe the context.** Compute 13 context features from those neighbours, such as how busy the hosts are, how many distinct targets and ports the source has touched, and the time since the source was last seen.
4. **Score with TF-GNN.** A two-layer temporal flow GNN in pure PyTorch, with separate weights per link type. Each flow's first-layer embedding is cached when the flow arrives, so scoring a new flow needs no graph rebuild.
5. **Get a second opinion.** LightGBM scores the same flow from its own features only.
6. **Alert per host.** Flagged flows raise their source host's risk, which fades with time. One alert is raised when the risk reaches the alert level, instead of one alert per flow.

## Data

| Dataset | Flows after exact de-duplication | Attack classes | P1 test flows |
|---|---|---|---|
| NF-UNSW-NB15-v3 | 2,350,609 | 9 | 348,887 |
| NF-CSE-CIC-IDS2018-v3 | 19,487,055 | 14 | 2,844,963 |
| NF-ToN-IoT-v3 | 25,704,123 | 9 | 3,625,185 |

These are the NetFlow v3 datasets published by the University of Queensland. Preprocessing:
- Features are transformed with log1p, robust scaling fitted on training data only, and clipping, giving 133 features.
- Source port, DNS query ID and ICMP type are dropped. TTL is used only in an ablation.

## Evaluation protocols

- **P1, later traffic on the same network (main protocol).** Each attack episode is split 70/15/15 by time, with a purge gap of min(60 s, 2% of the episode).
- **P2, an unseen attack family.** The model is retrained without one of six shared families, then tested on that family.
- **P3, a different network.** Train on one dataset, test on the other two.
- **P4, a strict time split.** One global cut in time, so later attack types are unseen.

Every threshold is chosen on validation at 1% FPR, separately for each network, and applied unchanged to test traffic at its real benign/attack ratio.

## Results (version 1)

**P1, per-network models:**

| Model | CSE PR-AUC | CSE recall | CSE FPR | ToN PR-AUC | ToN recall | ToN FPR |
|---|---|---|---|---|---|---|
| **TF-GNN** | **0.9833** | **0.964** | 0.93% | **0.9772** | **0.885** | **1.76%** |
| TF-GNN, no edges | 0.9781 | 0.955 | 0.90% | 0.9683 | 0.795 | 2.27% |
| LightGBM | 0.9702 | 0.949 | 1.10% | 0.9754 | 0.873 | 2.43% |
| Random Forest | 0.9691 | 0.948 | 0.99% | 0.9759 | 0.854 | 2.24% |

On UNSW-NB15 every supervised model reaches PR-AUC 1.000, because its attacks come from four attack-only hosts.

**What message passing adds:**
- +0.091 recall on ToN-IoT over the identical network without edges.
- CSE Infiltration recall rises from 0.17 (LightGBM) to 0.42 (TF-GNN).

**Alerting** (test split; settings chosen on validation):

| Network | Flagged flows | Alerts | False alerts per hour |
|---|---|---|---|
| ToN-IoT | 1,323,013 | 55 | 0.56 |
| CSE-CIC-IDS2018 | 288,952 | 280 | 2.12 |

**Streaming engine:**
- Streaming all 6.8 million test flows reproduced the offline pipeline exactly: identical neighbours, context features and alerts, with scores within 1.2e-7.
- On Kaggle CPU (4 threads) it processes 20,000–26,000 flows per second.
- Median latency is 7.8–8.4 ms per batch of 64 flows and 24–27 ms per batch of 512.

**Limits measured in version 1:**
- **Unseen attack families (P2):** recall drops to about 0 for several families once they are removed from training.
- **Other networks (P3):** ROC-AUC is 0.21–0.65, and a threshold from one network gives 0.5% to 99.99% FPR on another.
- **Time drift (P4):** the false-positive rate drifts upward, and on CSE the GNN does worse than LightGBM.

Fixing these limits is the plan for version 2.

## Repository contents

```
index.html, style.css, app.js   static dashboard (no build step)
data/                           replay scenarios and result tables (JSON)
build_data.py                   builds data/ from the Phase 6 output zip
tools/crop.py                   trims replay windows to 60 s before / 240 s after each attack start
```

**Run locally:** start any static server in the repository folder, for example `python -m http.server 8000`, then open `http://localhost:8000`.

**Rebuild the data:** start from an unzipped Phase 6 output folder:
```
python build_data.py <phase6_dir> <phase6_dir>/reports data
python tools/crop.py data data
cp <phase6_dir>/dashboard/policy.json data/
```

## Roadmap

| Version | Goal | Main work |
|---|---|---|
| v2 | Generalise | Benign-only self-supervised branch on the same graph; thresholds set from a new network's normal traffic; drift monitor; 3–5 seeds |
| v3 | Run on a real network | Live NetFlow v3 exporter, engine as a service, live dashboard, analyst feedback loop, faster neighbour loop |
| v4 | Trustworthy alerts | Evasion tests, per-alert explanations, attack-family naming |

## Main references

- Caballero Ferrero et al., *Electronics* 15, 3764 (2026). The flow-as-node temporal graph; our version is strictly past-only.
- Layeghy and Portmann, *On Generalisability of ML-based NIDS* (arXiv 2205.04112); Cantone et al., *Cross-Dataset Generalization of ML for NIDS* (arXiv 2402.10974).
- Guerra et al., *Self-Supervised Learning of Graph Representations for Network Intrusion Detection* (GraphIDS), NeurIPS 2025.
- Wang et al., *Are We There Yet? Unraveling the State-of-the-Art Graph Network Intrusion Detection Systems* (arXiv 2503.20281).
