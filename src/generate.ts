/**
 * Generator entrypoint. Read a toolkit catalog, infer its dependencies, write a graph.
 *
 * How we run it:
 *   - The path to a toolkit's catalog JSON is passed as a CLI ARGUMENT, e.g.
 *     `node --import tsx src/generate.ts path/to/catalog.json`. We append it as the last
 *     argument, so reading the final argv entry works whatever else your command carries.
 *   - Write your graph to `dependency_graph.json` in the working directory (plus
 *     viz/graph.html, a self-contained visualization).
 *   - Fully offline by default. Pass --llm to enable the optional disambiguation pass
 *     (src/llm.ts), which reads AI_API_KEY/AI_BASE_URL/AI_MODEL from the environment or
 *     a local .env — never required otherwise.
 */
import { writeFileSync } from "fs";
import { loadCatalog, normalizeCatalog } from "./catalog.js";
import { classifyCatalog } from "./classify.js";
import { matchDependencies, type Edge } from "./match.js";
import { resolveAmbiguous } from "./llm.js";
import { writeViz } from "./viz.js";

interface Node {
  id: string;
  service: string;
  operation: string;
  requires: { user: string[]; derived: string[] };
}
interface Graph {
  nodes: Node[];
  edges: Edge[];
}

// Catalog path: the last non-flag CLI argument, so `--llm` can appear
// anywhere without being mistaken for it.
const ARGS = process.argv.slice(2);
const LLM_ENABLED = ARGS.includes("--llm");
const CATALOG_PATH = [...ARGS].reverse().find((a) => !a.startsWith("--"));
const OUT_PATH = "dependency_graph.json";

async function generate(): Promise<Graph> {
  if (!CATALOG_PATH) {
    throw new Error("pass the toolkit catalog path as an argument");
  }
  const rawTools = loadCatalog(CATALOG_PATH);
  const normalized = normalizeCatalog(rawTools);
  const classified = classifyCatalog(normalized);

  const nodes: Node[] = classified.map((t) => ({
    id: t.slug,
    service: t.service,
    operation: t.operation,
    requires: { user: [...t.requires.user], derived: [...t.requires.derived] },
  }));
  const { edges, ambiguous } = matchDependencies(classified);

  if (LLM_ENABLED) {
    const { edges: llmEdges, noneParams, requestsMade, approxTokens } = await resolveAmbiguous(ambiguous);
    const existingKeys = new Set(edges.map((e) => `${e.from}|${e.to}|${e.label}`));
    let added = 0;
    for (const e of llmEdges) {
      const key = `${e.from}|${e.to}|${e.label}`;
      if (existingKeys.has(key)) continue;
      existingKeys.add(key);
      edges.push(e);
      added++;
    }
    const byId = new Map(nodes.map((n) => [n.id, n]));
    for (const { consumerSlug, param } of noneParams) {
      const node = byId.get(consumerSlug);
      if (!node) continue;
      node.requires.derived = node.requires.derived.filter((p) => p !== param);
      if (!node.requires.user.includes(param)) node.requires.user.push(param);
    }
    console.error(
      `llm: ${ambiguous.length} ambiguous case(s), ${requestsMade} request(s), ~${approxTokens} tokens, ` +
        `${added} edge(s) added (baseline was ${edges.length - added}), ${noneParams.length} resolved to user_input`,
    );
  }

  return { nodes, edges };
}

/**
 * Sort nodes/edges into a fixed order so identical input always produces a
 * byte-identical file (zero git diff on rerun), independent of catalog
 * array order, Map iteration order, or sort stability quirks.
 */
function sortGraph(graph: Graph): Graph {
  const nodes = [...graph.nodes].sort((a, b) => a.id.localeCompare(b.id));
  const edges = [...graph.edges].sort(
    (a, b) =>
      a.from.localeCompare(b.from) || a.to.localeCompare(b.to) || a.label.localeCompare(b.label),
  );
  return { nodes, edges };
}

function printStats(graph: Graph): void {
  console.error(`nodes: ${graph.nodes.length}`);
  console.error(`edges: ${graph.edges.length}`);

  const labelFreq = new Map<string, number>();
  for (const e of graph.edges) labelFreq.set(e.label, (labelFreq.get(e.label) ?? 0) + 1);
  console.error(`distinct labels: ${labelFreq.size}`);

  const edgeKeys = new Set(graph.edges.map((e) => `${e.to}|${e.label}`));
  let noProducer = 0;
  for (const n of graph.nodes) {
    for (const d of n.requires.derived) {
      if (!edgeKeys.has(`${n.id}|${d}`)) noProducer++;
    }
  }
  console.error(
    `derived params with no producer found: ${noProducer} ` +
      `(genuine "must ask the user" cases — a finding, not a bug)`,
  );

  const top10 = [...labelFreq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
  console.error("top 10 labels:");
  for (const [label, count] of top10) console.error(`  ${label}: ${count}`);
}

async function main() {
  const graph = sortGraph(await generate());
  writeFileSync(OUT_PATH, JSON.stringify(graph, null, 2) + "\n", "utf-8");
  writeViz(graph);
  printStats(graph);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
