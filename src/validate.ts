/**
 * Validation, wired into `npm run selfcheck`: golden assertions on the real
 * catalog, shape invariants, a generalization proof against a synthetic
 * toolkit (fixtures/mini_toolkit.json, run through the generator with zero
 * code changes), and the no-hardcoded-toolkit-literal grep test.
 */
import { existsSync, readFileSync } from "fs";
import { execFileSync } from "child_process";

const GITHUB_CATALOG = "github_catalog.json";
const MINI_CATALOG = "fixtures/mini_toolkit.json";
const OUT_PATH = "dependency_graph.json";
// Matching logic only — deliberately excludes validate.ts itself, which
// legitimately names golden GITHUB_* slugs as test fixtures, not logic.
const MATCHING_LOGIC_FILES = ["src/catalog.ts", "src/classify.ts", "src/match.ts"];

interface Node {
  id: string;
  service: string;
  requires: { user: string[]; derived: string[] };
}
interface Edge {
  from: string;
  to: string;
  label: string;
}
interface Graph {
  nodes: Node[];
  edges: Edge[];
}

let passes = 0;
let failures = 0;

function check(name: string, ok: boolean, detail?: string): void {
  if (ok) {
    passes++;
    console.error(`PASS  ${name}`);
  } else {
    failures++;
    console.error(`FAIL  ${name}${detail ? " — " + detail : ""}`);
  }
}

function runGenerator(catalogPath: string): Graph {
  execFileSync("node", ["--import", "tsx", "src/generate.ts", catalogPath], { stdio: "pipe" });
  return JSON.parse(readFileSync(OUT_PATH, "utf-8"));
}

/** Levenshtein edit distance, used only to report a closest-match slug on failure. */
function levenshtein(a: string, b: string): number {
  const dp: number[][] = [];
  for (let i = 0; i <= a.length; i++) dp.push(new Array(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i++) dp[i]![0] = i;
  for (let j = 0; j <= b.length; j++) dp[0]![j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i]![j] =
        a[i - 1] === b[j - 1]
          ? dp[i - 1]![j - 1]!
          : 1 + Math.min(dp[i - 1]![j]!, dp[i]![j - 1]!, dp[i - 1]![j - 1]!);
    }
  }
  return dp[a.length]![b.length]!;
}

function closestSlug(target: string, candidates: string[]): string {
  let best = candidates[0] ?? "(catalog has no nodes)";
  let bestDist = Infinity;
  for (const c of candidates) {
    const d = levenshtein(target, c);
    if (d < bestDist) {
      bestDist = d;
      best = c;
    }
  }
  return best;
}

/** Never silently weakens the assertion: a missing slug is still a FAIL, just with a hint. */
function assertGoldenChain(graph: Graph, from: string, to: string, label: string): void {
  const nodeIds = graph.nodes.map((n) => n.id);
  const name = `golden chain: ${from} --${label}--> ${to}`;

  if (!nodeIds.includes(from)) {
    check(name, false, `producer "${from}" not in catalog; closest match: "${closestSlug(from, nodeIds)}"`);
    return;
  }
  if (!nodeIds.includes(to)) {
    check(name, false, `consumer "${to}" not in catalog; closest match: "${closestSlug(to, nodeIds)}"`);
    return;
  }
  const exists = graph.edges.some((e) => e.from === from && e.to === to && e.label === label);
  check(name, exists, exists ? undefined : "edge missing from generated graph");
}

function assertShapeInvariants(graph: Graph): void {
  const nodeIds = new Set(graph.nodes.map((n) => n.id));

  const dangling = graph.edges.filter((e) => !nodeIds.has(e.from) || !nodeIds.has(e.to));
  check(
    "every edge resolves to a real node",
    dangling.length === 0,
    dangling.length ? `${dangling.length} dangling edge(s)` : undefined,
  );

  const selfEdges = graph.edges.filter((e) => e.from === e.to);
  check(
    "no self-edges",
    selfEdges.length === 0,
    selfEdges.length ? `${selfEdges.length}: ${selfEdges.slice(0, 3).map((e) => e.from).join(", ")}` : undefined,
  );

  const seen = new Set<string>();
  let dupes = 0;
  for (const e of graph.edges) {
    const key = `${e.from}|${e.to}|${e.label}`;
    if (seen.has(key)) dupes++;
    seen.add(key);
  }
  check("no duplicate (from,to,label) triples", dupes === 0, dupes ? `${dupes} duplicate(s)` : undefined);

  const emptyService = graph.nodes.filter((n) => !n.service || !n.service.trim());
  check(
    "every node has a non-empty service",
    emptyService.length === 0,
    emptyService.length ? `${emptyService.length}: ${emptyService.slice(0, 3).map((n) => n.id).join(", ")}` : undefined,
  );
}

/** Same code, zero changes, a different toolkit's vocabulary — this is the evidence it's not GitHub-shaped. */
function assertGeneralization(graph: Graph): void {
  check("mini_toolkit: all 6 nodes present", graph.nodes.length === 6, `got ${graph.nodes.length}`);

  const has = (from: string, to: string, label: string) =>
    graph.edges.some((e) => e.from === from && e.to === to && e.label === label);

  check(
    "mini_toolkit: TASKR_LIST_PROJECTS --project_id--> TASKR_ARCHIVE_PROJECT",
    has("TASKR_LIST_PROJECTS", "TASKR_ARCHIVE_PROJECT", "project_id"),
  );
  check(
    "mini_toolkit: TASKR_LIST_TASKS --task_id--> TASKR_ADD_TASK_COMMENT",
    has("TASKR_LIST_TASKS", "TASKR_ADD_TASK_COMMENT", "task_id"),
  );
}

function assertNoHardcodedToolkitLiterals(): void {
  const offenders: string[] = [];
  for (const file of MATCHING_LOGIC_FILES) {
    const text = readFileSync(file, "utf-8");
    const matches = text.match(/GITHUB(_[A-Z]+)*/g);
    if (matches) offenders.push(`${file}: ${[...new Set(matches)].join(", ")}`);
  }
  check(
    "no hardcoded GITHUB/GITHUB_... literals in matching logic",
    offenders.length === 0,
    offenders.length ? offenders.join("; ") : undefined,
  );
}

function main(): void {
  if (!existsSync(GITHUB_CATALOG)) {
    console.error(`missing ${GITHUB_CATALOG}. It ships with your assessment package.`);
    process.exit(1);
  }
  if (!existsSync(MINI_CATALOG)) {
    console.error(`missing ${MINI_CATALOG}.`);
    process.exit(1);
  }

  console.error(`=== ${GITHUB_CATALOG}: golden chains + shape invariants ===`);
  const githubGraph = runGenerator(GITHUB_CATALOG);
  assertGoldenChain(githubGraph, "GITHUB_LIST_REPOSITORY_ISSUES", "GITHUB_CREATE_AN_ISSUE_COMMENT", "issue_number");
  assertGoldenChain(githubGraph, "GITHUB_LIST_PULL_REQUESTS", "GITHUB_MERGE_A_PULL_REQUEST", "pull_number");
  assertShapeInvariants(githubGraph);

  console.error(`\n=== ${MINI_CATALOG}: generalization (zero code changes) ===`);
  const miniGraph = runGenerator(MINI_CATALOG);
  assertGeneralization(miniGraph);

  console.error(`\n=== source: no hardcoded toolkit literals ===`);
  assertNoHardcodedToolkitLiterals();

  // Leave dependency_graph.json reflecting the real deliverable catalog,
  // not whatever the last internal run happened to be.
  runGenerator(GITHUB_CATALOG);

  console.error(`\n${passes} passed, ${failures} failed`);
  if (failures > 0) process.exit(1);
}

main();
