export type Tier = 'light' | 'standard' | 'deep' | 'max';

// 'auto' classifies each prompt; a tier pins it; 'off' leaves the session's own.
export type Mode = 'auto' | 'off' | Tier;

export type Route = { tier: Tier; reason: string };

declare module 'claude-code' {
  interface PluginState {
    'auto-route': { mode: Mode; route: Route | null };
  }
}
