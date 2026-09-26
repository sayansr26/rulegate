import { aider } from '@rulegate/adapter-aider';
import { antigravity } from '@rulegate/adapter-antigravity';
import { claudeCode } from '@rulegate/adapter-claude-code';
import { cline } from '@rulegate/adapter-cline';
import { codex } from '@rulegate/adapter-codex';
import { copilot } from '@rulegate/adapter-copilot';
import { cursor } from '@rulegate/adapter-cursor';
import { gemini } from '@rulegate/adapter-gemini';
import { kilo } from '@rulegate/adapter-kilo';
import { opencode } from '@rulegate/adapter-opencode';
import { rooCode } from '@rulegate/adapter-roo-code';
import { windsurf } from '@rulegate/adapter-windsurf';
import { zed } from '@rulegate/adapter-zed';
import type { Adapter } from '@rulegate/core';

/** Every adapter this build ships. Order here is irrelevant; the plan sorts output. */
export const ADAPTERS: readonly Adapter[] = [
  aider,
  antigravity,
  claudeCode,
  cline,
  codex,
  copilot,
  cursor,
  gemini,
  kilo,
  opencode,
  rooCode,
  windsurf,
  zed,
];

export const ADAPTER_NAMES: readonly string[] = ADAPTERS.map((a) => a.name);
