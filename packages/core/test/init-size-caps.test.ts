import { describe, expect, it } from 'vitest';
import { ADAPTER_API_VERSION } from '../src/adapter/context.js';
import { MemoryFileSystem } from '../src/io/memory.js';
import { NOT_DETECTED } from '../src/adapter/adapter.js';
import { sizeCapWarnings } from '../src/init/size-caps.js';
import type { Adapter } from '../src/adapter/adapter.js';
import type { AdapterDocs } from '../src/adapter/docs.js';
import type { Artifact } from '../src/adapter/artifact.js';
import type { ToolId } from '../src/model/ids.js';

const source = { url: 'https://example.test/docs', title: 'Docs', retrieved: '2026-09-28' };

function tool(name: ToolId, pattern: string, limits: AdapterDocs['limits']): Adapter {
  return {
    name,
    apiVersion: ADAPTER_API_VERSION,
    detect: () => Promise.resolve(NOT_DETECTED),
    read: () => Promise.resolve({}),
    write: () => Promise.resolve([]),
    docs: {
      toolName: name.toUpperCase(),
      homepage: 'https://example.test',
      verifiedAgainst: { version: '1.x', date: '2026-09-28' },
      files: [
        {
          pattern,
          scope: 'project',
          role: 'instructions',
          managed: false,
          description: 'x',
          source,
        },
      ],
      ...(limits === undefined ? {} : { limits }),
    },
  };
}

const art = (path: string, bytes: number): Artifact => ({
  path,
  contents: `${'x'.repeat(bytes - 1)}\n`,
  adapter: 'maker',
  kind: 'rules',
  provenance: { ruleIds: ['a', 'b'] },
});

const capped = tool('capper', 'AGENTS.md', { maxBytesPerFile: 100 });

const run = (
  files: [string, string][],
  artifacts: Artifact[],
  adapters: Adapter[] = [capped],
  enabled: ToolId[] = [],
) => sizeCapWarnings({ fs: new MemoryFileSystem(files), artifacts, adapters, enabled });

describe('sizeCapWarnings — T150', () => {
  it('names the growth, the cap and the tool when a file crosses it', async () => {
    const [w, ...rest] = await run([['AGENTS.md', 'small\n']], [art('AGENTS.md', 150)]);
    expect(rest).toEqual([]);
    expect(w?.code).toBe('W_SIZE_CAP_CROSSED');
    expect(w?.message).toContain('AGENTS.md grows from 6 to 150 bytes');
    expect(w?.message).toContain('the 100-byte per-file limit CAPPER documents');
    expect(w?.message).toContain('CAPPER is not enabled here');
    expect(w?.hint).toContain('generated for maker from 2 rules');
  });

  it('drops the not-enabled note for a tool the manifest enables', async () => {
    const [w] = await run([], [art('AGENTS.md', 150)], [capped], ['capper']);
    expect(w?.message).toContain('AGENTS.md will be 150 bytes');
    expect(w?.message).not.toContain('not enabled');
  });

  it('says nothing for a file already over, at the cap, or read by no capped tool', async () => {
    // The negative controls. Already over is `doctor`'s to name — init did not cause it —
    // and exactly at the cap is under it, as `doctor` compares.
    expect(await run([['AGENTS.md', 'y'.repeat(200)]], [art('AGENTS.md', 300)])).toEqual([]);
    expect(await run([['AGENTS.md', 'small\n']], [art('AGENTS.md', 100)])).toEqual([]);
    expect(await run([], [art('OTHER.md', 500)])).toEqual([]);
    expect(await run([], [art('AGENTS.md', 500)], [tool('free', 'AGENTS.md', undefined)])).toEqual(
      [],
    );
  });

  it('counts a total cap the file passes alone, and names every tool it crosses', async () => {
    const total = tool('totaller', 'AGENTS.md', { maxTotalBytes: 120 });
    const [w] = await run([], [art('AGENTS.md', 150)], [total, capped], ['totaller']);
    expect(w?.message).toContain(
      'past the 100-byte per-file limit CAPPER documents and the 120-byte total limit TOTALLER documents',
    );
    expect(w?.message).toContain('CAPPER is not enabled here');
  });

  it('matches a nested entry at the root, as doctor does', async () => {
    const nested: Adapter = {
      ...capped,
      docs: {
        ...capped.docs,
        files: capped.docs.files.map((f) => ({ ...f, scope: 'nested' as const })),
      },
    };
    expect(await run([], [art('AGENTS.md', 150)], [nested])).toHaveLength(1);
    expect(await run([], [art('pkg/AGENTS.md', 150)], [nested])).toHaveLength(1);
  });
});
