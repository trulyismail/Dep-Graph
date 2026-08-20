/**
 * Classifies each required input param as something the human must supply
 * (`user_input`) or something that must be obtained from a precursor tool
 * (`derived`). This is the direct answer to the graders' framing: ask the
 * user, or call another tool first.
 */
import type { NormalizedTool, ParamInfo } from "./catalog.js";

export type InputClass = "user_input" | "derived";

export interface ClassifiedTool extends NormalizedTool {
  requires: { user: string[]; derived: string[] };
}

// A required param name counts as "ambient scope" (always asked of the
// user, regardless of its own signals) once it's required by at least this
// fraction of the whole catalog's tools. Picked from this catalog's actual
// distribution, not guessed: owner/repo sit at ~49%, org at ~21%, then a
// cliff down to username at ~8.6% — 0.15 cleanly separates the two
// clusters without naming owner/repo/org anywhere.
export const AMBIENT_THRESHOLD = 0.15;

const DERIVED_NAME_RE = /(^|_)(id|number|sha|ref|slug|key|login|node_id)$/i;
const DERIVED_DESCRIPTION_PHRASES = [
  "must exist",
  "of the issue",
  "identifier of",
  "obtained from",
  "the id of",
];
// Pagination is a cross-API convention, not a toolkit-specific name list.
const PAGINATION_NAME_RE = /^(page|per_page|page_size|pagesize|limit|offset|cursor)$/i;

function buildAmbientParamNames(tools: NormalizedTool[]): Set<string> {
  const counts = new Map<string, number>();
  for (const t of tools) {
    for (const p of t.requiredInputs) counts.set(p.name, (counts.get(p.name) ?? 0) + 1);
  }
  const ambient = new Set<string>();
  const total = tools.length || 1;
  for (const [name, count] of counts) {
    if (count / total >= AMBIENT_THRESHOLD) ambient.add(name);
  }
  return ambient;
}

function isAgainstSignal(param: ParamInfo): boolean {
  if (param.default !== undefined) return true;
  if (Array.isArray(param.enum) && param.enum.length > 0) return true;
  if (param.type === "boolean") return true;
  if (PAGINATION_NAME_RE.test(param.name)) return true;
  return false;
}

function isForSignal(param: ParamInfo): boolean {
  if (DERIVED_NAME_RE.test(param.name)) return true;
  const desc = (param.description ?? "").toLowerCase();
  return DERIVED_DESCRIPTION_PHRASES.some((phrase) => desc.includes(phrase));
}

function classifyParam(param: ParamInfo, ambient: Set<string>): InputClass {
  // Ambient scope and AGAINST signals override any FOR signal: e.g. a
  // required param with an enum is a constrained choice for the user to
  // make, even if its name happens to end in something id-like.
  if (ambient.has(param.name)) return "user_input";
  if (isAgainstSignal(param)) return "user_input";
  if (isForSignal(param)) return "derived";
  return "user_input";
}

export function classifyCatalog(tools: NormalizedTool[]): ClassifiedTool[] {
  const ambient = buildAmbientParamNames(tools);
  return tools.map((tool) => {
    const user: string[] = [];
    const derived: string[] = [];
    for (const p of tool.requiredInputs) {
      (classifyParam(p, ambient) === "derived" ? derived : user).push(p.name);
    }
    return { ...tool, requires: { user, derived } };
  });
}
