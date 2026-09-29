/**
 * MCP tool handler: `analyze_design`.
 *
 * Phase 3 UI-understanding tool — read-only. Scans the workspace
 * (framework fingerprints, Tailwind config, CSS custom properties,
 * package.json) and returns the distilled {@link DesignContext} as
 * structured JSON plus a human-readable brief. Calling agents use this
 * to "understand the UI" before composing generation briefs or writing
 * frontend code.
 *
 * Accepted arguments:
 *   - workspace_root   (string, overrides KIRO_GPT_MCP_WORKSPACE)
 */

import { analyzeDesignContext } from '../designContext.js';
import {
  fail,
  tryResolveWorkspace,
  type McpToolContext,
} from './common.js';

/** Arguments for `analyze_design`. */
export interface AnalyzeDesignArgs {
  workspace_root?: unknown;
}

/** Success shape of {@link analyzeDesign}. */
export interface AnalyzeDesignSuccess {
  ok: true;
  /** Distilled design system. */
  design: {
    framework: string;
    brandName?: string;
    colors: string[];
    fonts: string[];
    radii: string[];
    packages: string[];
    darkMode: boolean;
  };
  /** Human-readable one-line brief (also injected into prompts). */
  designBrief: string;
}

/** Result of {@link analyzeDesign}. */
export type AnalyzeDesignResult = AnalyzeDesignSuccess | McpFailureShape;

import type { McpFailure as McpFailureShape } from './common.js';

/**
 * Run the `analyze_design` tool. Read-only: touches no files, submits
 * no relay requests, never requires a relay connection.
 */
export async function analyzeDesign(
  args: AnalyzeDesignArgs | undefined,
  ctx: McpToolContext,
): Promise<AnalyzeDesignResult> {
  const a = args ?? {};
  const workspaceArg =
    typeof a.workspace_root === 'string' ? a.workspace_root : undefined;

  const ws = tryResolveWorkspace(ctx, workspaceArg);
  if (ws.ok !== true) return ws;

  try {
    const design = await analyzeDesignContext(ws.workspaceRoot);
    return {
      ok: true,
      design: {
        framework: design.framework,
        ...(design.brandName !== undefined ? { brandName: design.brandName } : {}),
        colors: design.colors,
        fonts: design.fonts,
        radii: design.radii,
        packages: design.packages,
        darkMode: design.darkMode,
      },
      designBrief: design.brief,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return fail('WORKSPACE_REQUIRED', `design analysis failed: ${message}`);
  }
}
