/**
 * @file `commands/generateMissingAssets.ts` — registers the two
 * commands that drive the missing-asset workflow.
 *
 * Implements R30.6 (per-reference generate command, used by the code
 * lens) and R30.7 (`kiroGptBridge.generateMissingAssets` command that
 * scans the active editor, surfaces a single confirmation dialog, and
 * generates every missing reference in series).
 *
 * Two commands are registered:
 *  - `kiroGptBridge.generateMissingAsset` (singular) — invoked by the
 *    {@link import('../assets/missingAssetCodeLens.js').MissingAssetCodeLensProvider}
 *    with a {@link GenerateMissingAssetArg} payload. R30.6.
 *  - `kiroGptBridge.generateMissingAssets` (plural) — invoked manually
 *    or via the `generate-missing-assets.kiro.hook` (R32.4). Scans the
 *    active editor, presents one modal confirmation listing every
 *    missing asset, and generates them in series via
 *    {@link AssetGenerator.generate}. Series (not parallel) is
 *    deliberate — the relay's per-agent capacity is honoured. R30.7.
 *
 * The plural command obeys the user setting
 * `kiroGptBridge.autoGenerateAssets` (default true). When false the
 * command short-circuits with an info notification so a hook firing
 * from a `fileEdited` trigger never silently consumes relay capacity.
 *
 * Both paths thread `origin: 'missing-asset'` through to
 * {@link AssetGenerator.generate}, which surfaces the value on the
 * wire `Request.origin` field for relay-side structured logging
 * (R30.8).
 */

import * as fsSync from 'node:fs';
import * as path from 'node:path';

import * as vscode from 'vscode';

import type {
  AssetGenerator,
  GenerateOptions,
  ImageResult,
} from '../assets/assetGenerator.js';
import {
  scanMissingAssets,
  type MissingAssetHit,
} from '../assets/missingAssetScanner.js';
import type { GenerateMissingAssetArg } from '../assets/missingAssetCodeLens.js';

// ─── Constants ─────────────────────────────────────────────────────────────

/** Singular command id (per-lens). R30.6. */
const SINGLE_COMMAND_ID = 'kiroGptBridge.generateMissingAsset';

/** Plural command id (workspace-scan + bulk). R30.7. */
const BULK_COMMAND_ID = 'kiroGptBridge.generateMissingAssets';

/** Maximum prompt length seeded from alt + surrounding code (R29.2). */
const PROMPT_MAX_CHARS = 4000;

/** Number of source lines included around the reference (R30.6). */
const SURROUNDING_LINES = 5;

/** User setting controlling whether the bulk command runs. R32.7. */
const AUTO_GENERATE_SETTING = 'kiroGptBridge.autoGenerateAssets';

// ─── Public API ────────────────────────────────────────────────────────────

/**
 * Register both missing-asset commands. The returned disposables are
 * intended to be pushed onto `ctx.subscriptions` by the caller so VS
 * Code disposes them on extension deactivation.
 *
 * Implements R30.6 and R30.7.
 *
 * @param assetGenerator Wired {@link AssetGenerator} (owned by
 *                       `extension.ts`). Used for both the single-asset
 *                       and the bulk-generation paths.
 * @param ctx            VS Code activation context; reserved for future
 *                       per-context state (currently unused, but kept
 *                       in the signature so call sites match the
 *                       convention used elsewhere in the extension).
 * @returns              One disposable per registered command (length 2).
 */
export function registerMissingAssetCommands(
  assetGenerator: AssetGenerator,
  ctx: vscode.ExtensionContext,
): vscode.Disposable[] {
  void ctx; // reserved for future per-context state

  const singular = vscode.commands.registerCommand(
    SINGLE_COMMAND_ID,
    (arg: GenerateMissingAssetArg) =>
      runSingleMissingAsset(arg, assetGenerator),
  );

  const plural = vscode.commands.registerCommand(
    BULK_COMMAND_ID,
    () => runScanAndGenerateAll(assetGenerator),
  );

  return [singular, plural];
}

// ─── Singular: per-lens generation (R30.6) ─────────────────────────────────

/**
 * Run a single missing-asset generation triggered by a code lens
 * click. Shows a notification-area progress indicator while the
 * generation is in flight and surfaces the result via
 * {@link reportResult}.
 *
 * Implements R30.6.
 */
async function runSingleMissingAsset(
  arg: GenerateMissingAssetArg,
  assetGenerator: AssetGenerator,
): Promise<void> {
  if (!isGenerateMissingAssetArg(arg)) {
    void vscode.window.showErrorMessage(
      `${SINGLE_COMMAND_ID} called with invalid arguments`,
    );
    return;
  }

  const opts = buildGenerateOptionsFromHit(arg);
  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Generating ${path.basename(arg.path)}…`,
      cancellable: false,
    },
    async () => {
      const result = await assetGenerator.generate(opts);
      reportResult(result);
    },
  );
}

// ─── Plural: scan-then-confirm-then-generate (R30.7) ───────────────────────

/**
 * Implements R30.7: scan the active editor, present one confirmation
 * dialog enumerating every missing asset, and on confirm generate
 * each in series via {@link AssetGenerator.generate}. The series
 * ordering avoids agent contention per the design.
 *
 * Honours the user setting `kiroGptBridge.autoGenerateAssets` (R32.7):
 * when false the command short-circuits with an info notification
 * so hook-driven invocations never silently consume relay capacity
 * after the user has opted out.
 */
async function runScanAndGenerateAll(
  assetGenerator: AssetGenerator,
): Promise<void> {
  // R32.6 / R32.7: respect the auto-generation opt-out.
  const autoGenerate = vscode.workspace
    .getConfiguration()
    .get<boolean>(AUTO_GENERATE_SETTING, true);
  if (autoGenerate === false) {
    void vscode.window.showInformationMessage(
      `Auto-generation is disabled (${AUTO_GENERATE_SETTING} is false). Skipping.`,
    );
    return;
  }

  const editor = vscode.window.activeTextEditor;
  if (editor === undefined) {
    void vscode.window.showInformationMessage(
      'Open a file before running Generate Missing Visual Assets.',
    );
    return;
  }

  const workspaceRoot = currentWorkspaceRoot();
  if (workspaceRoot === null) {
    void vscode.window.showErrorMessage(
      'No workspace folder is open. Open a folder before generating assets.',
    );
    return;
  }

  const source = editor.document.getText();
  const hits = scanMissingAssets({
    source,
    workspaceRoot,
    documentDir: path.dirname(editor.document.uri.fsPath),
    existsFn: fsSync.existsSync,
  });

  if (hits.length === 0) {
    void vscode.window.showInformationMessage(
      'No missing image references found in the active editor.',
    );
    return;
  }

  // Single confirmation dialog listing every missing asset.
  const summary = buildConfirmationSummary(hits);
  const detail = hits
    .map((h) => `• ${path.relative(workspaceRoot, h.path)} (${h.inferredCategory})`)
    .join('\n');
  const choice = await vscode.window.showInformationMessage(
    summary,
    { modal: true, detail },
    'Generate All',
  );
  if (choice !== 'Generate All') return;

  // Generate in series so the relay's per-agent capacity is honoured.
  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: 'Generating missing visual assets',
      cancellable: false,
    },
    async (progress) => {
      const documentUri = editor.document.uri.toString();
      let done = 0;
      for (const hit of hits) {
        const baseName = path.basename(hit.path);
        progress.report({
          message: `${baseName} (${done + 1} of ${hits.length})`,
          increment: 100 / hits.length,
        });
        const arg: GenerateMissingAssetArg = {
          path: hit.path,
          altOrCaption: hit.altOrCaption,
          assetCategory: hit.inferredCategory,
          surroundingCode: extractSurroundingLines(
            source,
            hit.range.start,
            SURROUNDING_LINES,
          ),
          documentUri,
          range: hit.range,
        };
        const opts = buildGenerateOptionsFromHit(arg);
        const result = await assetGenerator.generate(opts);
        reportResult(result);
        done += 1;
      }
    },
  );
}

// ─── Helpers ───────────────────────────────────────────────────────────────

/**
 * Resolve the active workspace root, or `null` when no folder is open.
 * Mirrors the same logic used in `extension.ts` so the command reads
 * the same root the {@link AssetGenerator} will use.
 */
function currentWorkspaceRoot(): string | null {
  const folders = vscode.workspace.workspaceFolders;
  if (folders === undefined || folders.length === 0) return null;
  return folders[0]?.uri.fsPath ?? null;
}

/**
 * Build a {@link GenerateOptions} payload from a code-lens / hit
 * argument. Combines alt-text and surrounding code into the prompt,
 * preserves the explicit target path so the generated file lands at
 * the location the source already references, and sets
 * `overwrite: false` so the unique-suffix logic kicks in if the user
 * has saved a placeholder there.
 *
 * Threads `origin: 'missing-asset'` through to the
 * {@link AssetGenerator} so the relay-side logger can attribute the
 * Request to the missing-asset workflow (R30.8).
 */
function buildGenerateOptionsFromHit(
  arg: GenerateMissingAssetArg,
): GenerateOptions {
  const promptPieces: string[] = [];
  const trimmedAlt = arg.altOrCaption.trim();
  if (trimmedAlt.length > 0) {
    promptPieces.push(trimmedAlt);
  }
  if (arg.surroundingCode.trim().length > 0) {
    promptPieces.push(`Code context:\n${arg.surroundingCode}`);
  }
  // Final fallback so an empty alt + empty surrounding code does not
  // produce an INVALID_PROMPT — use the filename stem as a hint.
  if (promptPieces.length === 0) {
    promptPieces.push(`Image for ${path.basename(arg.path)}`);
  }
  let prompt = promptPieces.join('\n\n');
  if (prompt.length > PROMPT_MAX_CHARS) {
    prompt = prompt.slice(0, PROMPT_MAX_CHARS);
  }

  return {
    prompt,
    targetPath: arg.path,
    filename: path.basename(arg.path),
    assetCategory: arg.assetCategory,
    overwrite: false,
    origin: 'missing-asset',
  };
}

/**
 * Format the modal confirmation message. Kept short — the dialog's
 * `detail` line carries the per-asset breakdown.
 */
function buildConfirmationSummary(
  hits: ReadonlyArray<MissingAssetHit>,
): string {
  const n = hits.length;
  return `Generate ${n} missing visual asset${n === 1 ? '' : 's'} via ChatGPT Bridge?`;
}

/**
 * Show a result-appropriate VS Code notification. On success, includes
 * a "Reveal in Explorer" action (R29.8). On failure, shows the
 * `errorCode` so the user can act on it.
 */
function reportResult(result: ImageResult): void {
  if (result.errorCode !== undefined) {
    void vscode.window.showErrorMessage(
      `Generation failed (${result.errorCode}): ${result.message ?? ''}`,
    );
    return;
  }
  if (result.savedPath === undefined) return;
  const savedPath = result.savedPath;
  void vscode.window
    .showInformationMessage(`Saved ${savedPath}`, 'Reveal in Explorer')
    .then((choice) => {
      if (choice === 'Reveal in Explorer') {
        void vscode.commands.executeCommand(
          'revealFileInOS',
          vscode.Uri.file(savedPath),
        );
      }
    });
}

/**
 * Narrow runtime check that an opaque value matches the
 * {@link GenerateMissingAssetArg} shape. Defends against malformed
 * command invocations from external callers (e.g. user-authored
 * keybindings, hooks).
 */
function isGenerateMissingAssetArg(value: unknown): value is GenerateMissingAssetArg {
  if (value === null || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  if (
    typeof v.path !== 'string' ||
    typeof v.altOrCaption !== 'string' ||
    typeof v.assetCategory !== 'string' ||
    typeof v.surroundingCode !== 'string' ||
    typeof v.documentUri !== 'string' ||
    v.range === null ||
    typeof v.range !== 'object'
  ) {
    return false;
  }
  const r = v.range as Record<string, unknown>;
  return typeof r.start === 'number' && typeof r.end === 'number';
}

/**
 * Extract `count` lines around the character offset `start` from
 * `source`. The window is `[lineOf(start) - count, lineOf(start) +
 * count]` clamped to document boundaries. Pure helper used so the
 * bulk command can reproduce the surrounding-code seeding the code
 * lens does for the singular command.
 */
function extractSurroundingLines(
  source: string,
  start: number,
  count: number,
): string {
  // Translate `start` to a line index by counting newlines up to it.
  let line = 0;
  const limit = Math.min(start, source.length);
  for (let i = 0; i < limit; i += 1) {
    if (source.charCodeAt(i) === 10 /* \n */) {
      line += 1;
    }
  }
  const lines = source.split(/\r?\n/);
  const lo = Math.max(0, line - count);
  const hi = Math.min(lines.length, line + count + 1);
  return lines.slice(lo, hi).join('\n');
}
