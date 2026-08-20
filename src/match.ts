/**
 * Contextual producer -> consumer matching. This is the core inference: for
 * every derived required param on a consumer tool, find which other tools'
 * output fields plausibly supply that value.
 *
 * Naive name===name matching is the documented failure mode here: producers
 * expose generic leaf keys (`number`, `id`) nested in arrays, while
 * consumers ask for qualified ones (`issue_number`, `pull_number`). Matching
 * on the bare key alone wires every list tool to every consumer that needs
 * *any* id. The fix is requiring both the key AND the resource the key
 * belongs to (derived from the param name's prefix) to agree.
 */
import { singularize } from "./catalog.js";
import type { OutputField } from "./catalog.js";
import type { ClassifiedTool } from "./classify.js";

export interface Edge {
  from: string;
  to: string;
  label: string;
  confidence: number;
  evidence: string;
  source: "schema";
}

// Precision over recall (constraint 9): keep few, confidently-correct
// producers rather than every plausible one.
const TOP_K = 2;
// Minimum combined score to keep a candidate. Any candidate that clears the
// key+resource gate starts at 1.0; the -0.5 circular-requirement penalty
// drops a self-referential producer to 0.5, which this threshold excludes.
const THRESHOLD = 0.6;

/** Lowercase, split on non-alphanumerics, singularize each piece. */
function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .map(singularize);
}

/**
 * Split a derived param name into (resourceHint, key): `pull_number` ->
 * ("pull", "number"). A bare key with no prefix (`number`, `sha`) has
 * nothing to split, so it inherits the consumer's own service as the hint —
 * "this tool's own resource is presumably what the bare id refers to".
 */
function splitDerivedParam(
  paramName: string,
  consumerService: string,
): { resourceHint: string; key: string } {
  const idx = paramName.lastIndexOf("_");
  if (idx === -1) return { resourceHint: consumerService, key: paramName };
  return { resourceHint: paramName.slice(0, idx), key: paramName.slice(idx + 1) };
}

interface ProducerField {
  tool: ClassifiedTool;
  field: OutputField;
}

function buildFieldIndex(tools: ClassifiedTool[]): Map<string, ProducerField[]> {
  const index = new Map<string, ProducerField[]>();
  for (const tool of tools) {
    for (const field of tool.outputFields) {
      const key = singularize(field.name.toLowerCase());
      const bucket = index.get(key);
      if (bucket) bucket.push({ tool, field });
      else index.set(key, [{ tool, field }]);
    }
  }
  return index;
}

interface ScoredCandidate extends ProducerField {
  score: number;
  rules: string[];
}

/**
 * The path segment naming the array itself (e.g. "issues" in
 * "data.issues[].number") — the closest array boundary to the leaf, so a
 * nested array further down wins over an outer one. This is what a list
 * tool actually enumerates, which is a sharper signal than the tool's
 * overall `service`: an "issue events" tool has service "issues" too (it's
 * issue-related) but its array elements are events, not issues.
 */
function arrayBoundaryTokens(path: string): Set<string> | undefined {
  const segments = path.split(".");
  for (let i = segments.length - 1; i >= 0; i--) {
    const seg = segments[i]!;
    if (seg.endsWith("[]")) return new Set(tokenize(seg.slice(0, -2)));
  }
  return undefined;
}

function scoreCandidate(
  paramName: string,
  resourceTokens: Set<string>,
  producer: ClassifiedTool,
  field: OutputField,
): { score: number; rules: string[] } | undefined {
  const serviceTokens = tokenize(producer.service);
  const serviceMatches = serviceTokens.some((t) => resourceTokens.has(t));

  let primaryMatch: string | undefined;
  if (field.inArray) {
    // A list tool's array might enumerate something other than the
    // resource it's tagged with (issue *events*, not issues) — require the
    // array's own element type to match, not just anything on the path.
    const boundary = arrayBoundaryTokens(field.path);
    if (boundary && [...boundary].some((t) => resourceTokens.has(t))) {
      primaryMatch = "resource:array-element";
    }
  } else {
    if (serviceMatches) {
      primaryMatch = "resource:service";
    } else {
      const pathTokens = tokenize(field.path);
      if (pathTokens.some((t) => resourceTokens.has(t))) primaryMatch = "resource:path";
    }
  }
  if (!primaryMatch) return undefined; // candidacy gate (b)

  let score = 1.0; // key + resource both match
  const rules = [primaryMatch];

  if (field.inArray) {
    score += 0.4;
    rules.push("+0.4 array");
  }
  if (producer.operation === "read") {
    score += 0.3;
    rules.push("+0.3 read");
  } else if (producer.operation === "create") {
    score += 0.2;
    rules.push("+0.2 create");
  }
  // Corroboration: the producer's own declared purpose also agrees with
  // the resource hint, not just this one field's placement. Breaks ties in
  // favor of the canonical/unfiltered list tool over scoped variants (e.g.
  // "list repository issues" over "list issues assigned to me").
  if (serviceMatches && primaryMatch !== "resource:service") {
    score += 0.1;
    rules.push("+0.1 service-corroboration");
  }
  if (producer.requires.derived.includes(paramName)) {
    score -= 0.5;
    rules.push("-0.5 circular");
  }

  return { score, rules };
}

export function matchDependencies(tools: ClassifiedTool[]): Edge[] {
  const index = buildFieldIndex(tools);
  const edges: Edge[] = [];

  for (const consumer of tools) {
    for (const paramName of consumer.requires.derived) {
      const { resourceHint, key } = splitDerivedParam(paramName, consumer.service);
      const resourceTokens = new Set(tokenize(resourceHint));
      const candidates = index.get(singularize(key.toLowerCase())) ?? [];

      // Dedupe to one candidate per producer tool (its best-scoring field),
      // so a producer can never contribute two edges for the same
      // (consumer, param) — that would violate the no-duplicate-triple
      // invariant checked in Phase 5.
      const byProducer = new Map<string, ScoredCandidate>();
      for (const { tool: producer, field } of candidates) {
        if (producer.slug === consumer.slug) continue; // hard: no self-edges, ever
        const result = scoreCandidate(paramName, resourceTokens, producer, field);
        if (!result) continue;
        const existing = byProducer.get(producer.slug);
        if (!existing || result.score > existing.score) {
          byProducer.set(producer.slug, { tool: producer, field, ...result });
        }
      }

      const kept = [...byProducer.values()]
        .sort((a, b) => b.score - a.score)
        .filter((c) => c.score >= THRESHOLD)
        .slice(0, TOP_K);

      for (const c of kept) {
        edges.push({
          from: c.tool.slug,
          to: consumer.slug,
          label: paramName,
          confidence: Math.min(1, Math.max(0, c.score)),
          evidence: `${c.field.path} (${c.rules.join(", ")})`,
          source: "schema",
        });
      }
    }
  }

  return edges;
}
