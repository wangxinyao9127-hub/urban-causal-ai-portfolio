# Model and Evidence Card

## Intended use

This prototype helps a human analyst turn an urban issue report into a consistent five-field causal record and retrieve related synthetic patterns. It is designed for portfolio demonstration, exploratory triage and human-reviewed analysis.

It is not a system for autonomous dispatch, legal conclusions, safety-critical decisions or proof of real-world causality.

## Output schema

| Field | Meaning |
|---|---|
| `subject` | Reported source issue or condition |
| `subject_adj` | Optional modifier of the source |
| `verb` | Causal or action relation |
| `target_subject` | Affected object or outcome |
| `target_state_adj` | Resulting state |

## Public evaluation boundary

This public edition does not disclose evaluation results derived from restricted research data. The interface demonstrates the evaluation design: JSON parse success, field-level schema checks, specificity, input-evidence warnings, latency and retrieval matches. Production readiness would require a separately governed labelled test set and reported field-level accuracy, exact-match accuracy and calibration.

## Quality signal

The 0–100 value shown in the interface is a transparent output-quality heuristic based on schema completeness, vocabulary compatibility, specificity and input evidence. It is not a calibrated model probability.

## Known failure modes

- Ambiguous pronouns or missing affected objects
- Multiple causal relations compressed into one sentence
- Images without enough visual or textual context
- Labels outside the project's controlled vocabulary
- Correct JSON structure with semantically incorrect fields

## Human-in-the-loop controls

- Each field is checked separately.
- Generic or incompatible labels are flagged.
- Similar synthetic chains provide context, not confirmation.
- A local fallback is clearly labelled and must not be described as model inference.
- Inputs are not appended to the synthetic demo dataset by the application.

## Data and privacy boundary

The bundled explorer data is fully synthetic and reproducible from the included generator. Research data, raw report text, original images, personal information, local paths and API keys are excluded.
