# build a tool dependency graph generator (60-120 mins)

we care about the quality and structure of the dependency relationships you discover

some actions need precursor actions before being able to execute them

a concrete example

1. the tool `GITHUB_CREATE_AN_ISSUE_COMMENT` which needs an `issue_number`
2. which can be got by `GITHUB_LIST_REPOSITORY_ISSUES` as an example, there could be other ways to get an `issue_number` too

a second more dense exmaple
the merge tool `GITHUB_MERGE_A_PULL_REQUEST` needs a `pull_number`, if you only have a branch name you first list the pull requests with `GITHUB_LIST_PULL_REQUESTS` to find the matching one and then you can merge it

when we agentically execute actions inside composio, we need to know either what info to get from the user or what other action we should take before we execute the action.

you are supposed to build a program that generates this dependency graph — a generator that reads a toolkit's tool catalog and outputs the graph, instead of hand-writing it

to keep this limited in scope, we give you [Github](https://docs.composio.dev/toolkits/github) as an example toolkit to build and test against — but your generator should generalize: it reads a toolkit's catalog and produces the graph, so it works for any toolkit, not just this one

the final submission should be a visualized dependency graph where i can see connection (this is not super important just should exist for me to see if graph with edges and nodes)

## deliverable

commit a **generator** at the repo root — a program that produces a `dependency_graph.json` from a toolkit's catalog. we run it: your generator is called with the path to a toolkit's catalog as a command-line argument (e.g. `node src/generate.ts path/to/catalog.json`), and it writes `dependency_graph.json` at the repo root (declare build/run in `generator.json`). it must read the catalog it's given, not hardcode a fixed graph. the graph shape our checks read:

```json
{
  "nodes": [{ "id": "GITHUB_CREATE_AN_ISSUE", "service": "issues" }],
  "edges": [{ "from": "GITHUB_LIST_REPOSITORY_ISSUES", "to": "GITHUB_CREATE_AN_ISSUE_COMMENT", "label": "issue_number" }]
}
```

- each edge is `producer -> consumer`; `label` is the id/field the producer supplies (e.g. `issue_number`, `pull_number`).
- use Composio's tool slugs for node ids (e.g. `GITHUB_CREATE_AN_ISSUE`), taken from the catalog you were given.
- also commit a visualization (nodes + edges you can see) and the tool catalog you use.

## get started

1. the GitHub tool catalog is already provided at `github_catalog.json` — no api key needed.
2. write your generator in `src/generate.ts` to read a toolkit's catalog and produce the graph. run `npm run selfcheck` to try it on `github_catalog.json` as you iterate.
3. use node/tsx or python (`bun` isn't guaranteed when we run your generator).

for language models, use the **AI API credentials** (a Base URL and API key) shown on your Litmus assessment page. they work with the OpenAI SDK: point the client's `baseURL`/`base_url` at that url and pass the key, and call an allowed model such as `openai/gpt-4o`. your usage counts against the assessment's token budget.

you can implement this with whatever language you want, feel free to use language models and coding tools

## submit

once you are done, run `litmus submit` from your assessment folder. make sure your generator (see **deliverable** above) is committed.

## activity tracking

your work is tracked automatically while you work (file changes, git history, and AI-tool prompts) and included when you `litmus submit`. there is nothing to run, just commit often.

NOTE:  Feel free to use LLM, you will be judged by the quality of output, eval...
