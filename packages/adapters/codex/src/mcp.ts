import {
  envRef,
  importedServer,
  selectMcpServers,
  withHashMarker,
  type ImportedMcpResult,
  type JsonValue,
  type McpServer,
  type McpTransport,
  type SecretValue,
  compareCodepoint,
} from '@rulegate/adapter-kit';
import { tomlTable } from './toml.js';
import { parseToml } from './toml-read.js';

/**
 * The project-level config. Codex loads it only for a project the user has trusted; the
 * user-level `~/.codex/config.toml` is outside the repository and is never written
 * (RFC-0001 §11.3).
 *
 * **Rulegate owns this whole file.** Unlike `.mcp.json` and `.cursor/mcp.json`, it is not
 * an MCP-only file — it is where every Codex setting lives. Taking it over wholesale is a
 * deliberate decision rather than an oversight, and it is safe for the reason every other
 * artifact is: `state.json` is the only record of ownership, so a `.codex/config.toml`
 * Rulegate did not write is somebody else's and is refused until `--force` backs it up,
 * and a setting added by hand afterwards is reported as a hand-edit that `sync --import`
 * can recover. Recorded as a `warn` note, because a settings file a tool claims in full is
 * a first-run surprise otherwise.
 *
 * Source: https://learn.chatgpt.com/docs/config-file/config-reference (read 2026-09-04).
 */
export const MCP_FILE = '.codex/config.toml';

const TABLE = 'mcp_servers';

function isSkipped(value: Record<string, JsonValue> | Skipped): value is Skipped {
  return (value as Skipped).kind === 'skipped';
}

/**
 * What Codex cannot express about one server.
 *
 * **Returned, not thrown (T083).** Throwing made `computePlan` record an error, and `sync`
 * writes nothing while any error stands — so one server Codex could not express took down
 * the *entire* run: no `CLAUDE.md`, no `AGENTS.md`, and not even the servers every tool can
 * express. Reproduced on a hand-written `servers.yaml`, which is the documented way to use
 * this feature.
 *
 * The server is skipped and **named in the generated file**, which is where the consequence
 * is: TOML has comments, the omission is committed, it appears in the diff `check` prints,
 * and a reviewer reading `.codex/config.toml` sees why a server they configured is missing.
 * A message printed once by `sync` scrolls away; this one does not.
 */
interface Skipped {
  // An explicit tag rather than a `'why' in x` test: the other arm is
  // `Record<string, JsonValue>`, whose index signature means it could carry a `why` key
  // too, so the narrowing would compile and be wrong for a preserved unknown key.
  readonly kind: 'skipped';
  readonly id: string;
  readonly why: string;
  readonly hint: string;
}

/**
 * The stress case, and the reason T047 exists.
 *
 * **Codex has no variable substitution anywhere.** Every other target expands something —
 * `${NAME}`, `${env:NAME}` — so an `env:` reference is a re-spelling. Here it is not a
 * value at all: the reference has to become a *different key*, and only two keys exist
 * that can hold one.
 *
 * - `env: { NAME: env:NAME }` becomes `env_vars = ["NAME"]`, which whitelists the variable
 *   for forwarding from Codex's own environment. That works only because the map key and
 *   the variable name are the same string. A **renamed** reference — `API_KEY: env:MY_TOKEN`
 *   — has no form here: `[mcp_servers.x.env]` takes literal values, and writing the
 *   reference through would hand the server the text `env:MY_TOKEN` as its credential.
 * - `headers: { Name: env:X }` becomes `env_http_headers = { Name = "X" }`, which sets the
 *   header to the raw value of `X` — the same thing a canonical header reference means
 *   everywhere else. Not `bearer_token_env_var`, which Codex expands to `Authorization:
 *   Bearer $X` and so needs the bare token while every other writer needs the whole value
 *   (T096). `http_headers` holds static values and is not used for references.
 *
 * Both inexpressible cases are **refused** rather than dropped, on the split this codebase
 * already uses: a loss that is still functional is a `warn` note (Cursor's `sse`), and a
 * loss that silently produces a wrong answer is a refusal (Cursor's comma-in-a-glob). A
 * credential that never arrives is the second kind — the server starts and fails to
 * authenticate, which is a bug report about the wrong tool.
 *
 * Source: https://learn.chatgpt.com/docs/config-file/config-reference and
 * https://learn.chatgpt.com/docs/extend/mcp (both read 2026-09-04).
 */
function serverTable(
  server: McpServer,
  envHttpHeaders: Record<string, JsonValue>,
): Record<string, JsonValue> | Skipped {
  // Unknown keys first, interpreted keys second — the same ordering as the two JSON
  // writers, so a preserved key can never override one Rulegate computed.
  const body: Record<string, JsonValue> = { ...server.unknown };

  const { transport } = server;
  if (transport.kind === 'stdio') {
    body['command'] = transport.command;
    if (transport.args.length > 0) body['args'] = [...transport.args];

    const forwarded: string[] = [];
    for (const key of Object.keys(server.env)) {
      const ref = server.env[key]!;
      if (ref.name !== key) {
        return {
          kind: 'skipped',
          id: server.id,
          why: `env.${key} reads a differently-named variable, and Codex has no variable substitution`,
          hint: `rename the variable to ${key}, or exclude codex from this server with a \`tools:\` selector`,
        };
      }
      forwarded.push(key);
    }
    // Already in the parser's codepoint order; sorted again so this line does not depend
    // on that, since the bytes are a contract.
    if (forwarded.length > 0) body['env_vars'] = forwarded.sort();
  } else {
    // `transport: sse` has no representation: Codex documents streamable HTTP only, with
    // no discriminator to carry the distinction. Rendered as a bare `url` — lossy but
    // still a working server, so it is a `warn` note in `docs` rather than a refusal.
    body['url'] = transport.url;

    // `env_http_headers` rather than `bearer_token_env_var`, and the difference is a
    // correctness bug, not a preference (T096). Codex expands `bearer_token_env_var = "X"`
    // to `Authorization: Bearer $X` — it supplies the scheme, so X must hold the bare
    // token. Every other writer renders a canonical header reference as the header's whole
    // value: `.mcp.json` emits `"Authorization": "${X}"`, so X must hold `Bearer <token>`.
    // One canonical `Authorization: env:X` therefore could not be right for both tools;
    // whichever way the user set X, one of them sent `Bearer Bearer …` or a bare token with
    // no scheme. `env_http_headers = { Name = "X" }` sets the header to the *raw* value of
    // X, which is exactly what `headers: Record<string, EnvRef>` already means, so the two
    // agree with no change to the model.
    //
    // It also removes the reason this branch used to refuse: Codex resolves any header name
    // this way, not just Authorization.
    //
    // Source: `build_default_headers` in codex-rs/rmcp-client/src/utils.rs and
    // `attach_authorization` in codex-rs/codex-mcp/src/executor_environment_http_client.rs,
    // both read 2026-09-20.
    // Returned to the caller rather than written into `body`: TOML spells a map as its own
    // sub-table, and `tomlValue` refuses a nested object on purpose — relocating a
    // *preserved* key would move it somewhere the user did not put it. This key is one
    // Rulegate interprets, so its placement is Rulegate's to choose.
    for (const key of Object.keys(server.headers).sort(compareCodepoint)) {
      envHttpHeaders[key] = server.headers[key]!.name;
    }
  }

  return body;
}

/**
 * `.codex/config.toml` for the servers this tool gets. Empty selection renders nothing.
 *
 * TOML tables have no canonical order, so the render order *is* the file order here and
 * nothing downstream re-sorts it — unlike `stableJsonStringify`, which sorts every key
 * deeply. T046 expected that to make `selectMcpServers`' sort visible to a golden at last.
 * It does not: `parseMcpServers` already sorts by id at parse time, so every fixture
 * arrives ordered and deleting the sort changes no generated byte. The sort still matters
 * for a caller that builds servers rather than parsing them, and its guards are the two
 * unit tests that reverse the input by hand.
 */
export function renderConfigToml(servers: readonly McpServer[], marker: boolean): string {
  const selected = selectMcpServers(servers, 'codex');
  if (selected.length === 0) return '';

  const tables: string[] = [];
  const skipped: Skipped[] = [];

  for (const server of selected) {
    const envHttpHeaders: Record<string, JsonValue> = {};
    const body = serverTable(server, envHttpHeaders);
    if (isSkipped(body)) {
      skipped.push(body);
      continue;
    }
    tables.push(tomlTable([TABLE, server.id], body));
    // Immediately after its parent. TOML identifies a sub-table by its dotted path, not by
    // where it sits, so this is readability rather than correctness — but a headers table
    // separated from its server by two others is a file nobody can check by eye.
    if (Object.keys(envHttpHeaders).length > 0) {
      tables.push(tomlTable([TABLE, server.id, ENV_HEADERS], envHttpHeaders));
    }
  }

  // Every server refused, and nothing else to write. Emitting a file of nothing but
  // apologies would create an artifact `check` has to reason about and a user has to
  // wonder about; the omission is still reported, by `doctor`, from the same canonical.
  if (tables.length === 0) return '';

  const notes = skipped.map((s) => `# omitted: \`${s.id}\` — ${s.why}.\n#   ${s.hint}`);
  const body = [...notes, ...tables].join('\n\n');
  return withHashMarker(body, marker);
}

/**
 * The servers Codex cannot express, for callers that need to report rather than render.
 *
 * `doctor` uses it to explain a gap the generated file can only hint at, and it is exported
 * so the explanation has exactly one source.
 */
export function unrepresentableServers(
  servers: readonly McpServer[],
): readonly { id: string; why: string; hint: string }[] {
  const out: Skipped[] = [];
  for (const server of selectMcpServers(servers, 'codex')) {
    // The sub-table is collected and discarded: this caller reports refusals and renders
    // nothing, so where the headers would have gone does not matter to it.
    const result = serverTable(server, {});
    if (isSkipped(result)) out.push(result);
  }
  return out;
}

/** The sub-table holding this server's header references, written and read by both halves. */
const ENV_HEADERS = 'env_http_headers';

/** Keys `serverTable` writes and this reader interprets; everything else is preserved. */
const INTERPRETED = new Set(['command', 'args', 'url', 'env_vars', ENV_HEADERS]);

/**
 * The inverse of `renderConfigToml`, and the one importer that is not reading JSON.
 *
 * The asymmetry the writer documents runs backwards here just as awkwardly: an `env:`
 * reference is not a value to unwrap but a *key* to invert. `env_vars = ["NAME"]` becomes
 * `env: { NAME: env:NAME }` — the map key and the variable name are necessarily the same
 * string, which is exactly why the writer refuses a renamed reference — and
 * `env_http_headers = { Name = "X" }` becomes `headers: { Name: env:X }`.
 * `bearer_token_env_var` is preserved in `unknown` and reported rather than imported (T096).
 *
 * Tables outside `mcp_servers.*` are **reported, not imported**. Rulegate owns this whole
 * file once it writes it, so a `[tui]` table the user has today will not survive the first
 * `sync`; saying so during `init` is the difference between a warning and a surprise.
 */
export function importConfigToml(contents: string, file = MCP_FILE): ImportedMcpResult {
  const tables = parseToml(contents);
  const servers: McpServer[] = [];
  const warnings: string[] = [];
  const foreign = new Set<string>();

  // `env_http_headers` arrives as its own table, `[mcp_servers.<id>.env_http_headers]`, so
  // it has to be collected before the server loop rather than read out of the server's own
  // entries. Keyed by id, which is the only thing tying the two tables together once the
  // parser has flattened the file.
  const envHeaderTables = new Map<string, Record<string, JsonValue>>();
  for (const table of tables) {
    if (table.path.length === 3 && table.path[0] === TABLE && table.path[2] === ENV_HEADERS) {
      envHeaderTables.set(table.path[1]!, table.entries);
    }
  }

  for (const table of tables) {
    if (table.path.length === 0) {
      if (Object.keys(table.entries).length > 0) foreign.add('(top level)');
      continue;
    }
    if (table.path[0] !== TABLE) {
      foreign.add(table.path.join('.'));
      continue;
    }
    // `[mcp_servers]` itself carries nothing; only `[mcp_servers.<id>]` is a server.
    if (table.path.length !== 2) continue;

    const id = table.path[1]!;
    for (const key of table.unreadable) {
      warnings.push(
        `${file}: server \`${id}\` has a \`${key}\` this reader cannot represent; the key is dropped`,
      );
    }

    const entries = table.entries;
    const command = entries['command'];
    const url = entries['url'];

    let transport: McpTransport;
    if (typeof command === 'string' && typeof url === 'string') {
      warnings.push(`${file}: server \`${id}\` declares both \`command\` and \`url\`; skipped`);
      continue;
    } else if (typeof command === 'string') {
      const rawArgs = entries['args'] ?? [];
      if (!Array.isArray(rawArgs) || !rawArgs.every((a): a is string => typeof a === 'string')) {
        warnings.push(`${file}: server \`${id}\` has a non-string \`args\` entry; skipped`);
        continue;
      }
      transport = { kind: 'stdio', command, args: rawArgs };
    } else if (typeof url === 'string') {
      // Codex documents streamable HTTP with no discriminator, so this is `http`. A
      // canonical `sse` was already flattened on the way out — the loss the writer records
      // as a `warn` note — and there is nothing here to recover it from.
      transport = { kind: 'http', url };
    } else {
      warnings.push(`${file}: server \`${id}\` has neither \`command\` nor \`url\`; skipped`);
      continue;
    }

    const env: Record<string, SecretValue> = {};
    const rawVars = entries['env_vars'];
    if (rawVars !== undefined) {
      if (!Array.isArray(rawVars) || !rawVars.every((v): v is string => typeof v === 'string')) {
        warnings.push(`${file}: server \`${id}\` has a non-string \`env_vars\` entry; skipped`);
        continue;
      }
      for (const name of rawVars) env[name] = envRef(name);
    }

    const headers: Record<string, SecretValue> = {};
    for (const [name, variable] of Object.entries(envHeaderTables.get(id) ?? {})) {
      if (typeof variable === 'string') headers[name] = envRef(variable);
    }
    // `bearer_token_env_var` is deliberately *not* imported as `Authorization: env:X`
    // (T096). Codex prepends `Bearer ` to that variable, so the header's real value is
    // `Bearer ` plus a reference — a reference with text around it, which canonical cannot
    // hold and which `import/mcp.ts` refuses for the same reason. Importing it anyway would
    // hand every other tool a bare token with no scheme: a server that starts and fails to
    // authenticate, which is the silent-wrong-answer case this codebase refuses rather than
    // warns about. The key stays in `unknown`, so the value is preserved and nothing is lost.
    if (typeof entries['bearer_token_env_var'] === 'string') {
      warnings.push(
        `${file}: server \`${id}\` uses \`bearer_token_env_var\`, where Codex supplies the \`Bearer \` scheme itself. Canonical headers hold a whole value, so importing it would send other tools a token with no scheme — the reference is kept verbatim and no \`Authorization\` header was imported. Re-express it as \`env_http_headers\` with the full \`Bearer <token>\` in the variable if you want it shared.`,
      );
    }

    const unknown: Record<string, JsonValue> = {};
    for (const key of Object.keys(entries).sort()) {
      if (!INTERPRETED.has(key)) unknown[key] = entries[key]!;
    }

    servers.push(importedServer({ id, transport, env, headers, unknown, source: { file } }));
  }

  if (foreign.size > 0) {
    warnings.push(
      `${file}: ${String(foreign.size)} non-MCP table(s) (${[...foreign].sort().join(', ')}) are not imported. Rulegate owns this whole file once it writes it, so those settings will not survive the first \`sync\` — copy them somewhere safe first.`,
    );
  }

  return { servers, warnings };
}
