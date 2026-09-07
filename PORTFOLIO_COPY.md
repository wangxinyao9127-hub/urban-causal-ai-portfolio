# Portfolio Copy and Demo Script

## Project title

Urban Causal AI — Multimodal Issue-to-Insight Prototype

## One-line description

An AI-assisted prototype that converts urban issue text or images into validated five-field causal JSON and connects each result to aggregate spatiotemporal causal patterns.

## Resume bullets — English

- Built a Gradio-based multimodal AI prototype that transforms urban issue reports into a controlled five-field causal schema, with field-level validation, transparent quality flags and bad-case disclosure.
- Connected structured outputs to a synthetic causal-pattern retrieval layer and an interactive network-and-map dashboard while keeping restricted research data outside the public repository.
- Designed a human-in-the-loop evaluation layer with field-level checks, latency, bad-case disclosure and explicit boundaries between output quality and calibrated model confidence.

## 简历项目描述 — 中文

- 搭建城市问题多模态 AI 原型，将文本/图片转化为统一的五字段因果 JSON，并实现字段级 Schema 校验、输出质量提示与 Bad Case 展示。
- 将结构化输出连接至合成因果模式检索层，并联动因果网络、虚构城市点位和时间规律 Dashboard；受限课题组数据不进入公开仓库。
- 设计人机协同评估与风险边界，展示字段级校验、延迟、Bad Case，并明确区分输出质量评分与校准后的模型置信度。

## 30-second interview pitch

The problem was that free-form urban issue reports are difficult to compare and explore at scale. I built a multimodal AI workflow that converts a report into a five-field causal record, validates every field and retrieves similar patterns from a synthetic demonstration set. The key product decision was not to hide model uncertainty: the demo shows quality checks, known bad cases and clear human-review boundaries. Restricted research data are deliberately excluded from the public product.

## Two-minute live demo

1. Enter a short infrastructure report, for example: “The roadside drain is blocked, causing water to accumulate and pedestrians to slip.”
2. Run the analysis and show the five-field JSON.
3. Point to the field-level checks and explain that the score is an output-quality signal, not calibrated model confidence.
4. Show the nearest synthetic causal patterns and explain how the same retrieval architecture can connect to governed enterprise data.
5. Open the dashboard and demonstrate cause-first/impact-first network exploration, point locations and temporal profiles.
6. End with the boundary: the tool supports analyst triage and exploration; it does not prove causality or make autonomous public-service decisions.

## Recommended portfolio card

**Problem:** Urban complaints are unstructured and high-volume, which makes recurring infrastructure mechanisms hard to detect.  
**Solution:** Multimodal structured extraction + schema checks + aggregate-chain retrieval + interactive causal dashboard.  
**Evidence:** Reproducible 8,000-relation synthetic demo; live schema checks, latency and bad-case disclosure.  
**Boundary:** Human review required; no causal-effect claim; restricted research data are not distributed.  
**Value:** Faster issue triage, comparable records and clearer communication between analysts, product teams and operational stakeholders.
