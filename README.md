---
title: Urban Causal AI POC
emoji: "🏙️"
colorFrom: teal
colorTo: yellow
sdk: gradio
sdk_version: 6.26.0
app_file: app.py
pinned: false
---

# Urban Causal AI — Public Portfolio Edition

A privacy-safe portfolio demonstration that converts urban issue text or an optional image into validated causal JSON, retrieves similar synthetic patterns and links to an interactive causal-network dashboard.

## Public content

- Gradio application and dashboard source code
- Five-field schema validation and transparent quality checks
- Causal network, divergence/convergence views, point map and monthly profile
- Reproducible synthetic data generator
- 9,600 synthetic cases, including 8,000 synthetic explicit relations

## Explicitly excluded

- Research-group datasets and real aggregate results
- Original report text, images and identifiers
- Real locations, dates and record-level predictions
- Credentials, API keys and local filesystem paths

Every included data file is generated from scratch by `scripts/generate_synthetic_demo_data.py`. The generator does not read the private research workspace.

## Run the AI demo

1. Install dependencies: `python -m pip install -r requirements.txt`
2. Set `GEMINI_API_KEY` as an environment secret.
3. Run `python app.py` and open `http://127.0.0.1:7860`.

Without an API key, a clearly labelled local fallback keeps the interface testable.

On Windows, after installing the dependencies, double-click `Open_Public_Portfolio.cmd` to start both the AI demo and dashboard locally.

## Run or publish the dashboard

Serve the `docs` folder through a local HTTP server. For GitHub Pages, select the main branch and `/docs` folder.

- Planned dashboard URL: `https://wangxinyao9127-hub.github.io/urban-causal-ai-portfolio/`
- Planned AI demo URL: `https://huggingface.co/spaces/YOUR-HF-USERNAME/urban-causal-ai`

This prototype supports analyst review; it does not establish real-world causal effects or operational priority. See [MODEL_CARD.md](MODEL_CARD.md) and [PRIVACY.md](PRIVACY.md).

Before publishing, run `python scripts/audit_public_release.py` and follow [DEPLOYMENT_CHECKLIST.md](DEPLOYMENT_CHECKLIST.md).
