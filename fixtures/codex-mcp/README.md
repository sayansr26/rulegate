# `codex-mcp`

The MCP half of the Codex adapter (T047), and the reason T047 exists: this is the only
target that is not JSON, and it is where the canonical model is checked for quietly
assuming JSON semantics.

`input/.rulegate/mcp/servers.yaml` deliberately diverges from `claude-code-mcp/`,
`cursor-mcp/` and `copilot-mcp/`, which share one file. Two servers had to change, and
both changes are the finding:

- `alpha-http`'s header is `Authorization` rather than `X-Api-Key`. That is now a
  *historical* reason rather than a live constraint (T096): it was once the only header an
  `env:` reference could reach, as `bearer_token_env_var`, and any other header was refused.
  Rulegate writes `env_http_headers` instead, which takes any header name, so the refusal is
  gone with the key that caused it — `bearer_token_env_var` supplies the `Bearer ` scheme
  itself, so its variable holds a bare token while every other writer needs the whole header
  value, and one canonical entry could not mean both. The header is left as `Authorization`
  here because it is what a real config carries; the any-header case has a unit test.
- The variable name is 23 characters, and it is still what makes the T044 scan's false
  positive a failing test rather than a latent one — it just arrives by a new route. The
  exemption used to hang off the `bearer_token_env_var` key; now `Authorization` is an
  ordinary header name, so it is the `[…env_http_headers]` *section* that says these values
  are variable names. A name that long still looks generated to the entropy test.

Three more divergences from the JSON targets:

- **Order is content, and a golden still cannot check it.** TOML tables have no canonical
  order, so the render order decides the bytes — but `parseMcpServers` sorts by id at parse
  time, so this fixture reaches the adapter sorted however `input/` is written. T046
  predicted this file would finally guard `selectMcpServers`' sort and it does not: deleting
  that sort passes every test here. The guard is a unit test that reverses the input.
- **The marker is a `#` comment**, via `withHashMarker` — written at T005 and unused for
  every task since, earmarked in that task's own notes for exactly this file.
- **Codex has no variable substitution at all.** `env: { NAME: env:NAME }` becomes
  `env_vars = ["NAME"]`, a different key with different semantics. A *renamed* reference
  (`API_KEY: env:MY_TOKEN`) has no form here and is refused.

`expected/.codex/config.toml` was hand-written from
<https://learn.chatgpt.com/docs/config-file/config-reference> and
<https://learn.chatgpt.com/docs/extend/mcp> (read 2026-09-04) before the writer existed.
