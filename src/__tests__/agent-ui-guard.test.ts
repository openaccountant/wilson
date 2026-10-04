import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Source guards for the P1 UI (threat model T31). Audit args and operation
 * text are agent-influenced, so they render through React's escaping only.
 */
const UI = join(import.meta.dir, '../dashboard/ui/src');
const AGENT_DIR = join(UI, 'components/agent');

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? filesUnder(full) : [full];
  });
}

describe('agent UI source guards', () => {
  const files = filesUnder(AGENT_DIR).filter((f) => /\.tsx?$/.test(f));

  test('the control center components exist', () => {
    const names = files.map((f) => f.split('/').pop());
    for (const n of ['AgentAccessCenter.tsx', 'KillSwitch.tsx', 'ToolPolicyTable.tsx', 'GrantTtlSelect.tsx', 'PendingApprovalsList.tsx', 'AuditLogViewer.tsx', 'ClientTokensPanel.tsx', 'TokenRevealModal.tsx']) {
      expect(names).toContain(n);
    }
  });

  test('no dangerouslySetInnerHTML anywhere under components/agent', () => {
    for (const f of files) expect(readFileSync(f, 'utf8')).not.toContain('dangerouslySetInnerHTML');
  });

  test('agent-api is a thin wrapper over api(): no raw fetch', () => {
    const src = readFileSync(join(UI, 'lib/agent-api.ts'), 'utf8');
    expect(src).not.toMatch(/\bfetch\(/);
    expect(src).toContain("from '@/api'");
  });

  test('the components do not call fetch themselves either', () => {
    for (const f of files) expect(readFileSync(f, 'utf8')).not.toMatch(/\bfetch\(/);
  });

  test('Settings mounts AgentAccessCenter and no longer carries the old section', () => {
    const src = readFileSync(join(UI, 'tabs/SettingsTab.tsx'), 'utf8');
    expect(src).toContain('<AgentAccessCenter />');
    expect(src).not.toContain('AgentAccessSection');
    expect(src).not.toContain('function ClientTokensPanel');
  });

  test('the bridge uses no emoji and no pill radius (Forensic Noir)', () => {
    const src = readFileSync(join(import.meta.dir, '../dashboard/webmcp-bridge.ts'), 'utf8');
    expect(src).not.toMatch(/\p{Extended_Pictographic}/u);
    // The 8px status dot is a circle on purpose; every control and panel is a 6px square-ish box.
    expect(src).not.toMatch(/border-radius:\s*(20|999)/);
  });

  test('the extension warning is on the control center (T17)', () => {
    const all = files.map((f) => readFileSync(f, 'utf8')).join('\n');
    expect(all).toContain('Browser extensions with access to localhost can act as you');
  });
});

describe('bridge card stacking (T16 layout shift)', () => {
  test('a new card is prepended to the bottom-pinned column so existing cards keep their place', () => {
    const src = readFileSync(join(import.meta.dir, '../dashboard/webmcp-bridge.ts'), 'utf8');
    expect(src).toContain('getCardHost().prepend(node)');
    expect(src).not.toContain('getCardHost().appendChild(node)');
  });
});

describe('bridge card reachability', () => {
  const src = readFileSync(join(import.meta.dir, '../dashboard/webmcp-bridge.ts'), 'utf8');
  test('a card taller than the column scrolls inside itself so Approve/Reject stay reachable', () => {
    expect(src).toMatch(/max-height:calc\(90vh - \$\{MORE_NOTE_RESERVE_PX\}px\);overflow-y:auto/);
  });
  test('touch input never leaves a hover placeholder behind', () => {
    expect(src).toContain("lastPointerType !== 'touch' && host.matches(':hover')");
  });
});
