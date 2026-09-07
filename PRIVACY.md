# Privacy and Data Release Boundary

Release classification: **public-safe synthetic demonstration**.

Included files contain only source code, synthetic categories, synthetic counts, fictional coordinates, synthetic months and synthetic causal relations.

The public package excludes all research-group datasets, original reports and images, report identifiers, real coordinates and dates, record-level predictions, real aggregate findings, credentials and API keys.

The public data files are produced only by `scripts/generate_synthetic_demo_data.py`. That generator uses a fictional grid city and a fixed random seed; it does not import, sample, transform or aggregate the private research dataset.

When Gemini mode is enabled, visitor-entered text or images are sent to the configured Gemini API. Visitors must use synthetic examples and must not submit confidential, personal or research-restricted content. The application does not append inputs to its demo dataset.
