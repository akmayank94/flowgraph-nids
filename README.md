# Flowgraph NIDS dashboard (static site)

Open index.html through any static web server (it loads data/*.json with fetch).
Rebuild data: python build_data.py <phase6_unzipped> <phase6_unzipped>/reports data && python tools/crop.py data data && cp <phase6_unzipped>/dashboard/policy.json data/
