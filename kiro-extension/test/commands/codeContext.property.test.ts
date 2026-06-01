// Feature: kiro-gpt-bridge, Property 15: every code-aware command produces a Request with codeContext.{filePath,language} populated and selection length within 1..100000
/**
 * Property test for code-aware command CodeContext fields.
 *
 * Generates `(selectionLen ∈ [1,10000], filePath, language)` triples with
 * non-empty values; mocks `vscode.window.activeTextEditor`; runs each
 * code-aware command and asserts the outgoing `codeContext.selection`,
 * `.filePath`, `.language` are all non-empty and that the selection
 * length stays within `[1, 100000]`.
 *
 * **Validates: Requirements 13.3**
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fc from 'fast-check';

// ─── Stub VS Code host ──────────────────────────────────────────────────────

interface StubSelection {
  isEmpty: boolean;
}

interface StubDocument {
  uri: { fsPath: string };
  languageId: string;
  getText(range?: unknown): string;
}

interface StubEditor {
  document: StubDocument;
  selection: StubSelection;
}

interface RegisteredCommand {
  id: string;
  callback: () => Promise<void> | void;
}

interface VsCodeStubState {
  activeTextEditor: StubEditor | null;
  registered: RegisteredCommand[];
  shownErrors: string[];
}

const vsState: VsCodeStubState = {
  activeTextEditor: null,
  registered: [],
  shownErrors: [],
};

vi.mock('vscode', () => {
  return {
    commands: {
      registerCommand(
        id: string,
        callback: () => Promise<void> | void,
      ): { dispose(): void } {
        vsState.registered.push({ id, callback });
        return { dispose: (): void => {} };
      },
    },
    window: {
      get activeTextEditor(): StubEditor | null {
        return vsState.activeTextEditor;
      },
      showErrorMessage(message: string): Promise<undefined> {
        vsState.shownErrors.push(message);
        return Promise.resolve(undefined);
      },
    },
  };
});

// Imports must come AFTER vi.mock so the mocked module is loaded.
import { registerCodeAwareCommands } from '../../src/commands/codeAwareCommands.js';
import type { ExtensionRelayClient } from '../../src/relay/relayClient.js';
import type { ChatGptPanelProvider } from '../../src/webview/panelProvider.js';
import type { Request, ClientId, SessionId } from '@kiro-gpt-bridge/shared';

// ─── Stub relay client + panel provider ─────────────────────────────────────

interface RecordingRelay {
  client: ExtensionRelayClient;
  submitted: Request[];
}

function createRecordingRelay(): RecordingRelay {
  const submitted: Request[] = [];
  const client: ExtensionRelayClient = {
    start: () => Promise.resolve(),
    stop: () => {},
    isConnected: () => true,
    clientId: (): ClientId | null => 'client-test-1234',
    submit: (request: Request) => {
      submitted.push(request);
    },
    cancel: () => {},
    onStreamChunk: () => {},
    onRequestStatus: () => {},
    onAgentStatus: () => {},
    onServerStatus: () => {},
    onConnectionChange: () => {},
    getInflight: () => [],
    getInflightMap: () => new Map(),
  };
  return { client, submitted };
}

interface RecordingPanel {
  provider: ChatGptPanelProvider;
  getRevealCount(): number;
}

function createRecordingPanelProvider(): RecordingPanel {
  let revealCount = 0;
  const provider = {
    reveal(): Promise<void> {
      revealCount += 1;
      return Promise.resolve();
    },
  } as unknown as ChatGptPanelProvider;
  return {
    provider,
    getRevealCount: (): number => revealCount,
  };
}

// ─── Generators ─────────────────────────────────────────────────────────────

const filePathArb = fc
  .tuple(
    fc.constantFrom('C:/repo', '/home/user', '/workspace'),
    fc.array(fc.stringMatching(/^[a-z][a-z0-9_-]{0,15}$/), {
      minLength: 1,
      maxLength: 4,
    }),
    fc.constantFrom('.ts', '.js', '.py', '.rs', '.go'),
  )
  .map(([base, parts, ext]) => `${base}/${parts.join('/')}${ext}`);

const languageArb = fc.constantFrom(
  'typescript',
  'javascript',
  'python',
  'rust',
  'go',
  'java',
);

// Selection is built from printable ASCII so .length === character length.
const selectionTextArb = fc.stringOf(
  fc.constantFrom(
    ...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 (){};=\n+'.split(
      '',
    ),
  ),
  { minLength: 1, maxLength: 10_000 },
);

const commandIdArb = fc.constantFrom(
  // Excludes `kiroGptBridge.explainCode` which has a tighter cap (10000)
  // already enforced by the generator's selection bound, but the property
  // here covers the broader 1..100000 contract — which all six commands
  // share.
  'kiroGptBridge.refactorCode',
  'kiroGptBridge.generateTests',
  'kiroGptBridge.documentCode',
  'kiroGptBridge.findBugs',
  'kiroGptBridge.optimizeCode',
  'kiroGptBridge.explainCode',
);

// ─── Property test ──────────────────────────────────────────────────────────

describe('Property 15: code-aware command CodeContext fields', () => {
  beforeEach(() => {
    vsState.activeTextEditor = null;
    vsState.registered = [];
    vsState.shownErrors = [];
  });

  it('every code-aware command produces a Request with non-empty selection, filePath, language and selection length within [1, 100000]', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          commandId: commandIdArb,
          filePath: filePathArb,
          language: languageArb,
          selection: selectionTextArb,
        }),
        async ({ commandId, filePath, language, selection }) => {
          // Reset state per-run so each invocation is hermetic.
          vsState.registered = [];
          vsState.shownErrors = [];

          const relay = createRecordingRelay();
          const panel = createRecordingPanelProvider();
          const sessionId: SessionId = 'session-test-1234';

          const stubEditor: StubEditor = {
            document: {
              uri: { fsPath: filePath },
              languageId: language,
              getText: (_range?: unknown): string => selection,
            },
            selection: { isEmpty: false },
          };
          vsState.activeTextEditor = stubEditor;

          const disposables = registerCodeAwareCommands(
            relay.client,
            panel.provider,
            (): SessionId => sessionId,
          );

          // Find the registered command and invoke it.
          const cmd = vsState.registered.find((c) => c.id === commandId);
          expect(cmd).toBeDefined();
          await cmd!.callback();

          // Cleanup registrations between iterations.
          for (const d of disposables) d.dispose();

          // The relay must have received exactly one Request and the panel
          // must have been revealed before submission (R12.4).
          expect(relay.submitted).toHaveLength(1);
          expect(panel.getRevealCount()).toBeGreaterThanOrEqual(1);

          const submitted = relay.submitted[0]!;
          expect(submitted.codeContext).toBeDefined();
          const cc = submitted.codeContext!;

          // P15: filePath populated (non-empty).
          expect(typeof cc.filePath).toBe('string');
          expect(cc.filePath!.length).toBeGreaterThan(0);
          expect(cc.filePath).toBe(filePath);

          // P15: language populated (non-empty).
          expect(typeof cc.language).toBe('string');
          expect(cc.language!.length).toBeGreaterThan(0);
          expect(cc.language).toBe(language);

          // P15: selection length within [1, 100000].
          expect(typeof cc.selection).toBe('string');
          const selOut = cc.selection!;
          expect(selOut.length).toBeGreaterThanOrEqual(1);
          expect(selOut.length).toBeLessThanOrEqual(100_000);
          expect(selOut).toBe(selection);
        },
      ),
      { numRuns: 100 },
    );
  });
});
