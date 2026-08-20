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
 *
 * This is a SKELETON. Replace the inference in generate() with your own approach. Do not
 * hardcode a toolkit's relations: your node ids must be slugs from the catalog you are
 * handed, and your output must change when the input changes.
 */
import { readFileSync, writeFileSync } from "fs";

type Tool = Record<string, any>;
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

function loadCatalog(): Tool[] {
  if (!CATALOG_PATH) {
    throw new Error("pass the toolkit catalog path as the first argument");
  }
  const data = JSON.parse(readFileSync(CATALOG_PATH, "utf-8"));
  // getRawComposioTools returns a list of tools (or { tools: [...] }).
  return Array.isArray(data) ? data : (data.tools ?? data.items ?? []);
}

function slugOf(tool: Tool): string | undefined {
  return tool.slug ?? tool.name ?? tool.function?.name;
}

/**
 * TODO: your inference goes here.
 *
 * The baseline below emits every tool as a node and no edges. It passes the
 * "nodes are real slugs" check but scores ~0 on correctness (no dependencies) and
 * will fail the has-edges gate. Replace it: for each tool's required inputs, infer
 * which other tools produce a matching output id/field, and emit those edges.
 * Runtime LLM inference is encouraged. Keep node ids sourced from the catalog you
 * were given.
 */
async function generate(tools: Tool[]): Promise<Graph> {
  const nodes: Node[] = tools
    .map(slugOf)
    .filter((s): s is string => !!s)
    .map((id) => ({ id }));
  const edges: Edge[] = [];
  return { nodes, edges };
}

async function main() {
  const graph = await generate(loadCatalog());
  writeFileSync(OUT_PATH, JSON.stringify(graph, null, 2), "utf-8");
  console.error(
    `wrote ${graph.nodes.length} nodes, ${graph.edges.length} edges to ${OUT_PATH}`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
