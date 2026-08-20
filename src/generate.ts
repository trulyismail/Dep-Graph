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
import { matchDependencies } from "./match.js";

interface Node {
  id: string;
  service?: string;
}
interface Edge {
  from: string;
  to: string;
  label?: string;
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

async function main() {
  const graph = await generate();
  writeFileSync(OUT_PATH, JSON.stringify(graph, null, 2), "utf-8");
  console.error(
    `wrote ${graph.nodes.length} nodes, ${graph.edges.length} edges to ${OUT_PATH}`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
