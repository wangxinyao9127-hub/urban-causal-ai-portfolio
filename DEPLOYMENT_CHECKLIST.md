# Safe deployment checklist

## Before every public release

1. Run `python scripts/generate_synthetic_demo_data.py`.
2. Run `python scripts/audit_public_release.py` and require `PASSED`.
3. Confirm that `.env` is absent and only `.env.example` is present.
4. Publish this folder only. Never copy files from the private research dashboards into it.

## GitHub Pages dashboard

1. Create a public repository named `urban-causal-ai-portfolio`.
2. Upload this package or push the repository.
3. In **Settings → Pages**, choose **Deploy from a branch**, `main`, `/docs`.
4. The expected dashboard URL is `https://wangxinyao9127-hub.github.io/urban-causal-ai-portfolio/`.

## Hugging Face Space AI demo

1. Create a Gradio Space and upload `app.py`, `requirements.txt`, `README.md`, `MODEL_CARD.md`, `PRIVACY.md`, and the `data` folder.
2. Add `GEMINI_API_KEY` under the Space's protected **Secrets** settings. Never paste it into a source file.
3. Add `DASHBOARD_URL` as the public GitHub Pages address.
4. Test with invented content only. The app warns users not to submit confidential reports or identifiable images.

## Public claim boundary

Say that the public demo uses synthetic data and demonstrates the product workflow. Do not describe its synthetic counts as research findings or real-world model accuracy.

