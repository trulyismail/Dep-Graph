/**
 * Local self-check. Runs your generator on the provided GitHub catalog and reports
 * shape + provenance metrics so you can iterate. Usage: `npm run selfcheck`.
 */
import { readFileSync, existsSync } from "fs";
import { execFileSync } from "child_process";

const CATALOG = "github_catalog.json"; // provided toolkit, ships with your package
const OUT = "dependency_graph.json"; // what your generator writes

if (!existsSync(CATALOG)) {
  console.error(
    `missing ${CATALOG}. It ships with your assessment package; contact your recruiter if it is absent.`,
  );
  process.exit(1);
}

// Run the generator exactly like the grader does: the catalog path is the last arg.
execFileSync("node", ["--import", "tsx", "src/generate.ts", CATALOG], {
  stdio: "inherit",
});

const raw = JSON.parse(readFileSync(CATALOG, "utf-8"));
const tools = Array.isArray(raw) ? raw : (raw.tools ?? []);
const slugs = new Set<string>(
  tools
    .map((t: any) => String(t.slug ?? t.name ?? t.function?.name ?? "").toUpperCase())
    .filter(Boolean),
);

const g = JSON.parse(readFileSync(OUT, "utf-8"));
const nodes = g.nodes ?? [];
const edges = g.edges ?? [];
const inCatalog = nodes.filter((n: any) => slugs.has(String(n.id).toUpperCase())).length;
const provenance = nodes.length ? inCatalog / nodes.length : 0;

console.log(
  JSON.stringify(
    {
      nodes: nodes.length,
      edges: edges.length,
      provenance_ratio: Number(provenance.toFixed(3)),
      labeled_edges: edges.filter((e: any) => e.label).length,
    },
    null,
    2,
  ),
);

if (provenance < 0.8) {
  console.error(
    "WARNING: provenance < 0.8. Your node ids must be slugs from the catalog you were given.",
  );
}
if (edges.length === 0) {
  console.error("WARNING: 0 edges. A graph with no dependencies fails the has-edges gate.");
}
