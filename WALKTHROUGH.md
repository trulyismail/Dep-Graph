# Walkthrough & Video Prep

Companion doc to `README.md` (the assessment brief) and `APPROACH.md` (the short technical
summary). This one is for you: a plain-English tour of the project plus a Q&A cheat sheet for
the post-submission video walkthrough.

## What this is

A generator that reads any Composio toolkit catalog (`github_catalog.json` in this repo, but
it doesn't know it's GitHub) and outputs a dependency graph telling an agent, for every tool's
required parameters: **ask the user**, or **call another tool first**. Run it, it writes
`dependency_graph.json` and `viz/graph.html`.

## How to run it (have these ready in the live environment)

```bash
npm install                              # generator.json's declared build step
npx tsx src/generate.ts github_catalog.json    # writes dependency_graph.json + viz/graph.html
npm run selfcheck                        # golden chains + invariants + generalization proof
npm run generate -- github_catalog.json --llm  # optional: same, plus LLM disambiguation pass
```
Open `viz/graph.html` directly in a browser (double-click — it's self-contained, no server).

## The pipeline, file by file

1. **`src/catalog.ts`** — normalizes the raw catalog: accepts array or `{items}`, flat or
   JSON-Schema params, walks output schemas (`properties`/`items`/`anyOf`/`$ref`→`$defs`) down
   to leaf fields with a path (e.g. `data.issues[].number`). Also derives each tool's `service`
   (resource category) and `operation` (read/create/mutate/delete) — from tags where they're
   trustworthy, from the slug otherwise.
2. **`src/classify.ts`** — for every *required* input param, decides `user_input` vs `derived`
   (needs a precursor tool), using an id/number/sha-style regex, description phrases, and a
   frequency-based "ambient scope" detector for things like `owner`/`repo`/`org`.
3. **`src/match.ts`** — the core: for each `derived` param, finds which other tools' output
   fields could supply it, scores candidates, keeps the top 2 above a threshold.
4. **`src/generate.ts`** — wires it together, writes the graph with deterministic ordering,
   optionally runs the LLM pass, writes the viz file, prints stats.
5. **`src/validate.ts`** (via `npm run selfcheck`) — golden-chain assertions, shape invariants,
   and reruns the whole pipeline against `fixtures/mini_toolkit.json`, an invented toolkit, to
   prove the code isn't secretly GitHub-shaped.
6. **`src/llm.ts`** — opt-in only (`--llm`), scoped to ambiguous cases, cached, never crashes.
7. **`src/viz.ts`** — writes the self-contained HTML visualization.

## The two golden chains, concretely

- `GITHUB_LIST_REPOSITORY_ISSUES --issue_number--> GITHUB_CREATE_AN_ISSUE_COMMENT`
- `GITHUB_LIST_PULL_REQUESTS --pull_number--> GITHUB_MERGE_A_PULL_REQUEST`

Both fail under naive `name === name` matching (dozens of tools expose a bare `number`
field). They pass because matching requires the **producer's array element type** — the path
segment right before `[]`, e.g. `issues` in `data.issues[].number` — to agree with the
**consumer's resource hint** — `issue` from `issue_number`. That single rule is the difference
between resolving to the graders' named tool and resolving to an unrelated one.

## Q&A prep

**Walk me through what happens when I run the generator.**
Load the catalog → normalize schemas into flat leaf fields → classify each required param as
user-supplied or tool-derived → for each derived param, score candidate producers and keep the
top 2 → sort deterministically → write the graph, the viz, and print stats to stderr.

**Why not just match on parameter names?**
Producers expose generic keys (`id`, `number`) nested in arrays; consumers ask for qualified
ones (`pull_number`). Name-only matching wires every list tool to every consumer needing any
id — hundreds of false edges. I split the param into a resource hint and a key, and require
the *array's own element type* to match the hint, not just the key.

**How do you decide a param needs asking the user vs. calling another tool?**
Signals for "derived": name ends in `id`/`number`/`sha`/`ref`/`slug`/`key`/`login`/`node_id`, or
the description says things like "identifier of"/"obtained from". Signals against: it has a
default, is an enum, is boolean, or is pagination. Params required by a large, frequency-
detected fraction of the whole catalog (`owner`, `repo`, `org`) are treated as ambient scope —
always asked of the user — regardless of their name.

**How is the score computed?**
Base 1.0 for passing the key+resource gate. +0.4 if the field is inside an array (a list tool
genuinely enumerates entities). +0.3 if the producer is a read op, +0.2 if create (creating an
issue also returns its number). +0.1 if the producer's whole-tool service also agrees (breaks
ties toward the canonical list tool). -0.5 if the producer itself requires that same param
(can't be the origin). Self-edges are excluded outright, not just penalized.

**How do you know it generalizes and isn't secretly GitHub-specific?**
`fixtures/mini_toolkit.json` is a hand-written, invented toolkit (task tracker, `TASKR_*`
slugs). `npm run selfcheck` runs the exact same generator code against it with zero changes and
asserts the expected edges appear. There's also a grep test that fails the build if the literal
string `GITHUB` ever shows up in the matching logic.

**Why is the output deterministic?**
Nodes and edges are explicitly sorted (by id; by from/to/label) right before writing, so two
runs on the same input produce a byte-identical file — verified via checksum during dev. That
matters for reproducible diffs and grading.

**What's the LLM for, and why is it safe to leave off?**
It only resolves the ambiguous tail: derived params where schema-matching found zero
candidates, a close score gap, or a 3-way+ tie. It's never on the critical path — golden
assertions and `npm run generate`/`selfcheck` never pass `--llm`. If the flag is passed without
`AI_API_KEY`, it warns and continues deterministically rather than crashing. Responses are
cached by a hash of the case, so reruns cost zero tokens.

**What are the known weak spots?**
Homonym collisions — two genuinely different resources sharing an English word, like a "check
run" vs. a "workflow run", or a "PR review" vs. a "deployment review". Schema matching can't
tell them apart; the LLM pass targets exactly this when it triggers, but not every instance
produces a tie. Also: no multi-hop chains (A needs B needs C isn't resolved transitively), and
no cross-toolkit dependencies.

**What would you do with more time?**
Multi-hop resolution, a smarter tie-break than catalog order for 3+-way ties even without
`--llm`, and using the LLM's disambiguation to retroactively suggest scoring-rule tweaks
instead of only resolving individual cases.

**Show me a specific bug you found and fixed.**
`GITHUB_GET_A_REPOSITORY`'s `key` output field is a *license* key (e.g. `"mit"`); it was
matching `GITHUB_CREATE_A_DEPLOY_KEY`'s bare `key` param purely because both tools share
`service: "repos"`. Bare params (no underscore prefix) have no hint of their own, so I tightened
that specific fallback path to require the field's immediate parent segment to relate, not just
the tool-level service — found via a manual audit of 20 random sampled edges, not a hunch.
