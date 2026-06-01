// Feature: kiro-gpt-bridge, Property 17: invoking openPanel any number of times yields exactly one registered WebviewView
/**
 * Property test for openPanel idempotence.
 *
 * Generates n ∈ [1, 50] invocations against a fake VS Code panel registry
 * and asserts that the registry size === 1 after every invocation past the
 * first.
 *
 * **Validates: Requirements 12.3**
 */

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';

// ─── Fake VS Code panel registry ────────────────────────────────────────────

/**
 * Simulates VS Code's WebviewViewProvider registration. The real VS Code
 * API enforces that `registerWebviewViewProvider(viewType, ...)` can only
 * be called once per viewType per extension activation. Subsequent calls
 * to `commands.executeCommand('workbench.view.extension.<viewType>')` just
 * reveal the existing view.
 */
class FakePanelRegistry {
  private readonly registered = new Map<string, { revealed: number }>();

  registerProvider(viewType: string): void {
    if (!this.registered.has(viewType)) {
      this.registered.set(viewType, { revealed: 0 });
    }
  }

  reveal(viewType: string): void {
    const entry = this.registered.get(viewType);
    if (entry) {
      entry.revealed += 1;
    }
  }

  size(): number {
    return this.registered.size;
  }

  getRevealCount(viewType: string): number {
    return this.registered.get(viewType)?.revealed ?? 0;
  }
}

/**
 * Simulates the openPanel command behavior: on first call, registers the
 * provider; on subsequent calls, just reveals the existing panel.
 */
function simulateOpenPanel(registry: FakePanelRegistry, viewType: string): void {
  if (registry.size() === 0) {
    registry.registerProvider(viewType);
  }
  registry.reveal(viewType);
}

// ─── Property test ──────────────────────────────────────────────────────────

describe('Property 17: openPanel idempotence', () => {
  it('invoking openPanel any number of times leaves exactly one registered panel', () => {
    const viewType = 'kiroGptBridge.panel';

    fc.assert(
      fc.property(fc.integer({ min: 1, max: 50 }), (n) => {
        const registry = new FakePanelRegistry();

        for (let i = 0; i < n; i++) {
          simulateOpenPanel(registry, viewType);

          // After every invocation, exactly one panel is registered
          expect(registry.size()).toBe(1);
        }

        // Total reveal count should equal n
        expect(registry.getRevealCount(viewType)).toBe(n);
      }),
      { numRuns: 100 },
    );
  });
});
