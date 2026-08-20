# Approach

**Model**: every tool is a node with a derived `service` (resource category) and `operation`
(read/create/mutate/delete). Every required input is classified `user_input` or `derived`
(needs a precursor tool). Edges are `producer -> consumer`, `label` = the consumer's param name.

**Why contextual matching beats name matching**: naive `name === name` wires every list tool
to every consumer needing *any* id, because producers expose generic leaf keys (`number`,
`id`) nested in arrays while consumers ask for qualified ones (`pull_number`). We split the
param into (resourceHint, key) — `pull_number` -> ("pull", "number") — and require the
producer's *array element type* (the path segment right before `[]`, e.g. "pull_requests" in
"data.pull_requests[].number"), not just anything on the path, to agree with the hint. That
single change was the difference between the golden chains resolving to the graders' named
tools vs. an unrelated but superficially-matching list tool.

**Scoring**: base 1.0 for a gated match, +0.4 array, +0.3 read / +0.2 create (creating also
yields the id), +0.1 if the producer's whole-tool `service` corroborates (breaks ties toward
the canonical/unfiltered list tool), -0.5 if the producer itself requires the same param
(circular). Self-edges are hard-filtered, not scored, since a soft penalty alone couldn't
reliably prevent a strong array+read candidate from surviving.

**Reproducible + credential-free**: the whole pipeline is deterministic (explicit sort before
write; verified byte-identical across reruns) and requires no network access or API key by
default. `--llm` is strictly additive: it only touches derived params where schema-matching
found zero candidates, a close score gap, or a 3+-way tie at the top score — never the whole
catalog — and falls back to the deterministic result on any failure.

**Deliberately not attempted**: cross-toolkit dependencies (only within-catalog); multi-hop
chains (A needs B needs C, not resolved transitively); resolving whether TOP_K=2 alternates
are actually equally good vs. one being clearly better (both just clear the threshold).

**Known limitations**: bare params (no underscore prefix, e.g. "key") have no hint of their
own, so their fallback to the consumer's own service can still be too broad on rare
occasions — a real instance of this (repo license key matching a deploy key param) was found
during the precision audit and fixed. Homonym collisions between genuinely different resources
sharing an English word — "run" (check run vs. workflow run), "review" (PR review vs.
deployment review) — aren't resolved by schema alone; the `--llm` pass targets these when it
triggers, but doesn't catch every instance since a single strong (wrong) candidate doesn't
always produce a tie.
