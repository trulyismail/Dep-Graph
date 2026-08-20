/**
 * Writes viz/graph.html: a single self-contained file with the graph data
 * inlined as `const GRAPH = {...}` (opened via file://, so fetch() of a
 * local JSON would be CORS-blocked — inlining sidesteps that entirely).
 */
import { writeFileSync, mkdirSync } from "fs";
import { dirname } from "path";

interface Node {
  id: string;
  service: string;
}
interface Edge {
  from: string;
  to: string;
  label: string;
  confidence?: number;
}
interface Graph {
  nodes: Node[];
  edges: Edge[];
}

/** Deterministic hash -> HSL color per service, no fixed toolkit-specific palette. */
function colorFor(service: string): string {
  let hash = 0;
  for (let i = 0; i < service.length; i++) hash = (hash * 31 + service.charCodeAt(i)) >>> 0;
  return `hsl(${hash % 360}, 65%, 55%)`;
}

export function renderVizHtml(graph: Graph): string {
  const services = [...new Set(graph.nodes.map((n) => n.service))].sort();
  const colorMap = Object.fromEntries(services.map((s) => [s, colorFor(s)]));

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>Dependency Graph</title>
<script src="https://unpkg.com/vis-network@9/standalone/umd/vis-network.min.js"></script>
<style>
  html, body { margin: 0; height: 100%; font-family: system-ui, sans-serif; background: #0f1115; color: #e6e6e6; }
  #header { padding: 10px 14px; background: #171a21; border-bottom: 1px solid #2a2e39; display: flex; gap: 14px; align-items: center; flex-wrap: wrap; }
  #header h1 { font-size: 15px; margin: 0; font-weight: 600; }
  #stats { font-size: 12px; color: #9aa0ab; }
  select, input[type=text] { background: #20242e; color: #e6e6e6; border: 1px solid #3a3f4b; border-radius: 4px; padding: 5px 8px; font-size: 12px; }
  label { font-size: 12px; color: #cfd3da; display: flex; align-items: center; gap: 5px; }
  #network { position: absolute; top: 48px; left: 0; right: 0; bottom: 0; }
</style>
</head>
<body>
<div id="header">
  <h1>Tool Dependency Graph</h1>
  <span id="stats"></span>
  <label>Service: <select id="serviceFilter"><option value="">All</option></select></label>
  <label>Search: <input type="text" id="search" placeholder="slug contains..."></label>
  <label><input type="checkbox" id="hideIsolated" checked> Hide isolated nodes</label>
</div>
<div id="network"></div>
<script>
const GRAPH = ${JSON.stringify(graph)};
const COLORS = ${JSON.stringify(colorMap)};

const connected = new Set();
for (const e of GRAPH.edges) { connected.add(e.from); connected.add(e.to); }

const allNodes = new vis.DataSet(GRAPH.nodes.map(n => ({
  id: n.id, label: n.id, group: n.service,
  color: COLORS[n.service] || "#888",
  title: n.id + " (" + n.service + ")",
  _isolated: !connected.has(n.id),
})));
const allEdges = new vis.DataSet(GRAPH.edges.map((e, i) => ({
  id: i, from: e.from, to: e.to, label: "",
  title: e.label + (e.confidence !== undefined ? " (conf " + e.confidence + ")" : ""),
  arrows: "to", font: { size: 0 }, _label: e.label,
})));

const container = document.getElementById("network");
const network = new vis.Network(container, { nodes: allNodes, edges: allEdges }, {
  physics: { stabilization: true, barnesHut: { gravitationalConstant: -12000, springLength: 120 } },
  nodes: { shape: "dot", size: 10, font: { color: "#e6e6e6", size: 11 } },
  edges: { color: { color: "#4a4f5b", highlight: "#e6b800" }, smooth: { type: "continuous" } },
  interaction: { hover: true },
});

network.on("hoverEdge", (params) => {
  const e = allEdges.get(params.edge);
  allEdges.update({ id: params.edge, font: { size: 12, color: "#ffd166" }, label: e._label });
});
network.on("blurEdge", (params) => {
  const e = allEdges.get(params.edge);
  allEdges.update({ id: params.edge, font: { size: 0 }, label: "" });
});

const serviceSelect = document.getElementById("serviceFilter");
for (const s of ${JSON.stringify(services)}) {
  const opt = document.createElement("option");
  opt.value = s; opt.textContent = s + " (" + GRAPH.nodes.filter(n => n.service === s).length + ")";
  serviceSelect.appendChild(opt);
}

const searchBox = document.getElementById("search");
const hideIsolatedBox = document.getElementById("hideIsolated");

function applyFilters() {
  const service = serviceSelect.value;
  const query = searchBox.value.trim().toLowerCase();
  const hideIsolated = hideIsolatedBox.checked;

  const visibleIds = new Set();
  const updates = GRAPH.nodes.map(n => {
    let visible = true;
    if (service && n.service !== service) visible = false;
    if (query && !n.id.toLowerCase().includes(query)) visible = false;
    if (hideIsolated && !connected.has(n.id)) visible = false;
    if (visible) visibleIds.add(n.id);
    return { id: n.id, hidden: !visible };
  });
  allNodes.update(updates);

  allEdges.update(GRAPH.edges.map((e, i) => ({
    id: i, hidden: !(visibleIds.has(e.from) && visibleIds.has(e.to)),
  })));

  const shown = updates.filter(u => !u.hidden).length;
  document.getElementById("stats").textContent =
    shown + " / " + GRAPH.nodes.length + " nodes shown · " + GRAPH.edges.length + " edges total";
}

serviceSelect.addEventListener("change", applyFilters);
searchBox.addEventListener("input", applyFilters);
hideIsolatedBox.addEventListener("change", applyFilters);
applyFilters();
</script>
</body>
</html>
`;
}

export function writeViz(graph: Graph, outPath = "viz/graph.html"): void {
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, renderVizHtml(graph), "utf-8");
}
