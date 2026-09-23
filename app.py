"""Interactive AI POC for extracting causal chains from urban issue reports."""

from __future__ import annotations

import base64
import html
import io
import json
import os
import re
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

import gradio as gr
from PIL import Image
from dotenv import load_dotenv
from openai import OpenAI

load_dotenv()


BASE_DIR = Path(__file__).resolve().parent
DATA_PATH = BASE_DIR / "data" / "explorer_data.json"
MODEL = os.getenv("GEMINI_MODEL", "gemini-2.5-flash-lite")
DASHBOARD_URL = os.getenv("DASHBOARD_URL", "https://wangxinyao9127-hub.github.io/urban-causal-ai-portfolio/")
REQUIRED_KEYS = ["subject", "subject_adj", "verb", "target_subject", "target_state_adj"]
REQUIRED_NON_EMPTY = ["subject", "verb", "target_subject", "target_state_adj"]
GENERIC_VALUES = {"unknown", "unknown source", "other", "other or unknown", "issue", "problem", "thing"}
BANNED_VERBS = {"is", "are", "has", "have", "needs", "requires", "contains", "shows"}


def load_chain_index() -> tuple[dict[str, list[str]], list[dict[str, Any]]]:
    payload = json.loads(DATA_PATH.read_text(encoding="utf-8"))
    dictionaries = payload["dictionaries"]
    rows = []
    for subject_i, verb_i, target_i, state_i, count in payload["chains"]:
        parts = [
            dictionaries["subjects"][subject_i],
            dictionaries["verbs"][verb_i],
            dictionaries["targets"][target_i],
            dictionaries["states"][state_i],
        ]
        rows.append({"parts": parts, "count": int(count)})
    rows.sort(key=lambda row: row["count"], reverse=True)
    return dictionaries, rows


DICTIONARIES, CHAINS = load_chain_index()
VOCAB = {
    "subject": set(DICTIONARIES["subjects"]),
    "verb": set(DICTIONARIES["verbs"]),
    "target_subject": set(DICTIONARIES["targets"]),
    "target_state_adj": set(DICTIONARIES["states"]),
}


def normalise(value: Any, max_length: int = 90) -> str:
    return " ".join(str(value or "").replace("\r", " ").replace("\n", " ").split())[:max_length].lower()


def clean_result(raw: dict[str, Any]) -> dict[str, str]:
    cleaned = {
        "subject": normalise(raw.get("subject")),
        "subject_adj": normalise(raw.get("subject_adj"), 70),
        "verb": normalise(raw.get("verb"), 50),
        "target_subject": normalise(raw.get("target_subject")),
        "target_state_adj": normalise(raw.get("target_state_adj"), 70),
    }
    aliases = {
        "subject": {"street light": "streetlight fault", "streetlight": "streetlight fault", "traffic signal": "traffic signal fault", "traffic light": "traffic signal fault", "manhole cover": "utility cover", "drain blockage": "blocked drain"},
        "verb": {"block": "obstructs", "blocks": "obstructs", "damage": "damages", "endanger": "endangers", "disrupt": "disrupts"},
        "target_subject": {
            "people safety": "people_safety",
            "public safety": "people_safety",
            "pedestrian safety": "people_safety",
            "pedestrians": "people_safety",
            "road users": "people_safety",
            "pedestrian access": "pedestrian_access",
            "street space": "public_realm",
            "public space": "public_realm",
            "traffic flow": "vehicle_movement",
            "lighting function": "lighting_function",
            "traffic control function": "traffic_control_function",
            "utility infrastructure": "utility_infrastructure",
        },
        "target_state_adj": {"not working": "disrupted", "blocked": "obstructed"},
    }
    for field, mapping in aliases.items():
        cleaned[field] = mapping.get(cleaned[field], cleaned[field])
    for field in VOCAB:
        underscored = cleaned[field].replace(" ", "_")
        if underscored in VOCAB[field]:
            cleaned[field] = underscored
    return cleaned


def image_part(image_path: str | None) -> dict[str, Any] | None:
    if not image_path:
        return None
    with Image.open(image_path) as image:
        image = image.convert("RGB")
        image.thumbnail((1600, 1600))
        buffer = io.BytesIO()
        image.save(buffer, format="JPEG", quality=86, optimize=True)
    return {
        "inlineData": {
            "mimeType": "image/jpeg",
            "data": base64.b64encode(buffer.getvalue()).decode("ascii"),
        }
    }


def build_prompt(report_text: str, has_image: bool) -> str:
    return f"""
Extract one conservative causal five-field label from this UK urban street-issue report.
Use English lower-case labels. Use text first and the image only for visible facts.
Return only one JSON object with exactly these keys:
subject, subject_adj, verb, target_subject, target_state_adj

Definitions:
- subject: reported cause or problematic entity
- subject_adj: short visible/descriptive modifier; use an empty string if unsupported
- verb: causal action in third-person singular
- target_subject: directly affected urban function, object or recipient
- target_state_adj: resulting state

Rules:
- Prefer repeatable labels, not addresses, names or incident-specific prose.
- Use a real causal verb; never use is/are/has/have/needs/requires/shows.
- Do not invent causal consequences. If evidence is weak, use a conservative direct effect.
- Broken infrastructure should normally be the subject, not an unnamed person.
- Output JSON only, with no markdown or explanation.
- Except for subject_adj, choose only from these dataset-compatible labels:
  subject: {json.dumps(sorted(VOCAB["subject"]), ensure_ascii=False)}
  verb: {json.dumps(sorted(VOCAB["verb"]), ensure_ascii=False)}
  target_subject: {json.dumps(sorted(VOCAB["target_subject"]), ensure_ascii=False)}
  target_state_adj: {json.dumps(sorted(VOCAB["target_state_adj"]), ensure_ascii=False)}

Examples:
{{"subject":"pavement damage","subject_adj":"cracked","verb":"endangers","target_subject":"people safety","target_state_adj":"unsafe"}}
{{"subject":"drain blockage","subject_adj":"blocked","verb":"obstructs","target_subject":"drainage","target_state_adj":"obstructed"}}
{{"subject":"streetlight","subject_adj":"unlit","verb":"reduces","target_subject":"lighting function","target_state_adj":"disrupted"}}

Input has image: {str(has_image).lower()}
Report text: {json.dumps(report_text[:3000], ensure_ascii=False)}
""".strip()


def parse_json_object(text: str) -> dict[str, Any]:
    cleaned = text.strip()
    if cleaned.startswith("```"):
        cleaned = cleaned.strip("`")
        if cleaned.lower().startswith("json"):
            cleaned = cleaned[4:].strip()
    parsed, _ = json.JSONDecoder().raw_decode(cleaned)
    if not isinstance(parsed, dict):
        raise ValueError("The response is not a JSON object")
    return parsed


def call_gemini(report_text: str, image_path: str | None) -> tuple[dict[str, str], str]:
    api_key = os.getenv("GEMINI_API_KEY") or os.getenv("GOOGLE_API_KEY")
    if not api_key:
        return fallback_extract(report_text), "Local fallback"

    parts: list[dict[str, Any]] = [{"text": build_prompt(report_text, bool(image_path))}]
    encoded_image = image_part(image_path)
    if encoded_image:
        parts.append(encoded_image)
    request_body = {
        "contents": [{"role": "user", "parts": parts}],
        "generationConfig": {"temperature": 0, "responseMimeType": "application/json"},
    }
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{MODEL}:generateContent?key={api_key}"
    request = urllib.request.Request(
        url,
        data=json.dumps(request_body, ensure_ascii=False).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=75) as response:
        body = json.loads(response.read().decode("utf-8"))
    candidates = body.get("candidates") or []
    if not candidates:
        raise RuntimeError("The model returned no candidate")
    output_text = "".join(
        part.get("text", "") for part in candidates[0].get("content", {}).get("parts", [])
    )
    return clean_result(parse_json_object(output_text)), f"Gemini · {MODEL}"


def fallback_extract(report_text: str) -> dict[str, str]:
    """Transparent offline fallback for UI testing; not presented as model inference."""
    text = report_text.lower()
    rules = [
        (("blocked drain", "drain blocked", "drainage"), ("blocked drain", "blocked", "obstructs", "drainage_function", "obstructed")),
        (("pothole",), ("pothole", "damaged", "endangers", "people_safety", "unsafe")),
        (("pavement", "footway", "sidewalk"), ("pavement damage", "damaged", "endangers", "people_safety", "unsafe")),
        (("streetlight", "street light", "lamp post", "lamppost"), ("streetlight fault", "unlit", "reduces", "visibility", "reduced")),
        (("traffic light", "traffic signal"), ("traffic signal fault", "faulty", "disrupts", "traffic_control_function", "disrupted")),
        (("manhole", "utility cover"), ("utility cover", "damaged", "endangers", "people_safety", "unsafe")),
        (("rubbish", "trash", "waste", "fly tipping"), ("waste accumulation", "accumulated", "obstructs", "public_realm", "obstructed")),
        (("graffiti",), ("graffiti", "visible", "damages", "public_realm", "degraded")),
    ]
    for keywords, output in rules:
        if any(keyword in text for keyword in keywords):
            return dict(zip(REQUIRED_KEYS, output))
    return {
        "subject": "unknown source",
        "subject_adj": "",
        "verb": "causes",
        "target_subject": "other or unknown",
        "target_state_adj": "other or unknown",
    }


def validate_output(result: dict[str, str], report_text: str, used_fallback: bool) -> tuple[str, int, list[list[str]]]:
    checks: list[list[str]] = []
    errors = 0
    warnings = 0

    for key in REQUIRED_KEYS:
        value = result.get(key, "")
        required = key in REQUIRED_NON_EMPTY
        if required and not value:
            checks.append([key, "Fail", "Required field is empty"])
            errors += 1
        elif not value:
            checks.append([key, "Pass", "Optional modifier is empty"])
        elif key in VOCAB and value not in VOCAB[key]:
            checks.append([key, "Warning", "Valid JSON, but label is outside the dashboard vocabulary"])
            warnings += 1
        else:
            checks.append([key, "Pass", "Present and compatible with the dashboard schema"])

    if result.get("verb") in BANNED_VERBS:
        checks.append(["causal_verb", "Fail", "Copular/non-causal verb detected"])
        errors += 1
    else:
        checks.append(["causal_verb", "Pass", "A causal/action verb is present"])

    generic_hits = sum(result.get(key, "") in GENERIC_VALUES for key in REQUIRED_NON_EMPTY)
    if generic_hits:
        checks.append(["specificity", "Warning", f"{generic_hits} generic label(s); human review recommended"])
        warnings += generic_hits
    else:
        checks.append(["specificity", "Pass", "No generic required labels detected"])

    if len(report_text.strip()) < 25:
        checks.append(["input_evidence", "Warning", "Very short text; the relation may be ambiguous"])
        warnings += 1
    else:
        checks.append(["input_evidence", "Pass", "Text contains enough content for a demonstration"])

    if used_fallback:
        checks.append(["inference_mode", "Warning", "Rule-based fallback used; not model confidence"])
        warnings += 1

    score = max(5, min(100, 100 - errors * 28 - warnings * 8))
    status = "Failed" if errors else "Passed with warnings" if warnings else "Passed"
    return status, score, checks


def similar_chains(result: dict[str, str], limit: int = 6) -> list[list[Any]]:
    query = [result["subject"], result["verb"], result["target_subject"], result["target_state_adj"]]
    matches = []
    for rank, row in enumerate(CHAINS, start=1):
        score = sum(a == b for a, b in zip(query, row["parts"]))
        if score:
            matches.append((score, row["count"], rank, row))
    matches.sort(key=lambda item: (-item[0], -item[1]))
    return [
        [f"{score}/4 fields", " → ".join(row["parts"]), f"{row['count']:,}", rank]
        for score, _, rank, row in matches[:limit]
    ]


def status_card(status: str, score: int, mode: str, duration: float, result: dict[str, str]) -> str:
    tone = "ok" if status == "Passed" else "warn" if status == "Passed with warnings" else "bad"
    chain = " → ".join(html.escape(result[key]) for key in ["subject", "verb", "target_subject", "target_state_adj"])
    return f"""
    <div class="result-card {tone}">
      <div><span>Schema validation</span><strong>{html.escape(status)}</strong></div>
      <div><span>Output quality signal</span><strong>{score}/100</strong></div>
      <div><span>Inference</span><strong>{html.escape(mode)}</strong></div>
      <div><span>Latency</span><strong>{duration:.2f}s</strong></div>
      <p>{chain}</p>
    </div>
    """


def analyse(report_text: str, image_path: str | None):
    text = (report_text or "").strip()
    if not text and not image_path:
        empty = {key: "" for key in REQUIRED_KEYS}
        checks = [["input", "Fail", "Enter report text or upload an image"]]
        return status_card("Failed", 5, "Not run", 0, empty), empty, checks, [], "No inference was sent."

    started = time.perf_counter()
    try:
        result, mode = call_gemini(text, image_path)
        result = clean_result(result)
        note = "The API key stays in the server environment; input is not written to the synthetic demo dataset."
    except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, ValueError, RuntimeError, OSError) as exc:
        result = fallback_extract(text)
        mode = "Local fallback"
        note = f"Live inference was unavailable, so the transparent rule-based fallback was used. Error class: {type(exc).__name__}."
    duration = time.perf_counter() - started
    status, score, checks = validate_output(result, text, mode == "Local fallback")
    matches = similar_chains(result)
    return status_card(status, score, mode, duration, result), result, checks, matches, note




# ======================================================================
# P0: Task Planning Agent
# ======================================================================

_qwen_client = None


def _get_qwen():
    global _qwen_client
    if _qwen_client is None:
        from openai import OpenAI as _OpenAI
        import os
        _qwen_client = _OpenAI(
            api_key=os.environ.get("DASHSCOPE_API_KEY"),
            base_url="https://dashscope.aliyuncs.com/compatible-mode/v1",
        )
    return _qwen_client


def call_qwen_extract(report_text):
    prompt = build_prompt(report_text, has_image=False)
    client = _get_qwen()
    resp = client.chat.completions.create(
        model="qwen3.8-flash",
        messages=[
            {"role": "system", "content": "You extract structured causal relations. Return JSON only."},
            {"role": "user", "content": prompt},
        ],
        temperature=0,
        response_format={"type": "json_object"},
    )
    text = resp.choices[0].message.content or "{}"
    parsed = parse_json_object(text)
    return clean_result(parsed)


def agent_plan(user_question):
    system = (
        "You are a task-planning agent for an urban causal-analysis system. "
        "Available tools: data_retrieval, causal_analysis, result_presentation. "
        "Return JSON: {\"steps\":[{\"step\":1,\"action\":\"data_retrieval\",\"purpose\":\"\"}]} with exactly 3 steps."
    )
    client = _get_qwen()
    resp = client.chat.completions.create(
        model="qwen3.8-flash",
        messages=[
            {"role": "system", "content": system},
            {"role": "user", "content": user_question},
        ],
        temperature=0,
        response_format={"type": "json_object"},
    )
    import json as _json
    parsed = _json.loads(resp.choices[0].message.content or "{}")
    return parsed.get("steps", [])


def agent_retrieve(user_question, limit=5):
    import re as _re
    keywords = [w for w in _re.split(r"\W+", user_question.lower()) if len(w) > 3]
    scored = []
    for rank, row in enumerate(CHAINS, start=1):
        text = " ".join(row["parts"]).lower()
        hits = sum(1 for kw in keywords if kw in text)
        if hits:
            scored.append((hits, row["count"], rank, row))
    scored.sort(key=lambda x: (-x[0], -x[1]))
    return [
        [f"{hits} hits", " -> ".join(row["parts"]), f"{row['count']:,}", rank]
        for hits, _, rank, row in scored[:limit]
    ]


def run_agent_stream(user_question, report_text):
    import time as _time
    progress = "## Agent Workflow\n\n"

    # Step 0: Plan
    progress += "### Planning task...\n"
    yield progress, [], {}, ""
    try:
        steps = agent_plan(user_question)
    except Exception as e:
        steps = [
            {"step": 1, "action": "data_retrieval", "purpose": "Search similar chains"},
            {"step": 2, "action": "causal_analysis", "purpose": "Extract causal relation"},
            {"step": 3, "action": "result_presentation", "purpose": "Summarize results"},
        ]
    plan_lines = "\n".join(
        f"{s.get('step','?')}. **{s.get('action','?')}** - {s.get('purpose','')}"
        for s in steps
    )
    progress += f"Plan:\n{plan_lines}\n\n"
    yield progress, [], {}, ""
    _time.sleep(0.5)

    # Step 1: Retrieve
    progress += "### Step 1/3: Retrieving similar chains...\n"
    yield progress, [], {}, ""
    retrieved = agent_retrieve(user_question + " " + report_text)
    progress += f"Found {len(retrieved)} related chains\n\n"
    yield progress, retrieved, {}, ""
    _time.sleep(0.5)

    # Step 2: Analyse
    progress += "### Step 2/3: Extracting causal relation...\n"
    yield progress, retrieved, {}, ""
    try:
        result = call_qwen_extract(report_text)
    except Exception as e:
        result = fallback_extract(report_text)
        progress += f"Fallback used: {e}\n"
    status, score, checks = validate_output(result, report_text, False)
    progress += (
        f"Result: `{result['subject']} -> {result['verb']} -> "
        f"{result['target_subject']} -> {result['target_state_adj']}` "
        f"(quality {score}/100)\n\n"
    )
    yield progress, retrieved, result, ""
    _time.sleep(0.5)

    # Step 3: Present
    progress += "### Step 3/3: Summary\n\n"
    summary = (
        f"Agent done. Question: {user_question}\n\n"
        f"- Retrieved {len(retrieved)} similar chains\n"
        f"- Causal relation: {result['subject']} -> {result['verb']} -> {result['target_subject']} -> {result['target_state_adj']}"
    )
    progress += summary
    yield progress, retrieved, result, summary

CSS = """
:root { --ink:#172725; --teal:#0d625c; --gold:#c49b49; --wash:#f2f6f5; }
.gradio-container { max-width: 1240px !important; margin: 0 auto !important; color: var(--ink); }
.hero-poc { padding: 28px 30px; border-radius: 18px; color: white; background:linear-gradient(125deg,#074a46,#0d625c 70%,#257970); box-shadow:0 12px 30px rgba(13,98,92,.16); }
.hero-poc .eyebrow { color:#efd999; font-size:12px; font-weight:800; letter-spacing:.12em; }
.hero-poc h1 { margin:8px 0 4px; color:#fff !important; font-size:34px; line-height:1.12; }
.hero-poc p { max-width:780px; margin:0; color:#e6f1ef; line-height:1.55; }
.hero-poc .badges { display:flex; flex-wrap:wrap; gap:8px; margin-top:16px; }
.hero-poc .badges span { padding:5px 10px; border:1px solid rgba(255,255,255,.45); border-radius:999px; color:#f4fbfa !important; background:rgba(255,255,255,.08); font-size:12px; }
.result-card { display:grid; grid-template-columns:repeat(4,1fr); gap:8px; padding:14px; border:1px solid #d7dcd8; border-left:5px solid #0d625c; border-radius:12px; background:#fff; }
.result-card.warn { border-left-color:#c49b49; }
.result-card.bad { border-left-color:#b84c4c; }
.result-card div { padding:8px; border-radius:8px; background:#f2f6f5; }
.result-card span { display:block; color:#61706d; font-size:10px; font-weight:800; text-transform:uppercase; }
.result-card strong { display:block; margin-top:3px; font-size:15px; }
.result-card p { grid-column:1/-1; margin:4px 6px 0; color:#0d625c; font-weight:700; }
.portfolio-grid { display:grid; grid-template-columns:repeat(5,1fr); gap:10px; }
.portfolio-grid article { padding:15px; border:1px solid #d7dcd8; border-radius:12px; background:#fff; }
.portfolio-grid b { display:block; color:#0d625c; margin-bottom:6px; }
.portfolio-grid span { color:#61706d; font-size:12px; line-height:1.45; }
.boundary { padding:12px 15px; border-left:4px solid #c49b49; background:#fff9eb; border-radius:8px; }
#issue-image button[aria-dropeffect="copy"] .wrap { font-size:0; }
#issue-image button[aria-dropeffect="copy"] .wrap::after { content:"Drop an image here or click to upload"; display:block; font-size:14px; margin-top:8px; }
#issue-image button[aria-dropeffect="copy"] .or { display:none; }
@media(max-width:800px) {
  .gradio-container,
  .gradio-container .main,
  .gradio-container .wrap,
  .gradio-container main { width:100% !important; min-width:0 !important; max-width:100% !important; box-sizing:border-box; }
  .gradio-container .main { padding:12px !important; }
  #analysis-grid { flex-direction:column; }
  #analysis-grid > * { min-width:100% !important; width:100% !important; }
  .result-card,.portfolio-grid { grid-template-columns:1fr 1fr; }
  .hero-poc { padding:24px 22px; }
  .hero-poc h1{font-size:27px}
}
"""


with gr.Blocks(title="Urban Causal AI POC") as demo:
    gr.HTML(
        """
        <section class="hero-poc">
          <div class="eyebrow">AI 应用原型 · 多模态因果关系抽取</div>
          <h1>城市问题 → 因果链分析</h1>
          <p>输入一条城市问题报告，自动抽取五字段因果关系；基于 27.5 万条真实报告聚合的统计知识库进行相似案例检索。</p>
          <div class="badges"><span>文本 + 图片</span><span>结构化 JSON</span><span>Schema 校验</span><span>Agent 工作流</span><span>真实数据知识库</span></div>
        </section>
        """
    )

    with gr.Tabs():
        with gr.Tab("🤖 Agent 智能体模式"):
            gr.Markdown("输入你想分析的问题，Agent 自动完成「数据检索 → 因果分析 → 结果汇总」三步。")
            with gr.Row():
                with gr.Column(scale=4):
                    agent_question = gr.Textbox(
                        label="你的问题",
                        placeholder="例如：分析这条报告中垃圾堆积和街道环境的因果关系",
                        lines=2,
                    )
                    agent_report = gr.Textbox(
                        label="报告正文",
                        placeholder="粘贴一条 FixMyStreet 报告正文...",
                        lines=5,
                    )
                    agent_btn = gr.Button("🚀 启动 Agent", variant="primary", size="lg")
                with gr.Column(scale=6):
                    agent_progress = gr.Markdown("等待启动...")
                    agent_table = gr.Dataframe(
                        headers=["匹配度", "相似因果链", "报告数", "排名"],
                        datatype=["str", "str", "str", "number"],
                        interactive=False,
                        label="从 27.5 万条真实数据中检索到的相似链路",
                    )
                    agent_json = gr.JSON(label="因果抽取结果")
                    agent_summary = gr.Markdown()
            agent_btn.click(
                fn=run_agent_stream,
                inputs=[agent_question, agent_report],
                outputs=[agent_progress, agent_table, agent_json, agent_summary],
            )

        with gr.Tab("🔬 手动分析模式"):
            with gr.Row(equal_height=False, elem_id="analysis-grid"):
                with gr.Column(scale=5):
                    gr.Markdown("## 1 · 输入一条城市问题报告")
                    report_input = gr.Textbox(
                        label="报告正文",
                        placeholder="例如：人行道严重开裂，行人可能绊倒。",
                        lines=7,
                    )
                    image_input = gr.Image(
                        label="可选：上传图片",
                        type="filepath",
                        sources=["upload"],
                        height=230,
                        elem_id="issue-image",
                    )
                    analyse_button = gr.Button("分析因果关系", variant="primary", size="lg")
                    gr.Examples(
                        examples=[
                            ["The pavement is badly cracked and pedestrians may trip and fall."],
                            ["The drain is completely blocked and water cannot flow away."],
                            ["The streetlight has stopped working and the footpath is unlit at night."],
                            ["Traffic lights are faulty, causing long delays at the junction."],
                            ["Something is wrong near the road."],
                        ],
                        inputs=[report_input],
                        label="示例报告",
                    )
                with gr.Column(scale=7):
                    gr.Markdown("## 2 · 结构化抽取结果与校验")
                    status_output = gr.HTML()
                    json_output = gr.JSON(label="五字段因果关系 JSON")
                    validation_output = gr.Dataframe(
                        headers=["检查项", "结果", "说明"],
                        datatype=["str", "str", "str"],
                        interactive=False,
                        label="Schema 与质量校验",
                    )
                    inference_note = gr.Markdown()

        gr.Markdown("## 3 · 从真实数据中检索相似因果模式")
        similar_output = gr.Dataframe(
            headers=["匹配度", "相似因果链", "报告数", "数据排名"],
            datatype=["str", "str", "str", "number"],
            interactive=False,
            label="聚合因果链 Top-N",
        )
        gr.Markdown(f"[Open the interactive synthetic-data dashboard ↗]({DASHBOARD_URL})")

        with gr.Accordion("Evaluation plan and known bad cases", open=False):
            gr.Markdown(
                """
    This public edition intentionally excludes evaluation results derived from restricted research data. A production evaluation should report JSON parse success, field-level accuracy, exact five-field match, calibration and performance on a separately designed hard-case set.

    **Known bad cases:** vague one-line reports; several causal relations in one report; visually implied consequences; inconsistent label granularity; valid JSON with semantically debatable targets. These cases require human review and a governed evaluation dataset.
                """
            )

        gr.HTML(
            """
            <h2>4 · Product framing</h2>
            <div class="portfolio-grid">
              <article><b>Problem</b><span>Large volumes of unstructured urban reports are difficult to compare or prioritise.</span></article>
              <article><b>Solution</b><span>Multimodal LLM extraction, constrained JSON, validation and dataset retrieval.</span></article>
              <article><b>Metrics</b><span>Schema pass/fail, output-quality checks, latency and synthetic-pattern retrieval.</span></article>
              <article><b>Boundary</b><span>Reported causal language is not proof of real-world causal effect or population risk.</span></article>
              <article><b>Value</b><span>Faster triage, consistent issue taxonomy, explainable exploration and analyst review.</span></article>
            </div>
            <p class="boundary"><b>Privacy:</b> all bundled records are synthetic. Do not submit confidential or research-restricted content; Gemini-mode inputs are sent to the configured API and are not appended to the demo dataset.</p>
            """
        )

    analyse_button.click(
        fn=analyse,
        inputs=[report_input, image_input],
        outputs=[status_output, json_output, validation_output, similar_output, inference_note],
        api_name="analyse",
    )


if __name__ == "__main__":
    demo.queue(default_concurrency_limit=2).launch(
        server_name=os.getenv("GRADIO_SERVER_NAME", "127.0.0.1"),
        server_port=int(os.getenv("PORT", "7860")),
        show_error=True,
        theme=gr.themes.Soft(primary_hue="teal", neutral_hue="slate"),
        css=CSS,
        footer_links=[],
    )
