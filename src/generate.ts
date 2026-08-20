/**
 * Generator entrypoint. Read a toolkit catalog, infer its dependencies, write a graph.
 *
 * How we run it:
 *   - The path to a toolkit's catalog JSON is passed as a CLI ARGUMENT, e.g.
 *     `node --import tsx src/generate.ts path/to/catalog.json`. We append it as the last
 *     argument, so reading the final argv entry works whatever else your command carries.
 *   - Write your graph to `dependency_graph.json` in the working directory.
 *   - For LLM access, the OpenAI SDK reads OPENAI_API_KEY / OPENAI_BASE_URL from the
 *     environment (set from your assessment page's AI credentials; the same are provided
 *     when we run your generator). Use an OpenRouter model id such as `openai/gpt-4o`.
 */
import { writeFileSync } from "fs";
import { loadCatalog, normalizeCatalog } from "./catalog.js";
import { classifyCatalog } from "./classify.js";
import { matchDependencies, type Edge } from "./match.js";

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

// The catalog path is the last CLI argument (we append it after your run command).
const CATALOG_PATH = process.argv.length > 2 ? process.argv[process.argv.length - 1] : undefined;
const OUT_PATH = "dependency_graph.json";

async function generate(): Promise<Graph> {
  if (!CATALOG_PATH) {
    throw new Error("pass the toolkit catalog path as the first argument");
  }
  const rawTools = loadCatalog(CATALOG_PATH);
  const normalized = normalizeCatalog(rawTools);
  const classified = classifyCatalog(normalized);

  const nodes: Node[] = classified.map((t) => ({
    id: t.slug,
    service: t.service,
    operation: t.operation,
    requires: t.requires,
  }));
  const edges: Edge[] = matchDependencies(classified);
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
  printStats(graph);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
