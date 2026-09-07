"use strict";

const META_URL = "data/explorer_data.json";
const RECORD_URL = "data/explorer_records.json.gz";
const ARROW = "\u2192";
const DOT = "\u00b7";
const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const LENS_META = {
  all: { label: "All synthetic relations", n: 8000, subjects: null },
  transport: { label: "Transport & public realm", n: 2700, subjects: ["pavement damage", "pothole", "road surface damage", "faded road marking", "damaged bollard", "road barrier", "street sign", "roadworks"] },
  drainage: { label: "Drainage & water", n: 1300, subjects: ["blocked drain", "damaged drain", "water leak", "surface flooding", "sewer overflow"] },
  lighting: { label: "Lighting & traffic control", n: 900, subjects: ["streetlight fault", "traffic signal fault", "public camera fault"] },
  utilities: { label: "Utilities & street assets", n: 1100, subjects: ["utility cover", "utility cabinet", "street furniture", "public bin", "fence", "gate"] }
};
LENS_META.infrastructure = {
  label: "Infrastructure",
  n: 6000,
  subjects: [...LENS_META.transport.subjects, ...LENS_META.drainage.subjects, ...LENS_META.lighting.subjects, ...LENS_META.utilities.subjects]
};
const INFRASTRUCTURE_SUBJECTS = new Set(LENS_META.infrastructure.subjects);
const PRIORITY_STATES = new Set(["unsafe", "obstructed", "damaged", "disrupted", "flooded"]);

let DATA = null;
let RECORDS = null;
let currentBaseFlows = [];
let currentFlows = [];
let currentFilteredRecords = [];
let currentImpactFlows = [];

const state = {
  level: "2",
  lens: "infrastructure",
  subject: "",
  target: "",
  borough: "",
  month: "",
  topN: 25,
  networkDirection: "cause",
  selection: null,
  causeFocus: "",
  outcomeFocus: "",
  impactState: ""
};

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const fmt = value => Number(value || 0).toLocaleString("en-GB");
const pct = (value, digits = 1) => `${(100 * Number(value || 0)).toFixed(digits)}%`;
const matrixPct = share => share > 0 && share < .01 ? "<1%" : pct(share, 0);
const human = value => String(value || "").replaceAll("_", " ");
const esc = value => String(value ?? "").replace(/[&<>"']/g, char => ({
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  "\"": "&quot;",
  "'": "&#39;"
}[char]));
const short = (value, length = 42) => {
  const text = String(value || "");
  return text.length > length ? `${text.slice(0, length - 1)}\u2026` : text;
};

function dict() {
  const source = DATA.dictionaries;
  return {
    s: source.subjects,
    v: source.verbs,
    t: source.targets,
    a: source.states,
    b: source.boroughs,
    m: source.months
  };
}

function partsOf(chain) {
  const d = dict();
  return [d.s[chain[0]], d.v[chain[1]], d.t[chain[2]], d.a[chain[3]]];
}

function recordParts(row) {
  const d = dict();
  return [d.s[row[0]], d.v[row[1]], d.t[row[2]], d.a[row[3]]];
}

function flowId(parts) {
  return parts.join("|||");
}

function outcomeKey(target, resultState) {
  return `${target}|||${resultState}`;
}

function outcomeLabel(target, resultState) {
  return `${human(target)} ${ARROW} ${human(resultState)}`;
}

function buildOptions(select, values, label, selected) {
  select.innerHTML = `<option value="">${esc(label)}</option>` + values
    .map(value => `<option value="${esc(value)}">${esc(human(value))}</option>`)
    .join("");
  select.value = selected;
}

function lensMatchesSubject(subject) {
  const subjects = LENS_META[state.lens]?.subjects;
  return !subjects || subjects.includes(subject);
}

function subjectsForLens() {
  const subjects = LENS_META[state.lens]?.subjects;
  return subjects ? dict().s.filter(subject => subjects.includes(subject)) : dict().s;
}

function refreshSubjectOptions() {
  buildOptions($("#subjectFilter"), subjectsForLens(), "All cause subjects", state.subject);
}

function filteredRecords() {
  if (!RECORDS) return [];
  const d = dict();
  return RECORDS.filter(row =>
    lensMatchesSubject(d.s[row[0]]) &&
    (!state.subject || d.s[row[0]] === state.subject) &&
    (!state.target || d.t[row[2]] === state.target) &&
    (!state.borough || d.b[row[6]] === state.borough) &&
    (!state.month || d.m[row[7]] === state.month)
  );
}

function aggregateRecordsToLevel2(rows) {
  const counts = new Map();
  rows.forEach(row => {
    const parts = recordParts(row);
    const id = flowId(parts);
    if (!counts.has(id)) counts.set(id, { id, parts, n: 0, label: parts.map(human).join(` ${ARROW} `) });
    counts.get(id).n += 1;
  });
  return [...counts.values()].sort((a, b) => b.n - a.n);
}

function staticLevel2Flows() {
  const d = dict();
  return DATA.chains
    .filter(row =>
      lensMatchesSubject(d.s[row[0]]) &&
      (!state.subject || d.s[row[0]] === state.subject) &&
      (!state.target || d.t[row[2]] === state.target)
    )
    .map(row => {
      const parts = partsOf(row);
      return { parts, n: row[4], id: flowId(parts), label: parts.map(human).join(` ${ARROW} `) };
    })
    .sort((a, b) => b.n - a.n);
}

function aggregateForActiveLevel(level2Rows) {
  if (state.level === "2") return level2Rows.map(row => ({ ...row }));
  const grouped = new Map();
  level2Rows.forEach(row => {
    const parts = [row.parts[0], row.parts[2]];
    const id = flowId(parts);
    if (!grouped.has(id)) {
      grouped.set(id, {
        id,
        parts,
        n: 0,
        label: parts.map(human).join(` ${ARROW} `)
      });
    }
    grouped.get(id).n += row.n;
  });
  return [...grouped.values()].sort((a, b) => b.n - a.n);
}

function computeFlows() {
  currentFilteredRecords = filteredRecords();
  const useSpatialAggregation = Boolean(state.borough || state.month) && RECORDS;
  currentBaseFlows = useSpatialAggregation
    ? aggregateRecordsToLevel2(currentFilteredRecords)
    : staticLevel2Flows();
  const activeFlows = aggregateForActiveLevel(currentBaseFlows);
  const rankedContext = activeFlows.slice(0, state.topN);
  if (state.selection) {
    const selectedFlows = activeFlows.filter(flow => selectionMatchesActive(flow.parts)).slice(0, state.topN);
    const selectedIds = new Set(selectedFlows.map(flow => flow.id));
    currentFlows = [...selectedFlows, ...rankedContext.filter(flow => !selectedIds.has(flow.id))].slice(0, state.topN);
  } else {
    currentFlows = rankedContext;
  }
  return activeFlows;
}

function selectionMatchesBase(parts) {
  const selection = state.selection;
  if (!selection) return true;
  if (selection.kind === "chain") {
    if (selection.level === "1") {
      return parts[0] === selection.parts[0] && parts[2] === selection.parts[1];
    }
    return flowId(parts) === selection.id;
  }
  if (selection.kind === "node") {
    const baseLayer = state.level === "1" && selection.layer === 1 ? 2 : selection.layer;
    return parts[baseLayer] === selection.label;
  }
  if (selection.kind === "edge") {
    if (state.level === "1") return parts[0] === selection.from && parts[2] === selection.to;
    return parts[selection.layer] === selection.from && parts[selection.layer + 1] === selection.to;
  }
  if (selection.kind === "pattern") {
    return (!selection.subject || parts[0] === selection.subject) &&
      (!selection.verb || parts[1] === selection.verb) &&
      (!selection.target || parts[2] === selection.target) &&
      (!selection.resultState || parts[3] === selection.resultState);
  }
  return true;
}

function selectionMatchesActive(parts) {
  const selection = state.selection;
  if (!selection) return true;
  if (selection.kind === "chain") return flowId(parts) === selection.id;
  if (selection.kind === "node") return parts[selection.layer] === selection.label;
  if (selection.kind === "edge") {
    return parts[selection.layer] === selection.from && parts[selection.layer + 1] === selection.to;
  }
  if (selection.kind === "pattern") {
    if (state.level === "1") {
      return (!selection.subject || parts[0] === selection.subject) &&
        (!selection.target || parts[1] === selection.target);
    }
    return (!selection.subject || parts[0] === selection.subject) &&
      (!selection.verb || parts[1] === selection.verb) &&
      (!selection.target || parts[2] === selection.target) &&
      (!selection.resultState || parts[3] === selection.resultState);
  }
  return true;
}

function visibleFlows() {
  return currentFlows.filter(flow => selectionMatchesActive(flow.parts));
}

function selectedRecords() {
  return currentFilteredRecords.filter(row => selectionMatchesBase(recordParts(row)));
}

function selectedBaseFlows() {
  return currentBaseFlows.filter(flow => selectionMatchesBase(flow.parts));
}

function selectionTitle() {
  const selection = state.selection;
  if (!selection) return "All displayed flows";
  if (selection.kind === "chain") return selection.label;
  if (selection.kind === "node") {
    const names = state.level === "1"
      ? ["Cause subject", "Affected function"]
      : ["Cause subject", "Verb", "Affected function", "Resulting state"];
    return `${names[selection.layer]}: ${human(selection.label)}`;
  }
  if (selection.kind === "pattern") return selection.label;
  return `${human(selection.from)} ${ARROW} ${human(selection.to)}`;
}

function renderCards(allFlows) {
  const filteredN = (state.borough || state.month) && RECORDS
    ? currentFilteredRecords.length
    : allFlows.reduce((sum, row) => sum + row.n, 0);
  const selectedN = state.selection
    ? (RECORDS ? selectedRecords().length : selectedBaseFlows().reduce((sum, row) => sum + row.n, 0))
    : (RECORDS ? currentFilteredRecords.length : filteredN);
  const top = allFlows[0];
  let leadingBorough = "Spatial data loading";
  if (RECORDS) {
    const counts = {};
    const rows = state.selection ? selectedRecords() : currentFilteredRecords;
    const d = dict();
    rows.forEach(row => {
      const name = d.b[row[6]];
      counts[name] = (counts[name] || 0) + 1;
    });
    leadingBorough = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] || "No mapped reports";
  }
  $("#summaryCards").innerHTML = [
    ["Analysis lens", LENS_META[state.lens].label, `${fmt(filteredN)} relations after active filters`],
    ["Filtered synthetic relations", fmt(filteredN), state.borough || state.month ? "Synthetic spatiotemporal subset" : "Complete demo count"],
    ["Matching causal chains", fmt(allFlows.length), `${fmt(currentFlows.length)} shown in the network`],
    ["Selected mapped reports", fmt(selectedN), state.selection ? short(selectionTitle(), 60) : "No network selection"],
    ["Leading synthetic zone", short(leadingBorough, 28), top ? short(top.label, 60) : "No causal chain available"]
  ].map(([label, value, note]) =>
    `<div class="card"><div class="label">${esc(label)}</div><div class="value">${esc(value)}</div><div class="note">${esc(note)}</div></div>`
  ).join("");
}

function networkInterpretation() {
  const flows = visibleFlows();
  const reportCount = flows.reduce((sum, row) => sum + row.n, 0);
  const top = flows[0];
  $("#networkInterpretation").innerHTML = `<ul>
    <li><b>${fmt(flows.length)}</b> visible flow${flows.length === 1 ? "" : "s"} account for <b>${fmt(reportCount)}</b> reports in the displayed network.</li>
    <li>${top ? `Largest visible flow: <b>${esc(top.label)}</b> (n=${fmt(top.n)}).` : "No flow matches the current selection within the displayed top-N network."}</li>
    <li>${state.selection ? `Active selection: <b>${esc(selectionTitle())}</b>.` : "Click a node, connection or ranked row to update all linked views."}</li>
  </ul>`;
}

function wrapLabel(text, maximum = 20, maximumLines = 3) {
  const words = human(text).split(/\s+/);
  const lines = [];
  let line = "";
  words.forEach(word => {
    const next = line ? `${line} ${word}` : word;
    if (next.length > maximum && line) {
      lines.push(line);
      line = word;
    } else {
      line = next;
    }
  });
  if (line) lines.push(line);
  if (lines.length > maximumLines) {
    const kept = lines.slice(0, maximumLines);
    kept[maximumLines - 1] = short(kept[maximumLines - 1], maximum - 1);
    return kept;
  }
  return lines;
}

function renderCauseFirstNetwork() {
  const displayed = currentFlows;
  const visible = visibleFlows();
  const visibleIds = new Set(visible.map(flow => flow.id));
  const svg = $("#networkSvg");
  const width = svg.clientWidth || 1200;
  const height = svg.clientHeight || 640;
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.innerHTML = "";
  if (!displayed.length) return;

  const columns = state.level === "1"
    ? ["Cause subject", "Affected function"]
    : ["Cause subject", "Action / verb", "Affected function", "Resulting state"];
  const nodesByLayer = columns.map(() => new Map());
  const edgesByLayer = columns.slice(1).map(() => new Map());

  displayed.forEach(flow => {
    flow.parts.forEach((label, layer) => {
      if (!nodesByLayer[layer].has(label)) {
        nodesByLayer[layer].set(label, { label, n: 0, active: false });
      }
      const node = nodesByLayer[layer].get(label);
      node.n += flow.n;
      if (visibleIds.has(flow.id)) node.active = true;
    });
    for (let layer = 0; layer < flow.parts.length - 1; layer += 1) {
      const key = `${flow.parts[layer]}|||${flow.parts[layer + 1]}`;
      if (!edgesByLayer[layer].has(key)) {
        edgesByLayer[layer].set(key, {
          from: flow.parts[layer],
          to: flow.parts[layer + 1],
          n: 0,
          active: false
        });
      }
      const edge = edgesByLayer[layer].get(key);
      edge.n += flow.n;
      if (visibleIds.has(flow.id)) edge.active = true;
    }
  });

  const padLeft = 115;
  const padRight = 115;
  const top = 54;
  const bottom = 22;
  const gap = 10;
  const nodeWidth = Math.min(190, Math.max(145, (width - padLeft - padRight) / columns.length * .57));
  const xs = columns.map((_, index) =>
    padLeft + index * ((width - padLeft - padRight) / Math.max(columns.length - 1, 1))
  );
  const layers = nodesByLayer.map(map =>
    [...map.values()].sort((a, b) => b.n - a.n).slice(0, state.level === "1" ? 16 : 13)
  );
  const positions = layers.map((nodes, layer) => {
    const available = height - top - bottom;
    const nodeHeight = Math.min(42, Math.max(25, (available - gap * (nodes.length - 1)) / Math.max(1, nodes.length)));
    const map = new Map();
    nodes.forEach((node, index) => {
      map.set(node.label, {
        x: xs[layer] - nodeWidth / 2,
        y: top + index * (nodeHeight + gap),
        w: nodeWidth,
        h: nodeHeight,
        node
      });
    });
    return map;
  });

  columns.forEach((label, index) => {
    svg.insertAdjacentHTML("beforeend",
      `<text class="netColLabel" x="${xs[index]}" y="23" text-anchor="middle">${esc(label)}</text>`
    );
  });
  const maximumEdge = Math.max(1, ...edgesByLayer.flatMap(map => [...map.values()].map(edge => edge.n)));
  edgesByLayer.forEach((map, layer) => {
    [...map.values()].sort((a, b) => a.n - b.n).forEach(edge => {
      const from = positions[layer].get(edge.from);
      const to = positions[layer + 1].get(edge.to);
      if (!from || !to) return;
      const x1 = from.x + from.w;
      const y1 = from.y + from.h / 2;
      const x2 = to.x;
      const y2 = to.y + to.h / 2;
      const middle = (x1 + x2) / 2;
      const selected = state.selection?.kind === "edge" &&
        state.selection.layer === layer &&
        state.selection.from === edge.from &&
        state.selection.to === edge.to;
      svg.insertAdjacentHTML("beforeend",
        `<path class="netEdge ${edge.active ? "" : "dim"} ${selected ? "active" : ""}" data-layer="${layer}" data-from="${esc(edge.from)}" data-to="${esc(edge.to)}" d="M ${x1} ${y1} C ${middle} ${y1}, ${middle} ${y2}, ${x2} ${y2}" stroke-width="${1.5 + 14 * Math.sqrt(edge.n / maximumEdge)}"><title>${esc(human(edge.from))} ${ARROW} ${esc(human(edge.to))} ${DOT} n=${fmt(edge.n)}</title></path>`
      );
    });
  });
  positions.forEach((map, layer) => {
    [...map.values()].forEach(item => {
      const selected = state.selection?.kind === "node" &&
        state.selection.layer === layer &&
        state.selection.label === item.node.label;
      const lines = wrapLabel(item.node.label);
      const lineHeight = 10;
      const textY = item.y + item.h / 2 - ((lines.length - 1) * lineHeight) / 2 + 3;
      svg.insertAdjacentHTML("beforeend",
        `<g class="netNode ${item.node.active ? "" : "dim"} ${selected ? "active" : ""}" data-layer="${layer}" data-label="${esc(item.node.label)}"><rect x="${item.x}" y="${item.y}" rx="7" width="${item.w}" height="${item.h}"></rect><text x="${item.x + 7}" y="${textY}">${lines.map((line, index) => `<tspan x="${item.x + 7}" dy="${index ? lineHeight : 0}">${esc(line)}</tspan>`).join("")}</text><text x="${item.x + item.w - 7}" y="${item.y + item.h - 6}" text-anchor="end">${fmt(item.node.n)}</text><title>${esc(human(item.node.label))} ${DOT} n=${fmt(item.node.n)}</title></g>`
      );
    });
  });

  $$(".netNode", svg).forEach(node => {
    node.onclick = () => {
      const candidate = {
        kind: "node",
        layer: Number(node.dataset.layer),
        label: node.dataset.label
      };
      state.selection = state.selection?.kind === "node" &&
        state.selection.layer === candidate.layer &&
        state.selection.label === candidate.label
        ? null
        : candidate;
      syncBranchFocusFromSelection();
      renderAll();
    };
  });
  $$(".netEdge", svg).forEach(edge => {
    edge.onclick = () => {
      const candidate = {
        kind: "edge",
        layer: Number(edge.dataset.layer),
        from: edge.dataset.from,
        to: edge.dataset.to
      };
      state.selection = state.selection?.kind === "edge" &&
        state.selection.layer === candidate.layer &&
        state.selection.from === candidate.from &&
        state.selection.to === candidate.to
        ? null
        : candidate;
      syncBranchFocusFromSelection();
      renderAll();
    };
  });
  $("#networkModeLabel").textContent = state.level === "1"
    ? `Level 1 ${DOT} cause ${ARROW} function`
    : `Level 2 ${DOT} full four-field flow`;
}

function renderNetwork() {
  if (state.networkDirection === "impact") {
    renderImpactNetwork();
  } else {
    currentImpactFlows = [];
    renderCauseFirstNetwork();
    networkInterpretation();
  }
}

function renderSelectionSummary() {
  const flows = state.networkDirection === "impact"
    ? currentImpactFlows.filter(flow => selectionMatchesBase(flow.parts))
    : visibleFlows();
  const reportCount = state.networkDirection === "impact"
    ? flows.reduce((sum, row) => sum + row.n, 0)
    : state.selection
      ? selectedBaseFlows().reduce((sum, row) => sum + row.n, 0)
      : currentBaseFlows.reduce((sum, row) => sum + row.n, 0);
  $("#selectionSummary").innerHTML = [
    state.selection ? `Selection: ${selectionTitle()}` : "Selection: all displayed flows",
    `${state.networkDirection === "impact" ? "Priority" : "Visible top-N"} flows: ${fmt(flows.length)}`,
    `Reports represented: ${fmt(reportCount)}`
  ].map(value => `<span class="pill">${esc(value)}</span>`).join("");
}

function focusOptions() {
  const causeCounts = new Map();
  const outcomeCounts = new Map();
  currentBaseFlows.forEach(flow => {
    causeCounts.set(flow.parts[0], (causeCounts.get(flow.parts[0]) || 0) + flow.n);
    const key = outcomeKey(flow.parts[2], flow.parts[3]);
    if (!outcomeCounts.has(key)) {
      outcomeCounts.set(key, { key, target: flow.parts[2], resultState: flow.parts[3], n: 0 });
    }
    outcomeCounts.get(key).n += flow.n;
  });
  return {
    causes: [...causeCounts.entries()]
      .map(([key, n]) => ({ key, n }))
      .sort((a, b) => b.n - a.n),
    outcomes: [...outcomeCounts.values()].sort((a, b) => b.n - a.n)
  };
}

function syncBranchFocusFromSelection() {
  if (!state.selection) return;
  const matching = selectedBaseFlows();
  if (!matching.length) return;
  const top = matching[0];
  state.causeFocus = top.parts[0];
  state.outcomeFocus = outcomeKey(top.parts[2], top.parts[3]);
}

function barRowsHtml(rows, maximum, mode) {
  if (!rows.length) return `<div class="empty-chart">No causal chains match the current filters.</div>`;
  return rows.map(row => {
    const colorClass = mode === "convergence" ? "gold" : "";
    const label = mode === "divergence"
      ? outcomeLabel(row.target, row.resultState)
      : human(row.subject);
    const attributes = `data-subject="${esc(row.subject || state.causeFocus)}" data-target="${esc(row.target)}" data-result-state="${esc(row.resultState)}"`;
    return `<div class="branch-row" ${attributes} title="Click to link this pattern to the network, map and monthly trend">
      <div class="branch-label">${esc(label)}</div>
      <div class="branch-track"><div class="branch-fill ${colorClass}" style="width:${100 * row.n / Math.max(1, maximum)}%"></div></div>
      <div class="branch-value">${fmt(row.n)}<br>${pct(row.share, 0)}</div>
    </div>`;
  }).join("");
}

function renderBranching() {
  const options = focusOptions();
  if (!state.causeFocus || !options.causes.some(row => row.key === state.causeFocus)) {
    state.causeFocus = options.causes[0]?.key || "";
  }
  if (!state.outcomeFocus || !options.outcomes.some(row => row.key === state.outcomeFocus)) {
    state.outcomeFocus = options.outcomes[0]?.key || "";
  }

  $("#causeFocus").innerHTML = options.causes
    .map(row => `<option value="${esc(row.key)}">${esc(human(row.key))} (n=${fmt(row.n)})</option>`)
    .join("");
  $("#causeFocus").value = state.causeFocus;
  $("#outcomeFocus").innerHTML = options.outcomes
    .map(row => `<option value="${esc(row.key)}">${esc(outcomeLabel(row.target, row.resultState))} (n=${fmt(row.n)})</option>`)
    .join("");
  $("#outcomeFocus").value = state.outcomeFocus;

  const divergenceMap = new Map();
  currentBaseFlows
    .filter(flow => flow.parts[0] === state.causeFocus)
    .forEach(flow => {
      const key = outcomeKey(flow.parts[2], flow.parts[3]);
      if (!divergenceMap.has(key)) {
        divergenceMap.set(key, {
          target: flow.parts[2],
          resultState: flow.parts[3],
          subject: flow.parts[0],
          n: 0
        });
      }
      divergenceMap.get(key).n += flow.n;
    });
  const divergenceAll = [...divergenceMap.values()].sort((a, b) => b.n - a.n);
  const divergenceTotal = divergenceAll.reduce((sum, row) => sum + row.n, 0);
  divergenceAll.forEach(row => { row.share = row.n / Math.max(1, divergenceTotal); });
  const divergence = divergenceAll.slice(0, 8);
  $("#divergenceChart").innerHTML = barRowsHtml(
    divergence,
    Math.max(1, ...divergence.map(row => row.n)),
    "divergence"
  );
  $("#divergenceNote").innerHTML = state.causeFocus
    ? `<b>${esc(human(state.causeFocus))}</b> branches into <b>${fmt(divergenceAll.length)}</b> distinct outcomes across <b>${fmt(divergenceTotal)}</b> reports under the active filters.`
    : "No focal cause is available.";

  const [focusTarget = "", focusState = ""] = state.outcomeFocus.split("|||");
  const convergenceMap = new Map();
  currentBaseFlows
    .filter(flow => flow.parts[2] === focusTarget && flow.parts[3] === focusState)
    .forEach(flow => {
      const subject = flow.parts[0];
      if (!convergenceMap.has(subject)) {
        convergenceMap.set(subject, {
          subject,
          target: focusTarget,
          resultState: focusState,
          n: 0
        });
      }
      convergenceMap.get(subject).n += flow.n;
    });
  const convergenceAll = [...convergenceMap.values()].sort((a, b) => b.n - a.n);
  const convergenceTotal = convergenceAll.reduce((sum, row) => sum + row.n, 0);
  convergenceAll.forEach(row => { row.share = row.n / Math.max(1, convergenceTotal); });
  const convergence = convergenceAll.slice(0, 8);
  $("#convergenceChart").innerHTML = barRowsHtml(
    convergence,
    Math.max(1, ...convergence.map(row => row.n)),
    "convergence"
  );
  $("#convergenceNote").innerHTML = state.outcomeFocus
    ? `<b>${esc(outcomeLabel(focusTarget, focusState))}</b> receives reports from <b>${fmt(convergenceAll.length)}</b> distinct causes (n=${fmt(convergenceTotal)}) under the active filters.`
    : "No focal outcome is available.";

  $$(".branch-row").forEach(row => {
    row.onclick = () => {
      const subject = row.dataset.subject;
      const target = row.dataset.target;
      const resultState = row.dataset.resultState;
      state.selection = {
        kind: "pattern",
        subject,
        target,
        resultState,
        label: `${human(subject)} ${ARROW} ${outcomeLabel(target, resultState)}`
      };
      state.causeFocus = subject;
      state.outcomeFocus = outcomeKey(target, resultState);
      renderAll();
    };
  });
}

function mapBounds() {
  const points = DATA.borough_geometry.flatMap(borough => borough.rings.flat());
  const eastings = points.map(point => point[0]);
  const northings = points.map(point => point[1]);
  return {
    minE: Math.min(...eastings),
    maxE: Math.max(...eastings),
    minN: Math.min(...northings),
    maxN: Math.max(...northings)
  };
}

function drawPoints(svg, rows, x, y, className, limit, radius) {
  const stride = Math.max(1, Math.ceil(rows.length / limit));
  rows.forEach((row, index) => {
    if (index % stride) return;
    svg.insertAdjacentHTML("beforeend",
      `<circle class="${className}" cx="${x(row[4]).toFixed(1)}" cy="${y(row[5]).toFixed(1)}" r="${radius}"><title>${esc(recordParts(row).map(human).join(` ${ARROW} `))}</title></circle>`
    );
  });
}

function spatialRows() {
  return state.selection ? selectedRecords() : currentFilteredRecords;
}

function renderMap() {
  const svg = $("#mapSvg");
  const loading = $("#mapLoading");
  const width = svg.clientWidth || 850;
  const height = svg.clientHeight || 620;
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.innerHTML = "";
  const bounds = mapBounds();
  const padding = 18;
  const x = easting => padding + (easting - bounds.minE) / (bounds.maxE - bounds.minE) * (width - 2 * padding);
  const y = northing => height - padding - (northing - bounds.minN) / (bounds.maxN - bounds.minN) * (height - 2 * padding);

  DATA.borough_geometry.forEach(borough => {
    const path = borough.rings.map(ring =>
      ring.map((point, index) =>
        `${index ? "L" : "M"} ${x(point[0]).toFixed(1)} ${y(point[1]).toFixed(1)}`
      ).join(" ") + " Z"
    ).join(" ");
    svg.insertAdjacentHTML("beforeend",
      `<path class="borough ${state.borough === borough.name ? "active" : ""}" data-borough="${esc(borough.name)}" d="${path}"><title>${esc(borough.name)} ${DOT} click to filter</title></path>`
    );
  });
  $$(".borough", svg).forEach(path => {
    path.onclick = () => {
      const name = path.dataset.borough;
      if (dict().b.includes(name)) {
        state.borough = state.borough === name ? "" : name;
        $("#boroughFilter").value = state.borough;
        state.selection = null;
        renderAll();
      }
    };
  });

  if (!RECORDS) {
    loading.classList.remove("hidden");
    return;
  }
  loading.classList.add("hidden");
  const filtered = currentFilteredRecords;
  const selected = state.selection ? selectedRecords() : [];
  drawPoints(svg, filtered, x, y, "point-bg", 4500, 1.35);
  if (selected.length) drawPoints(svg, selected, x, y, "point-selected", 5000, 2.35);

  DATA.borough_geometry.forEach(borough => {
    if (!borough.centroid) return;
    svg.insertAdjacentHTML("beforeend",
      `<text class="boroughLabel" x="${x(borough.centroid[0]).toFixed(1)}" y="${y(borough.centroid[1]).toFixed(1)}" text-anchor="middle">${esc(short(borough.shortLabel, 17))}</text>`
    );
  });

  $("#mapPills").innerHTML = [
    `Mapped filtered reports: ${fmt(filtered.length)}`,
    state.selection ? `Mapped selected reports: ${fmt(selected.length)}` : "Selection: all filtered reports",
    "Display: sampled report locations"
  ].map(value => `<span class="pill">${esc(value)}</span>`).join("");

  const counts = {};
  const d = dict();
  const activeRows = spatialRows();
  activeRows.forEach(row => {
    const name = d.b[row[6]];
    counts[name] = (counts[name] || 0) + 1;
  });
  const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  $("#mapInterpretation").innerHTML = top
    ? `The largest mapped concentration in the ${state.selection ? "selected" : "filtered"} set is <b>${esc(top[0])}</b> (${fmt(top[1])} reports). Point locations are deterministically sampled for display; all records remain in the counts.`
    : "No mapped reports match the current filters.";
}

function monthlyCounts(rows) {
  const d = dict();
  const months = [...d.m].sort();
  const counts = Object.fromEntries(months.map(month => [month, 0]));
  rows.forEach(row => {
    const month = d.m[row[7]];
    counts[month] = (counts[month] || 0) + 1;
  });
  const total = rows.length;
  return months.map(month => ({
    month,
    n: counts[month] || 0,
    share: total ? (counts[month] || 0) / total : 0
  }));
}

function renderTrend() {
  const svg = $("#trendSvg");
  const width = svg.clientWidth || 520;
  const height = svg.clientHeight || 325;
  const padding = { left: 44, right: 16, top: 20, bottom: 40 };
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.innerHTML = "";
  if (!RECORDS) {
    svg.insertAdjacentHTML("beforeend", `<text x="${width / 2}" y="${height / 2}" text-anchor="middle" class="trend-axis">Loading spatial records...</text>`);
    $("#trendInterpretation").textContent = "The monthly view will appear when the spatial layer is ready.";
    $("#trendMetrics").innerHTML = "";
    $("#trendLegend").innerHTML = "";
    $("#boroughBars").innerHTML = "";
    return;
  }

  const context = monthlyCounts(currentFilteredRecords);
  const selectedRows = state.selection ? selectedRecords() : [];
  const selected = state.selection ? monthlyCounts(selectedRows) : [];
  const maximumShare = Math.max(.01, ...context.map(row => row.share), ...selected.map(row => row.share));
  const maximum = Math.min(1, maximumShare * 1.14);
  const chartWidth = width - padding.left - padding.right;
  const chartHeight = height - padding.top - padding.bottom;
  const x = index => padding.left + index * chartWidth / Math.max(1, context.length - 1);
  const y = value => padding.top + chartHeight - value / maximum * chartHeight;

  for (let tick = 0; tick <= 4; tick += 1) {
    const value = maximum * tick / 4;
    const yPosition = y(value);
    svg.insertAdjacentHTML("beforeend",
      `<line class="trend-grid" x1="${padding.left}" y1="${yPosition}" x2="${width - padding.right}" y2="${yPosition}"></line><text class="trend-axis" x="${padding.left - 7}" y="${yPosition + 3}" text-anchor="end">${(100 * value).toFixed(value < .1 ? 1 : 0)}%</text>`
    );
  }
  context.forEach((row, index) => {
    svg.insertAdjacentHTML("beforeend",
      `<text class="trend-axis" x="${x(index)}" y="${height - 16}" text-anchor="middle">${esc(row.month.slice(5))}</text>`
    );
  });
  svg.insertAdjacentHTML("beforeend",
    `<text class="trend-axis" x="${padding.left}" y="${height - 4}">2025 ${DOT} share within each series</text>`
  );

  const contextPoints = context.map((row, index) => `${x(index)},${y(row.share)}`).join(" ");
  const areaPath = `M ${x(0)} ${y(0)} L ${context.map((row, index) => `${x(index)} ${y(row.share)}`).join(" L ")} L ${x(context.length - 1)} ${y(0)} Z`;
  svg.insertAdjacentHTML("beforeend", `<path class="trend-area" d="${areaPath}"></path>`);
  svg.insertAdjacentHTML("beforeend", `<polyline class="trend-line-context" points="${contextPoints}"></polyline>`);
  context.forEach((row, index) => {
    svg.insertAdjacentHTML("beforeend",
      `<circle class="trend-point-context" cx="${x(index)}" cy="${y(row.share)}" r="3"><title>${esc(row.month)} ${DOT} overall ${pct(row.share)} ${DOT} n=${fmt(row.n)}</title></circle>`
    );
  });

  if (state.selection) {
    const selectedPoints = selected.map((row, index) => `${x(index)},${y(row.share)}`).join(" ");
    const sampleClass = selectedRows.length < 100 ? "low-sample" : "";
    svg.insertAdjacentHTML("beforeend", `<polyline class="trend-line-selected ${sampleClass}" points="${selectedPoints}"></polyline>`);
    selected.forEach((row, index) => {
      svg.insertAdjacentHTML("beforeend",
        `<circle class="trend-point-selected" cx="${x(index)}" cy="${y(row.share)}" r="4"><title>${esc(row.month)} ${DOT} selected pattern ${pct(row.share)} ${DOT} n=${fmt(row.n)}</title></circle>`
      );
    });
  }

  const active = state.selection ? selected : context;
  const activeTotal = state.selection ? selectedRows.length : currentFilteredRecords.length;
  const peak = [...active].sort((a, b) => b.share - a.share)[0];
  const monthNumber = peak ? Number(peak.month.slice(5)) : 0;
  const peakName = monthNumber ? MONTH_NAMES[monthNumber - 1] : "No data";
  const sampleNote = !state.selection
    ? "Select a causal pattern"
    : selectedRows.length < 30
      ? "Very small sample; do not infer a stable monthly pattern"
      : selectedRows.length < 100
        ? "Small sample; interpret monthly variation cautiously"
        : "Sample size supports descriptive comparison";
  $("#trendMetrics").innerHTML = [
    ["Reports in active series", fmt(activeTotal), ""],
    ["Peak month", peakName, ""],
    ["Peak-month share", peak ? `${pct(peak.share)} ${DOT} n=${fmt(peak.n)}` : "No data", state.selection && selectedRows.length < 100 ? "warning" : ""]
  ].map(([label, value, className]) =>
    `<div class="trend-metric ${className}"><span>${esc(label)}</span><b>${esc(value)}</b></div>`
  ).join("");

  $("#trendLegend").innerHTML = [
    `Overall monthly profile ${DOT} n=${fmt(currentFilteredRecords.length)}`,
    ...(state.selection ? [`Selected pattern ${DOT} n=${fmt(selectedRows.length)}`, sampleNote] : ["Select a network element to add the selected-pattern profile"])
  ].map(value => `<span class="pill">${esc(value)}</span>`).join("");

  const contextPeakShare = peak ? context.find(row => row.month === peak.month)?.share || 0 : 0;
  const difference = peak ? peak.share - contextPeakShare : 0;
  $("#trendInterpretation").innerHTML = peak && activeTotal
    ? state.selection
      ? `The selected pattern is most concentrated in <b>${esc(peakName)}</b> (${pct(peak.share)}, n=${fmt(peak.n)}), compared with ${pct(contextPeakShare)} in the filtered context (${difference >= 0 ? "+" : ""}${(100 * difference).toFixed(1)} percentage points). ${esc(sampleNote)}.`
      : `The filtered context is most concentrated in <b>${esc(peakName)}</b> (${pct(peak.share)}, n=${fmt(peak.n)}). Select a causal pattern to compare its monthly profile on the same percentage scale.`
    : "No monthly reports match the current filters.";

  renderBoroughBars();
}

function renderBoroughBars() {
  if (!RECORDS) return;
  const d = dict();
  const counts = {};
  const rows = spatialRows();
  rows.forEach(row => {
    const name = d.b[row[6]];
    counts[name] = (counts[name] || 0) + 1;
  });
  const top = Object.entries(counts)
    .map(([name, n]) => ({ name, n }))
    .sort((a, b) => b.n - a.n)
    .slice(0, 6);
  const maximum = Math.max(1, ...top.map(row => row.n));
  $("#boroughBars").innerHTML = top.length
    ? `<div class="mini-bars">${top.map(row => `<div class="mini-row"><div class="mini-label" title="${esc(row.name)}">${esc(row.name)}</div><div class="mini-track"><div class="mini-fill" style="width:${100 * row.n / maximum}%"></div></div><div class="mini-value">${fmt(row.n)}</div></div>`).join("")}</div>`
    : `<div class="empty-chart">No synthetic-zone records match the current view.</div>`;
}

function activeInfrastructureFlows() {
  return currentBaseFlows.filter(flow => INFRASTRUCTURE_SUBJECTS.has(flow.parts[0]));
}

function renderInfrastructureMatrix() {
  const flows = activeInfrastructureFlows();
  const container = $("#matrixContainer");
  $("#matrixLensLabel").textContent = state.lens === "all"
    ? "Infrastructure subset within all reports"
    : LENS_META[state.lens].label;
  if (!flows.length) {
    container.innerHTML = `<div class="empty-chart">No infrastructure chains match the active filters.</div>`;
    $("#matrixInterpretation").textContent = "Change the analysis lens or clear the cause filter to restore infrastructure pathways.";
    return;
  }

  const subjectTotals = new Map();
  const outcomeTotals = new Map();
  const cells = new Map();
  flows.forEach(flow => {
    const [subject, , target, resultState] = flow.parts;
    const key = outcomeKey(target, resultState);
    subjectTotals.set(subject, (subjectTotals.get(subject) || 0) + flow.n);
    if (!outcomeTotals.has(key)) outcomeTotals.set(key, { key, target, resultState, n: 0 });
    outcomeTotals.get(key).n += flow.n;
    const cellKey = `${subject}|||${key}`;
    cells.set(cellKey, (cells.get(cellKey) || 0) + flow.n);
  });
  const subjects = [...subjectTotals.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
  const outcomes = [...outcomeTotals.values()].sort((a, b) => b.n - a.n).slice(0, 8);
  const total = flows.reduce((sum, flow) => sum + flow.n, 0);
  const populated = [];
  const header = outcomes.map(outcome => `<th title="${esc(outcomeLabel(outcome.target, outcome.resultState))}">${esc(outcomeLabel(outcome.target, outcome.resultState))}</th>`).join("") + `<th title="All complete outcomes outside the eight leading columns">Other outcomes</th>`;
  const body = subjects.map(([subject, rowTotal]) => {
    let visibleN = 0;
    const rowCells = outcomes.map(outcome => {
      const n = cells.get(`${subject}|||${outcome.key}`) || 0;
      if (!n) return `<td class="matrix-cell empty">&middot;</td>`;
      visibleN += n;
      const share = n / rowTotal;
      const alpha = .08 + .78 * Math.sqrt(share);
      populated.push({ subject, target: outcome.target, resultState: outcome.resultState, n, share });
      return `<td class="matrix-cell" data-subject="${esc(subject)}" data-target="${esc(outcome.target)}" data-result-state="${esc(outcome.resultState)}" style="background:rgba(47,128,120,${alpha.toFixed(3)});color:${alpha > .55 ? "#fff" : "#23332f"}" title="${esc(human(subject))} ${ARROW} ${esc(outcomeLabel(outcome.target, outcome.resultState))} ${DOT} n=${fmt(n)} ${DOT} ${pct(share)} of cause"><b>${fmt(n)}</b><span>${esc(matrixPct(share))}</span></td>`;
    }).join("");
    const otherN = Math.max(0, rowTotal - visibleN);
    const otherShare = otherN / rowTotal;
    const otherAlpha = .08 + .62 * Math.sqrt(otherShare);
    const otherCell = otherN
      ? `<td class="matrix-cell matrix-other" style="background:rgba(183,142,47,${otherAlpha.toFixed(3)})" title="All other outcomes for ${esc(human(subject))} ${DOT} n=${fmt(otherN)} ${DOT} ${pct(otherShare)} of cause"><b>${fmt(otherN)}</b><span>${esc(matrixPct(otherShare))}</span></td>`
      : `<td class="matrix-cell empty">&mdash;</td>`;
    return `<tr><td class="matrix-row-label">${esc(human(subject))}<br><small>n=${fmt(rowTotal)}</small></td>${rowCells}${otherCell}</tr>`;
  }).join("");
  container.innerHTML = `<table class="causal-matrix"><thead><tr><th>Infrastructure cause</th>${header}</tr></thead><tbody>${body}</tbody></table>`;

  const dominant = [...populated].sort((a, b) => b.n - a.n)[0];
  $("#matrixInterpretation").innerHTML = `<ul><li>The matrix summarises <b>${fmt(total)}</b> infrastructure relations across <b>${fmt(subjectTotals.size)}</b> causes and <b>${fmt(outcomeTotals.size)}</b> complete outcomes.</li><li>${dominant ? `Largest named cell: <b>${esc(human(dominant.subject))} ${ARROW} ${esc(outcomeLabel(dominant.target, dominant.resultState))}</b> (n=${fmt(dominant.n)}).` : "No populated cell is visible."}</li><li>Each row totals 100%: eight leading outcomes plus an “Other outcomes” remainder. Colour remains normalised within each row.</li></ul>`;
  $$(".matrix-cell:not(.empty):not(.matrix-other)", container).forEach(cell => {
    cell.onclick = () => {
      if (state.lens === "all") state.lens = "infrastructure";
      const subject = cell.dataset.subject;
      const target = cell.dataset.target;
      const resultState = cell.dataset.resultState;
      state.selection = {
        kind: "pattern",
        subject,
        target,
        resultState,
        label: `${human(subject)} ${ARROW} ${outcomeLabel(target, resultState)}`
      };
      state.causeFocus = subject;
      state.outcomeFocus = outcomeKey(target, resultState);
      refreshSubjectOptions();
      syncControls();
      renderAll();
    };
  });
}

function impactPatternLabel(fields) {
  const ordered = [fields.resultState, fields.target, fields.verb, fields.subject].filter(Boolean).map(human);
  return `Impact-first: ${ordered.join(` ${ARROW} `)}`;
}

function selectImpactPattern(fields) {
  if (state.lens === "all") state.lens = "infrastructure";
  state.selection = { kind: "pattern", ...fields, label: impactPatternLabel(fields) };
  if (fields.subject) state.causeFocus = fields.subject;
  if (fields.target && fields.resultState) state.outcomeFocus = outcomeKey(fields.target, fields.resultState);
  if (fields.resultState) state.impactState = fields.resultState;
  refreshSubjectOptions();
  syncControls();
  renderAll();
}

function impactFieldForLayer(layer, label) {
  return [
    { resultState: label },
    { target: label },
    { verb: label },
    { subject: label }
  ][layer];
}

function renderImpactNetwork() {
  const baseFlows = currentBaseFlows
    .filter(flow => PRIORITY_STATES.has(flow.parts[3]))
    .filter(flow => !state.impactState || flow.parts[3] === state.impactState)
    .sort((a, b) => b.n - a.n)
    .slice(0, state.topN);
  currentImpactFlows = baseFlows;
  const svg = $("#networkSvg");
  const width = svg.clientWidth || 1200;
  const height = svg.clientHeight || 640;
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.innerHTML = "";
  if (!baseFlows.length) {
    $("#networkInterpretation").textContent = "No priority outcomes match the active filters.";
    $("#networkModeLabel").textContent = `Impact-first ${DOT} no matching pathways`;
    return;
  }

  const columns = ["Resulting state", "Affected function", "Mechanism", "Reported cause"];
  const reversed = baseFlows.map(flow => ({ base: flow, parts: [flow.parts[3], flow.parts[2], flow.parts[1], flow.parts[0]], n: flow.n }));
  const nodeMaps = columns.map(() => new Map());
  const edgeMaps = columns.slice(1).map(() => new Map());
  reversed.forEach(flow => {
    const active = selectionMatchesBase(flow.base.parts);
    flow.parts.forEach((label, layer) => {
      if (!nodeMaps[layer].has(label)) nodeMaps[layer].set(label, { label, n: 0, active: false });
      const node = nodeMaps[layer].get(label);
      node.n += flow.n;
      if (active) node.active = true;
    });
    for (let layer = 0; layer < 3; layer += 1) {
      const key = `${flow.parts[layer]}|||${flow.parts[layer + 1]}`;
      if (!edgeMaps[layer].has(key)) edgeMaps[layer].set(key, { from: flow.parts[layer], to: flow.parts[layer + 1], n: 0, active: false });
      const edge = edgeMaps[layer].get(key);
      edge.n += flow.n;
      if (active) edge.active = true;
    }
  });

  const padLeft = 115, padRight = 115, top = 52, bottom = 20, gap = 9;
  const nodeWidth = Math.min(190, Math.max(145, (width - padLeft - padRight) / 4 * .58));
  const xs = columns.map((_, index) => padLeft + index * ((width - padLeft - padRight) / 3));
  const layers = nodeMaps.map((map, layer) => [...map.values()].sort((a, b) => b.n - a.n).slice(0, layer === 3 ? 13 : 10));
  const positions = layers.map((nodes, layer) => {
    const available = height - top - bottom;
    const nodeHeight = Math.min(40, Math.max(24, (available - gap * (nodes.length - 1)) / Math.max(1, nodes.length)));
    const map = new Map();
    nodes.forEach((node, index) => map.set(node.label, { x: xs[layer] - nodeWidth / 2, y: top + index * (nodeHeight + gap), w: nodeWidth, h: nodeHeight, node }));
    return map;
  });
  columns.forEach((label, index) => svg.insertAdjacentHTML("beforeend", `<text class="impactColLabel" x="${xs[index]}" y="22" text-anchor="middle">${esc(label)}</text>`));
  const maximumEdge = Math.max(1, ...edgeMaps.flatMap(map => [...map.values()].map(edge => edge.n)));
  edgeMaps.forEach((map, layer) => [...map.values()].sort((a, b) => a.n - b.n).forEach(edge => {
    const from = positions[layer].get(edge.from), to = positions[layer + 1].get(edge.to);
    if (!from || !to) return;
    const x1 = from.x + from.w, y1 = from.y + from.h / 2, x2 = to.x, y2 = to.y + to.h / 2, middle = (x1 + x2) / 2;
    svg.insertAdjacentHTML("beforeend", `<path class="impactEdge ${state.selection && !edge.active ? "dim" : ""}" data-layer="${layer}" data-from="${esc(edge.from)}" data-to="${esc(edge.to)}" d="M ${x1} ${y1} C ${middle} ${y1}, ${middle} ${y2}, ${x2} ${y2}" stroke-width="${1.3 + 12 * Math.sqrt(edge.n / maximumEdge)}"><title>${esc(human(edge.from))} ${ARROW} ${esc(human(edge.to))} ${DOT} n=${fmt(edge.n)}</title></path>`);
  }));
  positions.forEach((map, layer) => [...map.values()].forEach(item => {
    const lines = wrapLabel(item.node.label, 19, 2), lineHeight = 10;
    const textY = item.y + item.h / 2 - ((lines.length - 1) * lineHeight) / 2 + 3;
    svg.insertAdjacentHTML("beforeend", `<g class="impactNode ${state.selection && !item.node.active ? "dim" : ""}" data-layer="${layer}" data-label="${esc(item.node.label)}"><rect x="${item.x}" y="${item.y}" rx="7" width="${item.w}" height="${item.h}"></rect><text x="${item.x + 7}" y="${textY}">${lines.map((line, index) => `<tspan x="${item.x + 7}" dy="${index ? lineHeight : 0}">${esc(line)}</tspan>`).join("")}</text><text x="${item.x + item.w - 7}" y="${item.y + item.h - 6}" text-anchor="end">${fmt(item.node.n)}</text><title>${esc(human(item.node.label))} ${DOT} n=${fmt(item.node.n)}</title></g>`);
  }));

  $$(".impactNode", svg).forEach(node => node.onclick = () => selectImpactPattern(impactFieldForLayer(Number(node.dataset.layer), node.dataset.label)));
  $$(".impactEdge", svg).forEach(edge => edge.onclick = () => selectImpactPattern({
    ...impactFieldForLayer(Number(edge.dataset.layer), edge.dataset.from),
    ...impactFieldForLayer(Number(edge.dataset.layer) + 1, edge.dataset.to)
  }));

  const total = baseFlows.reduce((sum, flow) => sum + flow.n, 0);
  const topFlow = baseFlows[0];
  $("#networkInterpretation").innerHTML = `<ul><li><b>${fmt(baseFlows.length)}</b> priority pathways account for <b>${fmt(total)}</b> reports in this impact-first view.</li><li>Largest pathway: <b>${esc(topFlow.label)}</b> (n=${fmt(topFlow.n)}).</li><li>Read left-to-right from an important result back to the reported causes in the active <b>${esc(LENS_META[state.lens].label)}</b> lens.</li></ul>`;
  $("#networkModeLabel").textContent = `Impact-first ${DOT} ${state.impactState ? human(state.impactState) : "priority outcomes"}`;
}

function renderTable(allFlows) {
  const filteredN = allFlows.reduce((sum, row) => sum + row.n, 0);
  const active = state.selection?.kind === "chain" ? state.selection.id : "";
  $("#chainsBody").innerHTML = allFlows.slice(0, 50).map((flow, index) =>
    `<tr class="${active === flow.id ? "active" : ""}" data-id="${esc(flow.id)}"><td>${index + 1}</td><td>${esc(flow.label)}</td><td><b>${fmt(flow.n)}</b></td><td>${pct(flow.n / Math.max(1, filteredN))}</td></tr>`
  ).join("");
  $$("#chainsBody tr").forEach(row => {
    row.onclick = () => {
      const flow = allFlows.find(candidate => candidate.id === row.dataset.id);
      state.selection = {
        kind: "chain",
        id: flow.id,
        label: flow.label,
        parts: flow.parts,
        level: state.level
      };
      syncBranchFocusFromSelection();
      renderAll();
    };
  });
  $("#tableNote").textContent = `${fmt(allFlows.length)} matching flows`;
}

function renderAll() {
  const allFlows = computeFlows();
  renderCards(allFlows);
  renderNetwork();
  renderSelectionSummary();
  renderInfrastructureMatrix();
  renderBranching();
  renderMap();
  renderTrend();
  renderTable(allFlows);
}

function resetDashboard() {
  Object.assign(state, {
    lens: "infrastructure",
    level: "2",
    subject: "",
    target: "",
    borough: "",
    month: "",
    topN: 25,
    networkDirection: "cause",
    selection: null,
    causeFocus: "",
    outcomeFocus: "",
    impactState: ""
  });
  refreshSubjectOptions();
  syncControls();
  renderAll();
}

function wireControls() {
  const controls = {
    lensFilter: "lens",
    levelFilter: "level",
    subjectFilter: "subject",
    targetFilter: "target",
    boroughFilter: "borough",
    monthFilter: "month",
    topNFilter: "topN"
  };
  Object.entries(controls).forEach(([id, key]) => {
    $(`#${id}`).onchange = event => {
      state[key] = key === "topN" ? Number(event.target.value) : event.target.value;
      if (key === "lens") {
        state.subject = "";
        refreshSubjectOptions();
        syncControls();
      }
      state.selection = null;
      state.causeFocus = "";
      state.outcomeFocus = "";
      renderAll();
    };
  });
  $("#impactStateFilter").onchange = event => {
    state.impactState = event.target.value;
    state.selection = null;
    renderAll();
  };
  $("#networkDirectionFilter").onchange = event => {
    state.networkDirection = event.target.value;
    if (state.networkDirection === "impact") state.level = "2";
    state.selection = null;
    state.impactState = "";
    syncControls();
    renderAll();
  };
  $("#resetButton").onclick = resetDashboard;
  $("#clearSelection").onclick = () => {
    state.selection = null;
    renderAll();
  };
  $("#causeFocus").onchange = event => {
    state.causeFocus = event.target.value;
    renderBranching();
  };
  $("#outcomeFocus").onchange = event => {
    state.outcomeFocus = event.target.value;
    renderBranching();
  };
  window.addEventListener("resize", () => {
    clearTimeout(window.__resizeTimer);
    window.__resizeTimer = setTimeout(() => {
      renderNetwork();
      renderMap();
      renderTrend();
    }, 100);
  });
}

function syncControls() {
  $("#lensFilter").value = state.lens;
  $("#levelFilter").value = state.level;
  $("#levelFilter").disabled = state.networkDirection === "impact";
  $("#subjectFilter").value = state.subject;
  $("#targetFilter").value = state.target;
  $("#boroughFilter").value = state.borough;
  $("#monthFilter").value = state.month;
  $("#topNFilter").value = String(state.topN);
  $("#networkDirectionFilter").value = state.networkDirection;
  $("#impactStateFilter").value = state.impactState;
  $("#impactStateControl").classList.toggle("hidden", state.networkDirection !== "impact");
}

async function loadRecords() {
  try {
    if (!("DecompressionStream" in window)) throw new Error("This browser does not support gzip streaming.");
    const response = await fetch(RECORD_URL, { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const stream = response.body.pipeThrough(new DecompressionStream("gzip"));
    const payload = JSON.parse(await new Response(stream).text());
    RECORDS = payload.records;
    $("#dataStatus").className = "ready";
    $("#dataStatus").textContent = `Spatial layer ready ${DOT} ${fmt(RECORDS.length)} reports`;
    $("#mapLoading").classList.add("hidden");
    renderAll();
  } catch (error) {
    $("#dataStatus").className = "error";
    $("#dataStatus").textContent = `Spatial layer unavailable ${DOT} ${error.message}`;
    $("#mapLoading").textContent = "Spatial data could not be loaded. Open through a local HTTP server.";
  }
}

async function init() {
  try {
    const response = await fetch(META_URL, { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    DATA = await response.json();
    const d = dict();
    refreshSubjectOptions();
    buildOptions($("#targetFilter"), d.t, "All affected functions", "");
    buildOptions($("#boroughFilter"), [...d.b].sort(), "All synthetic zones", "");
    buildOptions($("#monthFilter"), [...d.m].sort(), "All activity months", "");
    wireControls();
    syncControls();
    renderAll();
    loadRecords();
  } catch (error) {
    $("#dataStatus").className = "error";
    $("#dataStatus").textContent = `Dashboard data unavailable ${DOT} ${error.message}`;
    $("#mapLoading").textContent = "Open this dashboard through a local HTTP server; see README.md.";
  }
}

init();
