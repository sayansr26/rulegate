import { isMap, isScalar, isSeq, type Node } from 'yaml';
import { RulegateError } from '../model/errors.js';
import { SKILL_FILE, SKILLS_DIR } from '../model/paths.js';
import {
  SKILL_COMPATIBILITY_MAX,
  SKILL_DESCRIPTION_MAX,
  SKILL_ID_PATTERN,
  type Skill,
  type SkillAsset,
} from '../model/skill.js';
import { ALL_TOOLS } from '../model/selector.js';
import { compareCodepoint } from '../render/order.js';
import { splitFrontmatter } from './frontmatter.js';
import { parseToolSelector } from './rules.js';
import { Validator } from './validate.js';
import { parseYaml } from './yaml.js';
import type { JsonValue } from '../model/ids.js';
import type { ReadOnlyFileSystem } from '../fs/types.js';

export interface ParsedSkills {
  readonly skills: readonly Skill[];
  readonly errors: readonly RulegateError[];
  /** Every file read, repo-relative POSIX. */
  readonly sourceFiles: readonly string[];
}

const invalid = (file: string, message: string, hint?: string): RulegateError =>
  new RulegateError({
    code: 'E_SKILL_INVALID',
    message,
    source: { file },
    ...(hint === undefined ? {} : { hint }),
  });

/**
 * Read `.rulegate/skills/<id>/` directories into canonical skills (RFC-0001 §12).
 *
 * `root` is the `.rulegate/` level being parsed, so nested levels read their own skills.
 * Like the rest of `parse`, this accumulates rather than throws: every broken skill is
 * reported in one run.
 */
export async function parseSkills(fs: ReadOnlyFileSystem, root: string): Promise<ParsedSkills> {
  const dir = root === '' ? SKILLS_DIR : `${root}/${SKILLS_DIR}`;
  if (!(await fs.exists(dir))) return { skills: [], errors: [], sourceFiles: [] };

  const skills: Skill[] = [];
  const errors: RulegateError[] = [];
  const sourceFiles: string[] = [];

  for (const entry of await fs.listDir(dir)) {
    const path = `${dir}/${entry.name}`;
    if (entry.kind === 'symlink') {
      errors.push(
        invalid(path, 'a skill may not be a symlink', 'replace it with the directory itself'),
      );
      continue;
    }
    if (entry.kind === 'file') {
      errors.push(
        invalid(path, `a file directly in ${dir}/ is not a skill`, `move it into ${dir}/<name>/`),
      );
      continue;
    }
    const parsed = await parseSkillDir(fs, path, entry.name);
    errors.push(...parsed.errors);
    sourceFiles.push(...parsed.sourceFiles);
    if (parsed.skill !== undefined) skills.push(parsed.skill);
  }

  return { skills, errors, sourceFiles: sourceFiles.sort(compareCodepoint) };
}

/** One skill directory, anywhere — `.rulegate/skills/<id>/` or a tool's copy `init` imports. */
export async function parseSkillDir(
  fs: ReadOnlyFileSystem,
  path: string,
  id: string,
): Promise<{ skill?: Skill; errors: RulegateError[]; sourceFiles: string[] }> {
  const errors: RulegateError[] = [];
  const skillFile = `${path}/${SKILL_FILE}`;

  const walked = await walk(fs, path, '');
  errors.push(...walked.errors);
  const sourceFiles = walked.files.map((f) => `${path}/${f}`);

  if (!walked.files.includes(SKILL_FILE)) {
    // A directory of skills grouped under a folder reaches here too: no tool reads a
    // nested skill tree, so it is an error rather than a namespace (§12.1).
    const nested = walked.files.some((f) => f.endsWith(`/${SKILL_FILE}`));
    errors.push(
      invalid(
        path,
        nested
          ? `skills cannot be nested: ${path}/ groups skills`
          : `${path}/ has no ${SKILL_FILE}`,
        nested
          ? `move each skill to its own directory directly under ${SKILLS_DIR}/`
          : `add ${skillFile}, or remove the directory`,
      ),
    );
    return { errors, sourceFiles };
  }

  if (!SKILL_ID_PATTERN.test(id)) {
    errors.push(
      invalid(
        path,
        `skill directory \`${id}\` is not a valid Agent Skills name`,
        'use 1-64 lowercase letters, digits and hyphens, with no leading, trailing or double hyphen',
      ),
    );
  }

  const raw = await fs.readFile(skillFile);
  const split = splitFrontmatter(raw, skillFile);
  if (!split.ok) return { errors: [...errors, split.error], sourceFiles };
  const { yaml, yamlLineOffset, body } = split.value;
  if (yaml === undefined || yaml.trim() === '') {
    errors.push(
      invalid(
        skillFile,
        `${SKILL_FILE} has no frontmatter`,
        'add `name` and `description` between `---` lines',
      ),
    );
    return { errors, sourceFiles };
  }

  const parsedYaml = parseYaml(yaml, skillFile, yamlLineOffset);
  if (!parsedYaml.ok) return { errors: [...errors, parsedYaml.error], sourceFiles };
  const v = new Validator(skillFile, parsedYaml.value, 'E_SKILL_INVALID');
  const root = parsedYaml.value.doc.contents as Node | null;
  const map = root === null ? undefined : v.asMap(root, 'frontmatter');

  const name = v.string(v.get(map, 'name'), 'name');
  if (name === undefined) {
    v.fail(map, 'name', '`name` is required', `set \`name: ${id}\``);
  } else if (name !== id) {
    v.fail(
      v.get(map, 'name'),
      'name',
      `\`name\` is \`${name}\` but the directory is \`${id}\`; the Agent Skills spec requires them to match`,
      `rename the directory to ${name}/, or set \`name: ${id}\``,
    );
  }

  const description = v.string(v.get(map, 'description'), 'description');
  if (description === undefined || description.trim() === '') {
    v.fail(
      map,
      'description',
      '`description` is required',
      'say what the skill does and when to use it',
    );
  } else if ([...description].length > SKILL_DESCRIPTION_MAX) {
    v.fail(
      v.get(map, 'description'),
      'description',
      `\`description\` is ${[...description].length} characters; the limit is ${SKILL_DESCRIPTION_MAX}`,
    );
  }

  const compatibility = v.get(map, 'compatibility');
  if (compatibility !== undefined) {
    const text = v.string(compatibility, 'compatibility');
    if (text !== undefined && (text.length === 0 || [...text].length > SKILL_COMPATIBILITY_MAX)) {
      v.fail(
        compatibility,
        'compatibility',
        `\`compatibility\` must be 1-${SKILL_COMPATIBILITY_MAX} characters`,
      );
    }
  }
  if (v.get(map, 'license') !== undefined) v.string(v.get(map, 'license'), 'license');
  checkMetadata(v, v.get(map, 'metadata'));
  checkAllowedTools(v, v.get(map, 'allowed-tools'));

  const tools = parseToolSelector(v, v.get(map, 'tools'));
  const frontmatter: (readonly [string, JsonValue])[] = v
    .keys(map)
    .map((key) => [key, v.plain(v.get(map, key))] as const);

  errors.push(...v.errors);
  if (errors.length > 0) return { errors, sourceFiles };

  const assets: SkillAsset[] = [];
  for (const file of walked.files) {
    if (file === SKILL_FILE) continue;
    assets.push({ path: file, bytes: await fs.readFileRaw(`${path}/${file}`) });
  }

  return {
    skill: {
      id,
      path,
      name: name ?? id,
      description: description ?? '',
      tools: tools ?? ALL_TOOLS,
      frontmatter,
      body,
      assets,
      source: { file: skillFile },
    },
    errors,
    sourceFiles,
  };
}

/** `metadata` is a map from string keys to string values (Agent Skills). */
function checkMetadata(v: Validator, node: Node | undefined): void {
  if (node === undefined) return;
  if (!isMap(node)) {
    v.fail(node, 'metadata', '`metadata` must be a mapping of strings to strings');
    return;
  }
  for (const item of node.items) {
    const value = item.value as Node | null;
    if (!isScalar(value) || typeof value.value !== 'string') {
      const key = isScalar(item.key) ? String(item.key.value) : '?';
      v.fail(
        value,
        `metadata.${key}`,
        `\`metadata.${key}\` must be a string`,
        'quote it, as in `version: "1.0"`',
      );
    }
  }
}

/**
 * The spec's form is a space-separated string; Claude Code also accepts a list. Both are
 * kept verbatim — only a value no tool reads is refused.
 */
function checkAllowedTools(v: Validator, node: Node | undefined): void {
  if (node === undefined) return;
  if (isScalar(node) && typeof node.value === 'string') return;
  if (isSeq(node)) {
    v.stringArray(node, 'allowed-tools');
    return;
  }
  v.fail(
    node,
    'allowed-tools',
    '`allowed-tools` must be a space-separated string or a list of strings',
  );
}

/**
 * Every file under a skill directory, relative to it and sorted. A symlink anywhere inside
 * is an error: a skill's files are copied into several tools' directories, and a link would
 * be followed out of the repository or duplicated as whatever it points at.
 */
async function walk(
  fs: ReadOnlyFileSystem,
  base: string,
  rel: string,
): Promise<{ files: string[]; errors: RulegateError[] }> {
  const files: string[] = [];
  const errors: RulegateError[] = [];
  const here = rel === '' ? base : `${base}/${rel}`;
  for (const entry of await fs.listDir(here)) {
    const child = rel === '' ? entry.name : `${rel}/${entry.name}`;
    if (entry.kind === 'symlink') {
      errors.push(
        invalid(
          `${base}/${child}`,
          'a skill may not contain a symlink',
          'replace it with the file itself',
        ),
      );
    } else if (entry.kind === 'dir') {
      const inner = await walk(fs, base, child);
      files.push(...inner.files);
      errors.push(...inner.errors);
    } else {
      files.push(child);
    }
  }
  return { files: files.sort(compareCodepoint), errors };
}
