# Writing rules files and trimming CLAUDE.md

Read this when the audit reports an over-budget CLAUDE.md, a rule without
`paths:`, or when you are creating the rules layer from scratch.

**In a project with `.rulegate/`**, everything below applies to the canonical rules
instead: write `.rulegate/rules/<name>.md` with `globs:` where this says `paths:`,
trim a rule rather than `CLAUDE.md`, and run `rulegate sync`. The files under
`.claude/`, and `CLAUDE.md` itself, are generated from them.

## Write the rules files

Group by **what the reader is touching**, not by topic. A rule earns its keep
when its `paths:` are narrow enough that it is absent most of the time.

```markdown
---
paths:
  - 'src/features/**'
  - 'src/pages/**'
---

# Working inside a feature

...
```

Rules of thumb:

- Every rule file gets `paths:`. No exceptions — an unscoped rule belongs in
  CLAUDE.md or nowhere.
- If two rules would always match together, they are one rule.
- If a rule matches all of `src/**`, it had better be the single most important
  convention in the repo. One such rule is defensible; three is a handbook.
- Dense agent notes, not prose docs: invariants, terse bullets, the non-obvious.
  Skip rationale and examples unless they prevent a likely mistake.
- A gotcha is worth more than a description. "X is at Y" is derivable; "X looks
  like it is at Y but is actually at Z, and the project's own docs say otherwise"
  is not.

## Trim CLAUDE.md

Target ≤200 lines; aim for ~150. Keep:

- How to run, build and verify — and whatever the user does _not_ want run
  automatically.
- The hard rules, one line each, with a pointer to the rule file for detail.
- The definition of done.
- What automations exist (hooks, subagents, skills, MCP), briefly.
- A table of the rule files and what each covers, so the layout is discoverable.

Cut: directory tours, dependency lists, architecture narration, anything a
`ls`/`Grep` answers, anything a rule file now owns, and any instruction that is
really a personal preference (that belongs in `~/.claude/CLAUDE.md`, once,
globally — not re-typed per project).
