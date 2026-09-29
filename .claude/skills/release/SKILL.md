---
name: release
description: Decide whether Rulegate is due a release and prepare it — version bump across every manifest, CHANGELOG, README, regenerated output, the full CI gate — then hand the maintainer the commit, tag and push. Never publishes, tags or pushes itself.
---

# Release

A release is a `v*` tag pushed to GitHub: `release.yml` re-runs every CI gate, checks the
tag against `packages/cli/package.json`, and publishes all workspace packages to npm. The
plugin ships the same way — Claude Code reads `.claude-plugin/marketplace.json` from the
pushed repository — so **the tag is the release for both the CLI and the plugin**. npm
versions are immutable: a mistake found after the push costs a version number.

Your job ends at a verified, uncommitted release change. The maintainer commits, tags and
pushes; do not run git writes, `npm publish` or `pnpm publish`.

## 1. Is a release due?

```bash
node .claude/hooks/release-status.mjs --json
```

The SessionStart hook prints the short form of this. Read:

- `due` — commits since the last tag **and** entries under `[Unreleased]`. Not due → stop
  and say so.
- `blockers` — release gates (`RELEASE_GATES` in the hook; currently T109, M5's
  GO/NO-GO), manifests that disagree, or a bump already in flight. Any blocker → stop, name
  it, and say what clears it. Do not work around a gate; the maintainer moves it.
- `uncommittedFiles` — must be 0 before you start, so the release diff is only the release.
- `suggestedVersion` — pre-1.0, `### Breaking` or `### Added` moves the minor, anything
  else the patch. Confirm the version with the maintainer before bumping.

Also check, read-only, that `master` is not behind `origin/master` (`git status -sb`) and
that CI is green on HEAD (ask the maintainer, or `gh run list --branch master --limit 1`).

## 2. First-time npm names

`release.yml` publishes every non-private workspace package (`pnpm publish -r`). A package
that has never been published needs the maintainer to confirm the name is theirs to take.
Compare the manifest list from step 1 against the previous release tag
(`git show <lastTag>:packages/...` or `git diff --stat <lastTag> -- packages/*/package.json packages/adapters/*/package.json`)
and list every new package name. Ask the maintainer to run `npm view <name>` for each — do
not run it yourself.

## 3. Bump and close the CHANGELOG

```bash
node .claude/skills/release/bump.mjs <x.y.z>          # preview
node .claude/skills/release/bump.mjs <x.y.z> --yes    # write
```

It sets one version in every `packages/*/package.json`, `packages/adapters/*/package.json`,
`plugins/rulegate/package.json`, `plugins/rulegate/.claude-plugin/plugin.json` and
`.claude-plugin/marketplace.json` (the Action versions separately and is left alone),
renames `[Unreleased]` to `[x.y.z] — <today>` under a fresh empty `[Unreleased]`, and
updates the compare links at the bottom. It refuses while a gate is open.

Then edit `CHANGELOG.md` by hand:

- Read the new section top to bottom as a user upgrading would. Every `### Breaking` entry
  says what to do, not only what changed.
- `### Internal` entries are for contributors; keep them brief or fold them.
- An older heading still reading `— unreleased` for a version that was tagged gets its tag
  date (`git log -1 --format=%cs v<old>`).

## 4. README and docs

- `grep -rn "<old version>" README.md docs/ action/README.md` and update what refers to the
  current release (the early-release note near the top of README, install lines). Leave
  historical mentions such as the PRD's milestones.
- New commands, flags or adapters in this release need at least a line in README; the long
  form belongs in `docs/`.
- Never edit generated files (`docs/tools/`, `docs/adapters.md`, the dogfood agent files);
  regenerate them in step 5.

## 5. Regenerate and verify

```bash
pnpm build
node scripts/generate-docs.mjs
node action/build.mjs
node plugins/rulegate/build.mjs
node packages/cli/dist/bin.js sync
```

Then run `/verify-full` and additionally:

```bash
node scripts/validate-plugin.mjs    # plugin.json, marketplace.json and the CLI agree
node scripts/smoke.mjs              # packs every package and runs init → sync → check
pnpm format
```

Every gate green, or stop and report which one failed.

## 6. Record it

If `task-breakdown.md` exists, log the release under the milestone's task with the version,
the date and what it contains, and mark any task whose completion was the release.

## 7. Hand off

Print, for the maintainer to run:

```bash
git add -A
git commit -m "release: v<x.y.z>"
git tag v<x.y.z>
git push origin master
git push origin v<x.y.z>
```

Push the tag by name. `git tag` without `-a` makes a lightweight tag, and `--follow-tags`
pushes only annotated ones, so it leaves the tag behind and `release.yml` never starts
(v0.4.0 hit exactly this). Confirm with `git ls-remote --tags origin v<x.y.z>`.

and what follows the push:

- Watch the `Release` workflow; it re-runs every gate before uploading. A red run uploads
  nothing, so fix forward with a new commit and re-tag only if nothing was published.
- After it succeeds: `npm view rulegate version` shows `<x.y.z>`; in Claude Code,
  `/plugin marketplace update rulegate` then `/plugin update rulegate@rulegate` picks up the
  plugin; draft a GitHub Release from the CHANGELOG section (T111).
- Homebrew (T061) follows about a day later, not at release time: Homebrew refuses npm
  dependencies younger than a day, so the scheduled `Homebrew` workflow (every 6 hours, or run
  it by hand) moves `sayansr26/homebrew-rulegate` to `<x.y.z>` once every package has been on
  npm for 25 hours, then installs, audits and tests it on macOS. A red run never touches npm:
  fix `scripts/stage-homebrew-tap.mjs` or the `HOMEBREW_TAP_TOKEN` secret and run it again.
  Until then `brew info sayansr26/rulegate/rulegate` still shows the previous version.
- Provenance: `verify-published.mjs --attestations` fails the run unless every package has a
  signed attestation (T092, since v0.4.1). A green run means the release is signed.
