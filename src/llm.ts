/**
 * Optional LLM disambiguation pass, behind --llm only. Never runs on the
 * default path: no network call, no API key, no env var required unless
 * the flag is explicitly passed. If the flag is passed with no credentials,
 * warn and return an empty (deterministic) result — never crash.
 */
import { readFileSync, writeFileSync, existsSync } from "fs";
import { createHash } from "crypto";
import type { AmbiguousCase, Edge } from "./match.js";

const CACHE_PATH = ".llm-cache.json";
const BATCH_SIZE = 15;

/** Tiny hand-rolled .env parser — no dotenv dependency (constraint 8). */
function loadEnvFile(path = ".env"): void {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf-8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

interface CacheEntry {
  producer: string;
  confidence: number;
  reason: string;
}
type Cache = Record<string, CacheEntry>;

function loadCache(): Cache {
  if (!existsSync(CACHE_PATH)) return {};
  try {
    return JSON.parse(readFileSync(CACHE_PATH, "utf-8"));
  } catch {
    return {};
  }
}

function caseKey(c: AmbiguousCase): string {
  const payload = JSON.stringify({
    consumer: c.consumerSlug,
    param: c.param,
    candidates: c.candidates.map((x) => x.slug).sort(),
  });
  return createHash("sha256").update(payload).digest("hex").slice(0, 16);
}

export interface LlmResolution {
  edges: Edge[];
  noneParams: Array<{ consumerSlug: string; param: string }>;
  requestsMade: number;
  approxTokens: number;
}

export async function resolveAmbiguous(cases: AmbiguousCase[]): Promise<LlmResolution> {
  loadEnvFile();
  const result: LlmResolution = { edges: [], noneParams: [], requestsMade: 0, approxTokens: 0 };
  if (cases.length === 0) return result;

  const apiKey = process.env.AI_API_KEY;
  if (!apiKey) {
    console.error("--llm passed but AI_API_KEY is not set; continuing deterministically (no LLM calls made).");
    return result;
  }

  const cache = loadCache();
  const keyed = cases.map((c) => ({ c, key: caseKey(c) }));
  const uncached = keyed.filter(({ key }) => !cache[key]);

  try {
    const baseURL = process.env.AI_BASE_URL || "https://litmus-production.up.railway.app/proxy/openai/v1";
    const model = process.env.AI_MODEL || "openai/gpt-4o";
    const { default: OpenAI } = await import("openai");
    const client = new OpenAI({ apiKey, baseURL });

    for (let i = 0; i < uncached.length; i += BATCH_SIZE) {
      const batch = uncached.slice(i, i + BATCH_SIZE);
      const payload = batch.map(({ c, key }) => ({
        case_id: key,
        consumer: c.consumerSlug,
        param: c.param,
        description: c.description,
        candidates: c.candidates.map((x) => ({ slug: x.slug, service: x.service, field_path: x.path })),
      }));

      const messages = [
        {
          role: "system" as const,
          content:
            "You resolve data-dependency provenance between API tools: for each case, decide which " +
            "candidate producer tool (if any) supplies the value for the consumer's parameter. Choose " +
            "only from the given candidates by slug, or \"none\" if the value should come from the user " +
            "rather than another tool. Respond with strict JSON only, no prose: " +
            '{"results":[{"case_id":"...","producer":"<slug>|none","confidence":0-1,"reason":"<12 words max>"}]}',
        },
        { role: "user" as const, content: JSON.stringify({ cases: payload }) },
      ];

      let parsed: { results?: Array<CacheEntry & { case_id: string }> } | undefined;
      for (let attempt = 0; attempt < 2 && !parsed; attempt++) {
        try {
          const resp = await client.chat.completions.create({
            model,
            messages,
            temperature: 0,
            response_format: { type: "json_object" },
          });
          result.requestsMade++;
          result.approxTokens += resp.usage?.total_tokens ?? 0;
          parsed = JSON.parse(resp.choices[0]?.message?.content ?? "{}");
        } catch (e) {
          if (attempt === 1) {
            console.error(`llm batch failed after retry, falling back to deterministic result: ${(e as Error).message}`);
          }
        }
      }

      for (const r of parsed?.results ?? []) {
        cache[r.case_id] = { producer: r.producer, confidence: r.confidence, reason: r.reason };
      }
    }

    writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2), "utf-8");
  } catch (e) {
    console.error(`llm pass failed, continuing deterministically: ${(e as Error).message}`);
  }

  for (const { c, key } of keyed) {
    const r = cache[key];
    if (!r) continue; // no cached/fresh answer: deterministic (schema-only) result stands
    if (r.producer === "none") {
      result.noneParams.push({ consumerSlug: c.consumerSlug, param: c.param });
    } else if (c.candidates.some((cand) => cand.slug === r.producer)) {
      result.edges.push({
        from: r.producer,
        to: c.consumerSlug,
        label: c.param,
        confidence: Math.min(1, Math.max(0, r.confidence)),
        evidence: `llm: ${r.reason}`,
        source: "llm",
        reason: r.reason,
      });
    }
  }

  return result;
}
