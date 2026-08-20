/**
 * Normalization layer: turns a raw Composio-shaped tool catalog (any toolkit)
 * into a flat, uniform structure the rest of the generator works against.
 *
 * Nothing in this file knows about GitHub. Every toolkit-specific fact
 * (the resource vocabulary, the verb vocabulary, the prefix to strip) is
 * derived from the catalog it is handed at runtime.
 */
import { readFileSync } from "fs";

export type JsonSchema = Record<string, any>;

export interface RawTool {
  slug?: string;
  name?: string;
  description?: string;
  inputParameters?: any;
  outputParameters?: any;
  tags?: string[];
  category?: string;
  toolkit?: { slug?: string; name?: string };
  function?: { name?: string };
  [key: string]: any;
}

export interface ParamInfo {
  name: string;
  type?: string;
  description?: string;
  required: boolean;
  default?: any;
  enum?: any[];
}

export interface OutputField {
  name: string;
  path: string;
  type?: string;
  description?: string;
  inArray: boolean;
}

export type Operation = "read" | "create" | "mutate" | "delete";

export interface NormalizedTool {
  slug: string;
  description: string;
  service: string;
  operation: Operation;
  toolkitSlug: string;
  inputParams: ParamInfo[];
  requiredInputs: ParamInfo[];
  outputFields: OutputField[];
}

export function loadCatalog(path: string): RawTool[] {
  const data = JSON.parse(readFileSync(path, "utf-8"));
  const tools = Array.isArray(data) ? data : (data.items ?? data.tools ?? []);
  if (!Array.isArray(tools)) {
    throw new Error(
      "catalog must be an array of tools, or an object with an items/tools array",
    );
  }
  return tools;
}

export function slugOf(tool: RawTool): string | undefined {
  return tool.slug ?? tool.name ?? tool.function?.name;
}

// ---------------------------------------------------------------------------
// Input parameter normalization: accept both a flat map
// { param: { type, description, required } } and JSON-Schema
// { properties: {...}, required: [...] }.
// ---------------------------------------------------------------------------

function normalizeInputParams(inputParameters: any): ParamInfo[] {
  if (!inputParameters || typeof inputParameters !== "object") return [];

  if (inputParameters.properties && typeof inputParameters.properties === "object") {
    const requiredSet = new Set<string>(
      Array.isArray(inputParameters.required) ? inputParameters.required : [],
    );
    return Object.entries(inputParameters.properties).map(([name, schema]) => {
      const s = (schema ?? {}) as JsonSchema;
      return {
        name,
        type: s.type,
        description: s.description,
        required: requiredSet.has(name),
        default: s.default,
        enum: s.enum,
      };
    });
  }

  // Flat shape: each value is itself the descriptor, carrying its own
  // `required` boolean rather than a sibling `required` array.
  return Object.entries(inputParameters).map(([name, schema]) => {
    const s = (schema ?? {}) as JsonSchema;
    return {
      name,
      type: s.type,
      description: s.description,
      required: !!s.required,
      default: s.default,
      enum: s.enum,
    };
  });
}

// ---------------------------------------------------------------------------
// Output schema walk: properties -> items -> anyOf/oneOf -> $ref/$defs.
// $ref resolution isn't in the spec's list but is structurally required —
// Composio wraps every response as `data: {"$ref": "#/$defs/..."}`, so
// without it we'd never reach a single real leaf field.
// ---------------------------------------------------------------------------

const MAX_WALK_DEPTH = 12;
const MAX_LEAF_FIELDS = 2000; // guard against pathological/cyclic schemas

function resolveRef(ref: string, defs: Record<string, JsonSchema>): JsonSchema | undefined {
  const m = ref.match(/^#\/(?:\$defs|definitions)\/(.+)$/);
  return m ? defs[m[1]] : undefined;
}

function walkSchema(
  schema: JsonSchema | undefined,
  path: string,
  inArray: boolean,
  defs: Record<string, JsonSchema>,
  out: OutputField[],
  depth: number,
): void {
  if (!schema || typeof schema !== "object" || depth > MAX_WALK_DEPTH) return;
  if (out.length >= MAX_LEAF_FIELDS) return;

  if (typeof schema.$ref === "string") {
    walkSchema(resolveRef(schema.$ref, defs), path, inArray, defs, out, depth + 1);
    return;
  }

  const branches = schema.anyOf ?? schema.oneOf;
  if (Array.isArray(branches)) {
    for (const branch of branches) walkSchema(branch, path, inArray, defs, out, depth + 1);
    return;
  }

  if (schema.type === "array" || schema.items) {
    walkSchema(schema.items, `${path}[]`, true, defs, out, depth + 1);
    return;
  }

  if (schema.properties && typeof schema.properties === "object") {
    for (const [key, sub] of Object.entries(schema.properties)) {
      walkSchema(sub as JsonSchema, path ? `${path}.${key}` : key, inArray, defs, out, depth + 1);
    }
    return;
  }

  const leafName = path.replace(/\[\]$/, "").split(".").pop() ?? path;
  out.push({ name: leafName, path, type: schema.type, description: schema.description, inArray });
}

function extractOutputFields(outputParameters: any): OutputField[] {
  if (!outputParameters || typeof outputParameters !== "object") return [];
  const defs: Record<string, JsonSchema> = {
    ...(outputParameters.$defs ?? {}),
    ...(outputParameters.definitions ?? {}),
  };
  const props = outputParameters.properties;
  if (!props || typeof props !== "object") return [];

  const out: OutputField[] = [];
  if (props.data) {
    // Composio's payload wrapper: the real toolkit data lives under `data`.
    walkSchema(props.data, "data", false, defs, out, 0);
  } else {
    // No wrapper (non-Composio-shaped toolkit) — walk every top-level field.
    for (const [key, sub] of Object.entries(props)) {
      walkSchema(sub as JsonSchema, key, false, defs, out, 0);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Service (resource) derivation.
// ---------------------------------------------------------------------------

// Generic CRUD verbs and articles/prepositions used to strip down a slug to
// its resource noun(s). Not tied to any one toolkit's vocabulary.
const NOUN_STOPWORDS = new Set([
  "LIST", "GET", "CREATE", "UPDATE", "DELETE", "MERGE", "SEARCH", "ADD",
  "REMOVE", "A", "AN", "THE", "FOR", "OF", "IN",
]);

// Composio/MCP tags come in two flavors mixed together in the same array:
// resource categories (e.g. "issues", "Repositories") and structural
// annotations. The structural ones follow a naming convention, not a
// toolkit-specific word list: MCP tool-annotation hints always end in
// "Hint" (openWorldHint, readOnlyHint, idempotentHint, destructiveHint,
// createHint, updateHint, closedWorldHint), and a handful of Composio
// catalog-level markers appear across every toolkit's tags, not just one.
const HINT_TAG_RE = /Hint$/;
const PLATFORM_MARKER_TAGS = new Set(["important", "deprecated", "mcpignore", "graphql", "search"]);

function isStructuralTag(tag: string): boolean {
  return HINT_TAG_RE.test(tag) || PLATFORM_MARKER_TAGS.has(tag.toLowerCase());
}

export function singularize(word: string): string {
  const w = word.toLowerCase();
  if (w.endsWith("ies") && w.length > 3) return w.slice(0, -3) + "y";
  if (/(s|x|ch|sh)es$/.test(w)) return w.slice(0, -2);
  if (w.endsWith("s") && !w.endsWith("ss") && w.length > 1) return w.slice(0, -1);
  return w;
}

function stripToolkitPrefix(slug: string, toolkitSlug: string): string[] {
  const parts = slug.split("_").filter(Boolean);
  const prefix = toolkitSlug.toUpperCase();
  return parts.length && parts[0] === prefix ? parts.slice(1) : parts;
}

function slugNounTokens(slug: string, toolkitSlug: string): string[] {
  return stripToolkitPrefix(slug, toolkitSlug)
    .filter((t) => !NOUN_STOPWORDS.has(t))
    .map(singularize);
}

/** Global noun-token frequency, built from the catalog at runtime (fallback path only). */
function buildNounVocabulary(tools: RawTool[]): Map<string, number> {
  const freq = new Map<string, number>();
  for (const t of tools) {
    const slug = slugOf(t);
    if (!slug) continue;
    for (const n of slugNounTokens(slug, t.toolkit?.slug ?? "")) {
      freq.set(n, (freq.get(n) ?? 0) + 1);
    }
  }
  return freq;
}

function deriveService(tool: RawTool, vocab: Map<string, number>): string {
  const slug = slugOf(tool) ?? "";
  const toolkitSlug = tool.toolkit?.slug ?? "";
  const nounTokens = slugNounTokens(slug, toolkitSlug);
  const nounSet = new Set(nounTokens);

  if (typeof tool.category === "string" && tool.category.trim()) {
    return tool.category.trim().toLowerCase();
  }

  const tags: string[] = Array.isArray(tool.tags) ? tool.tags : [];

  // A tag that lexically matches a noun actually present in this tool's own
  // slug. This is deliberately not "tags[0]": in this catalog tags[0] is
  // frequently a structural hint, not the resource (see APPROACH.md).
  for (const tag of tags) {
    if (isStructuralTag(tag)) continue;
    if (nounSet.has(singularize(tag.replace(/\s+/g, "")))) return tag.toLowerCase();
  }

  // No cross-validated match: fall back to the first non-structural tag.
  for (const tag of tags) {
    if (!isStructuralTag(tag)) return tag.toLowerCase();
  }

  // No usable tags at all: most frequent remaining noun token, by global
  // catalog frequency, among this tool's own candidate nouns.
  if (nounTokens.length > 0) {
    let best = nounTokens[0]!;
    let bestFreq = -1;
    for (const n of nounTokens) {
      const f = vocab.get(n) ?? 0;
      if (f > bestFreq) {
        best = n;
        bestFreq = f;
      }
    }
    return best;
  }

  return "general";
}

// ---------------------------------------------------------------------------
// Operation derivation from the leading verb token.
// ---------------------------------------------------------------------------

const VERB_OPERATION: Record<string, Operation> = {
  LIST: "read", GET: "read", SEARCH: "read", CHECK: "read", LOOKUP: "read",
  FIND: "read", FETCH: "read", VIEW: "read", DOWNLOAD: "read",
  CREATE: "create", ADD: "create", GENERATE: "create", INVITE: "create",
  DELETE: "delete", REMOVE: "delete", CANCEL: "delete", CLEAR: "delete",
  UNFOLLOW: "delete", DISABLE: "delete",
};

function deriveOperation(slug: string, toolkitSlug: string): Operation {
  const verb = stripToolkitPrefix(slug, toolkitSlug)[0] ?? "";
  return VERB_OPERATION[verb] ?? "mutate";
}

// ---------------------------------------------------------------------------
// Entry point.
// ---------------------------------------------------------------------------

export function normalizeCatalog(tools: RawTool[]): NormalizedTool[] {
  const vocab = buildNounVocabulary(tools);
  const normalized: NormalizedTool[] = [];

  for (const tool of tools) {
    const slug = slugOf(tool);
    if (!slug) continue;
    const toolkitSlug = tool.toolkit?.slug ?? "";
    const inputParams = normalizeInputParams(tool.inputParameters);
    normalized.push({
      slug,
      description: tool.description ?? "",
      service: deriveService(tool, vocab),
      operation: deriveOperation(slug, toolkitSlug),
      toolkitSlug,
      inputParams,
      requiredInputs: inputParams.filter((p) => p.required),
      outputFields: extractOutputFields(tool.outputParameters),
    });
  }

  return normalized;
}
