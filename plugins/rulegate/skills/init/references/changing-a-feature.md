# Changing an existing feature

The workflow for a request like _"change the login flow from email to OTP"_, or
any change to code that already exists.

The point is that **no step re-reads the codebase from scratch**. Structure comes
from the map, conventions come from the rules, and only the files actually being
changed get opened.

## Do not start by reading code

The instinct is to grep for `login` and start opening files. That costs a lot of
context, finds the obvious call sites and misses the non-obvious ones, and
produces a change written in the model's default style rather than this
codebase's.

## Step 1 — Ask the cartographer how it is built

> use the feature-cartographer: how is the login flow currently implemented?

It reads `_architecture.md` and any existing map first, explores only what is
missing, and returns about forty lines in **its** context, not yours:

```
Entry:      src/features/auth/LoginPage.tsx:24 (route /login)
Renders:    LoginForm.tsx, OtpDialog.tsx (already exists — used by password reset)
State:      authSlice — also read by the session provider
Network:    services/auth.api.ts -> POST /auth/login, POST /auth/refresh
Gated by:   nothing; /login is public

Blast radius
- useAuth() — imported by 14 files outside this feature
- authSlice.login — dispatched from 3 places

To change the login method, edit: services/auth.api.ts, LoginPage.tsx, authSlice.ts
Watch out
- OtpDialog already exists for password reset; reuse it rather than writing one
```

That last line is the whole argument for this step. A cold grep for `login` would
not have found the OTP dialog that already exists — and you would have built a
second one.

**In plan mode** the cartographer still comes first — plan mode's "Explore
agents only" phase is about not writing code, not about skipping the map. Ask it
read-only (_"read-only, plan mode: how is the login flow built?"_); it answers
and files nothing. The first step after plan mode ends is to call it again to
file the map. If the feature has no map at all and the user would rather not
wait, `/rulegate:map <feature>` before planning does the same job.

## Step 2 — Find the nearest precedent

Before designing anything, ask what this codebase already did that resembles the
change. An OTP flow somewhere else, a second auth method, a similar
service-and-slice pair. The cartographer's map will usually name it.

Matching an existing precedent is almost always better than a cleaner design that
matches nothing else in the repository.

## Step 3 — Let the rules load themselves

The path-scoped rules under `.claude/rules/` load when a matching file is
touched. Touching `src/features/auth/` brings in the feature rules; touching a
service brings in the service conventions. You do not need to fetch them, and you
should not paste them into the prompt.

If the rules layer does not exist yet, stop and read `establishing.md`. Making a
structural change to a codebase whose conventions are not written down means
inventing them in the diff.

## Step 4 — Build against the precedent

Dispatch `builder` with the cartographer's output, the precedent, and the files
to change — not with the original one-line request. An agent that receives
"change login to OTP" starts from nothing; one that receives the map, the
precedent and the file list starts where step 1 finished.

`builder` reads `CLAUDE.md` and the matching rules before writing, and matches the
nearest existing example for anything the rules do not cover.

## Step 5 — Review against the rules, not against taste

`reviewer` checks the diff against this project's documented rules first, then
correctness, security and the seams. A violation of a written project rule is the
highest-severity finding available, because the project already decided.

## Step 6 — Update the map, in the same turn

**The map is now stale.** The login flow no longer works the way its topic file
says it does.

Re-dispatch the cartographer to update the topic file for the area you changed,
or the change silently poisons the next question about it. A map that was right
last week and is wrong today is worse than no map, because it will be trusted.

This is the step that gets skipped. Treat it as part of the change, not as
follow-up work.

## What this costs

Roughly, for a feature change in a large codebase:

|                                | Cold                             | With the map                       |
| ------------------------------ | -------------------------------- | ---------------------------------- |
| Finding how it works           | 15–30 file reads in your context | ~40 lines returned from a subagent |
| Finding the conventions        | re-derived, inconsistently       | loaded automatically by path       |
| Finding the precedent          | usually missed                   | named in the map                   |
| Second change to the same area | the same cost again              | near zero                          |

The first question about an area is cheaper. Every question after it is close to
free. That is the point of writing the map down.
