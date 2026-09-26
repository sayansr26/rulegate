# Git permission rules — block writes, keep reads

A `permissions.deny` set that blocks every git command which changes the
repository, while leaving read-only inspection (`status`, `log`, `diff`, `show`,
`blame`, `rev-parse`, `ls-files`, `describe`, `grep`, `shortlog`, …) available.

You do not paste this. `dist/settings.js` applies it — to the project's
`.claude/settings.json`, `~/.claude/settings.json`, or both — merged into what
is already there, as part of `/rulegate:init`.
The list lives in that script (`GIT_DENY`); it is reproduced here so the
judgment calls below have something to point at.

```json
{
  "permissions": {
    "deny": [
      "Bash(git -C*)",
      "Bash(git -c*)",
      "Bash(git --git-dir*)",
      "Bash(git --work-tree*)",
      "Bash(git --exec-path*)",

      "Bash(git add *)",
      "Bash(git am *)",
      "Bash(git apply *)",
      "Bash(git bisect *)",
      "Bash(git branch *)",
      "Bash(git checkout *)",
      "Bash(git cherry-pick *)",
      "Bash(git clean *)",
      "Bash(git clone *)",
      "Bash(git commit *)",
      "Bash(git config *)",
      "Bash(git fast-import *)",
      "Bash(git filter-branch *)",
      "Bash(git gc *)",
      "Bash(git init *)",
      "Bash(git merge *)",
      "Bash(git mv *)",
      "Bash(git notes *)",
      "Bash(git prune *)",
      "Bash(git pull *)",
      "Bash(git push *)",
      "Bash(git rebase *)",
      "Bash(git reflog *)",
      "Bash(git remote *)",
      "Bash(git repack *)",
      "Bash(git replace *)",
      "Bash(git reset *)",
      "Bash(git restore *)",
      "Bash(git revert *)",
      "Bash(git rm *)",
      "Bash(git stash *)",
      "Bash(git submodule *)",
      "Bash(git switch *)",
      "Bash(git symbolic-ref *)",
      "Bash(git tag *)",
      "Bash(git update-ref *)",
      "Bash(git worktree *)"
    ]
  }
}
```

## Why the first five entries matter

Without them the rest of the list is decorative. Claude Code matches a Bash rule
literally on the words before the first `*`, so `Bash(git commit *)` does **not**
match any of these:

```
git -C . commit -m "..."
git -c user.email=x@y commit -m "..."
git --git-dir=.git --work-tree=. commit -m "..."
```

`git -C` and `git -c` run any subcommand with a different directory or config,
which walks straight past a per-subcommand list. Denying the flag forms outright
closes that. The cost is that `git -C <path> status` is blocked too — `cd` there
instead.

## What this does not stop

**Quoting.** `git 'commit' -m "..."` does not match `Bash(git commit *)` either,
and there is no pattern that enumerates every quoting variant. Treat this list as
a strong guardrail against an agent doing the wrong thing by default, not as a
boundary against one determined to get around it.

If you need a hard boundary, there are two options, and both cost you read-only
git:

- `"deny": ["Bash(git:*)"]` — one rule, matches every invocation including the
  flag and quoted forms.
- A `PreToolUse` hook that parses the command itself and exits non-zero.

Deny cannot carry allow exceptions — deny is evaluated first and always wins — so
you cannot pair a broad rule with `allow: ["Bash(git status *)"]` to get both.

## Judgment calls in this list

- **`git fetch` is allowed.** It writes remote-tracking refs but cannot touch the
  working tree, index, HEAD, or a local branch, and blocking it breaks legitimate
  inspection of remote state. Add `"Bash(git fetch *)"` if you disagree.
- **`git reflog` is denied** because `reflog expire` and `reflog delete` destroy
  recovery history. That also blocks the read form; `git log -g` is an
  unrestricted equivalent.
- **`git tag` is denied** wholesale, which also blocks listing tags. Use
  `git for-each-ref refs/tags` to list them.

## How the rules behave

- A deny rule matches inside compound commands, subshells, command substitution
  and control-flow bodies, so `cd /tmp && git clean -f` and `echo "$(git reset
--hard)"` are both blocked.
- A deny rule matches past a leading environment assignment, so
  `GIT_AUTHOR_NAME=x git commit` is blocked.
- `Bash(git commit *)` and `Bash(git commit:*)` are equivalent; the `:*` suffix is
  just another way to write a trailing wildcard. It only works at the end of a
  pattern — `Bash(git:* push)` treats the colon as a literal character.
- A trailing `* ` with a space also matches the bare command, so
  `Bash(git push *)` blocks `git push` on its own.
