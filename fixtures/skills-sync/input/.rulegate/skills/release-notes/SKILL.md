---
name: release-notes
description: Draft release notes from merged pull requests. Use when preparing a release or a changelog entry.
when_to_use: Asked for release notes, a changelog, or what shipped since the last tag.
disable-model-invocation: true
allowed-tools: Read Grep Bash(git log:*)
paths:
  - CHANGELOG.md
  - docs/releases/**
---

# Release notes

1. List the pull requests merged since the last tag.
2. Group them with `templates/notes.md`.
3. Put the logo from `assets/logo.png` at the top.
