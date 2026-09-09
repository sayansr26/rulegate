import { isMap, isScalar, isSeq, type Node } from 'yaml';
import type { RulegateError } from '../model/errors.js';
import {
  CANONICAL_SCHEMA_VERSION,
  DEFAULT_MANIFEST_OPTIONS,
  type RulegateManifest,
  type ManifestOptions,
  type ToolConfig,
} from '../model/canonical.js';
import {
  DEFAULT_LINT_CONFIG,
  isLintSeverity,
  LINT_SEVERITIES,
  type LintConfig,
  type LintSeverity,
} from '../model/lint.js';
import { MANIFEST_PATH } from '../model/paths.js';
import { parseYaml } from './yaml.js';
import { Validator } from './validate.js';
import type { JsonValue } from '../model/ids.js';

export interface ParsedManifest {
  readonly manifest: RulegateManifest;
  readonly errors: readonly RulegateError[];
}

export function parseManifest(raw: string, file = MANIFEST_PATH): ParsedManifest {
  const parsed = parseYaml(raw, file);
  if (!parsed.ok) return { manifest: fallbackManifest(file), errors: [parsed.error] };

  const v = new Validator(file, parsed.value, 'E_MANIFEST_INVALID');
  const root = parsed.value.doc.contents as Node | null;
  const map = root === null ? undefined : v.asMap(root, 'manifest');

  const schemaVersion = v.integer(
    v.get(map, 'schemaVersion'),
    'schemaVersion',
    CANONICAL_SCHEMA_VERSION,
  );
  const tools = parseTools(v, v.get(map, 'tools'), file);
  const options = parseOptions(v, v.get(map, 'options'));
  const canonicalSources = v.stringArray(v.get(map, 'canonicalSources'), 'canonicalSources');
  const lint = parseLint(v, v.get(map, 'lint'));

  return {
    manifest: {
      schemaVersion,
      tools,
      options,
      canonicalSources,
      lint,
      source: { file },
    },
    errors: v.errors,
  };
}

function parseTools(v: Validator, node: Node | undefined, file: string): ToolConfig[] {
  if (node === undefined) return [];
  if (!isSeq(node)) {
    v.fail(node, 'tools', '`tools` must be a list', 'e.g. tools: [claude-code, cursor]');
    return [];
  }

  const out: ToolConfig[] = [];
  node.items.forEach((item, i) => {
    const el = item as Node;
    const field = `tools[${i}]`;

    // Shorthand: a bare string means enabled with no options.
    if (isScalar(el) && typeof el.value === 'string') {
      out.push({
        id: el.value,
        enabled: true,
        options: {},
        source: v.yaml.posAt(el.range?.[0], field),
      });
      return;
    }

    if (!isMap(el)) {
      v.fail(el, field, `\`${field}\` must be a tool id or a mapping with an \`id\``);
      return;
    }

    const id = v.string(v.get(el, 'id'), `${field}.id`);
    if (id === undefined) {
      v.fail(el, `${field}.id`, `\`${field}\` is missing a tool \`id\``);
      return;
    }

    const enabled = v.boolean(v.get(el, 'enabled'), `${field}.enabled`, true);
    const optionsNode = v.asMap(v.get(el, 'options'), `${field}.options`);
    const options: Record<string, JsonValue> = {};
    for (const key of v.keys(optionsNode)) options[key] = v.plain(v.get(optionsNode, key));

    out.push({ id, enabled, options, source: v.yaml.posAt(el.range?.[0], field) });
  });

  const seen = new Set<string>();
  for (const tool of out) {
    if (seen.has(tool.id)) {
      v.fail(null, 'tools', `tool \`${tool.id}\` is declared more than once`);
    }
    seen.add(tool.id);
  }

  void file;
  return out;
}

function parseOptions(v: Validator, node: Node | undefined): ManifestOptions {
  const map = v.asMap(node, 'options');
  return {
    marker: v.boolean(v.get(map, 'marker'), 'options.marker', DEFAULT_MANIFEST_OPTIONS.marker),
    eol: 'lf',
    backup: v.boolean(v.get(map, 'backup'), 'options.backup', DEFAULT_MANIFEST_OPTIONS.backup),
    ignore: v.stringArray(v.get(map, 'ignore'), 'options.ignore'),
  };
}

/**
 * The `lint:` block. Absent means defaults, which is every rule at its own severity.
 *
 * Rule *ids* are deliberately not checked here — the parser has no registry, so it would
 * have to be handed one, and a manifest reader that knows the rule set is a manifest
 * reader that changes whenever a rule is added. The engine reports unknown ids instead.
 * Severities are checked, because the set of three is fixed and a typo silently reading
 * as "default" is exactly the misconfiguration that never gets noticed.
 */
function parseLint(v: Validator, node: Node | undefined): LintConfig {
  const map = v.asMap(node, 'lint');
  if (map === undefined) return DEFAULT_LINT_CONFIG;

  const rulesNode = v.asMap(v.get(map, 'rules'), 'lint.rules');
  const rules: Record<string, LintSeverity> = {};
  for (const key of v.keys(rulesNode)) {
    const field = `lint.rules.${key}`;
    const raw = v.string(v.get(rulesNode, key), field);
    if (raw === undefined) continue;
    if (!isLintSeverity(raw)) {
      v.fail(
        v.get(rulesNode, key),
        field,
        `\`${field}\` must be one of ${LINT_SEVERITIES.join(', ')}, got "${raw}"`,
        `e.g. \`${field}: warn\``,
      );
      continue;
    }
    rules[key] = raw;
  }

  const budgetNode = v.asMap(v.get(map, 'tokenBudget'), 'lint.tokenBudget');
  const tokenBudget: Record<string, number> = {};
  for (const key of v.keys(budgetNode)) {
    const field = `lint.tokenBudget.${key}`;
    const raw = v.get(budgetNode, key);
    if (raw === undefined) continue;
    // Whether `v.integer` complained is read off the error list rather than from a
    // sentinel return: every sentinel here is a number a user could legitimately type,
    // so `-1` would mean both "already reported" and "the author wrote -1".
    const before = v.errors.length;
    const budget = v.integer(raw, field, 0);
    if (v.errors.length > before) continue;
    if (budget <= 0) {
      v.fail(raw, field, `\`${field}\` must be a positive number of tokens`);
      continue;
    }
    tokenBudget[key] = budget;
  }

  return {
    rules,
    ignore: v.stringArray(v.get(map, 'ignore'), 'lint.ignore'),
    tokenBudget,
  };
}

function fallbackManifest(file: string): RulegateManifest {
  return {
    schemaVersion: CANONICAL_SCHEMA_VERSION,
    tools: [],
    options: DEFAULT_MANIFEST_OPTIONS,
    canonicalSources: [],
    lint: DEFAULT_LINT_CONFIG,
    source: { file },
  };
}
