/**
 * Workspace-root resolver for the MCP server.
 *
 * Implements R31.5 (workspace root configurable via env var
 * `KIRO_GPT_MCP_WORKSPACE` or per-tool-call argument).
 *
 * Resolution priority:
 *   1. The per-call `workspaceRoot` argument (if provided and non-empty).
 *   2. The `KIRO_GPT_MCP_WORKSPACE` environment variable (if set and
 *      non-empty at the time of {@link createWorkspaceResolver}).
 *   3. The local-device default download directory — the user's OS
 *      "Downloads" folder (`<home>/Downloads`), or a `kiro-gpt-bridge`
 *      subfolder under it, so the server "just works" out of the box
 *      without any configuration. This is the behaviour most users want
 *      when they install the published MCP server: every generated asset
 *      lands somewhere predictable on their own machine.
 *
 * The local-device default can be overridden with the
 * `KIRO_GPT_MCP_DOWNLOAD_DIR` env var for users who want a specific
 * folder. When even the home directory cannot be determined (extremely
 * locked-down environments), {@link WorkspaceResolver.resolve} throws a
 * {@link WorkspaceRequiredError} so the calling tool handler can convert
 * it into the MCP `WORKSPACE_REQUIRED` error code.
 *
 * The env vars are captured once at construction time so a test can stub
 * `process.env` deterministically; production callers create a single
 * resolver during {@link import('./index.js')} boot.
 */

import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Error thrown by {@link WorkspaceResolver.resolve} when no workspace
 * root is configured and no local-device default could be determined.
 * Tool handlers translate this into the MCP error code
 * `WORKSPACE_REQUIRED` (R31.5, R31.7).
 */
export class WorkspaceRequiredError extends Error {
  /** Discriminator so `instanceof` checks work after structuredClone etc. */
  public readonly code = 'WORKSPACE_REQUIRED' as const;

  /**
   * Create a new {@link WorkspaceRequiredError}.
   * @param message Human-readable supplement; not user-facing copy.
   */
  constructor(message: string) {
    super(message);
    this.name = 'WorkspaceRequiredError';
  }
}

/** Public surface of the resolver. */
export interface WorkspaceResolver {
  /**
   * Resolve the workspace root for the current MCP tool call.
   *
   * @param perCallArg Optional workspace root passed in the tool args.
   * @returns The resolved absolute path string.
   * @throws {WorkspaceRequiredError} When no per-call arg, env var, or
   *   local-device default could be resolved.
   */
  resolve(perCallArg?: string): string;
}

/**
 * Construction options for {@link createWorkspaceResolver}. The single
 * injection point (`env`) defaults to {@link process.env} and is only
 * overridden by unit tests. `homedir` is injectable for the same reason.
 */
export interface WorkspaceResolverOptions {
  /** Process environment to read at construction time. */
  env?: NodeJS.ProcessEnv;
  /**
   * Home-directory provider. Defaults to {@link os.homedir}. Injected by
   * tests to exercise the local-device fallback deterministically.
   */
  homedir?: () => string;
  /**
   * When `true`, disable the local-device Downloads fallback so the
   * resolver throws {@link WorkspaceRequiredError} if neither the
   * per-call arg nor the env var is set. Used by hosts (e.g. the IDE
   * extension) that always supply an explicit workspace and want a hard
   * error otherwise. Defaults to `false` (fallback enabled).
   */
  disableLocalFallback?: boolean;
}

/**
 * Compute the local-device default download directory.
 *
 * Priority:
 *   1. `KIRO_GPT_MCP_DOWNLOAD_DIR` env var (explicit override).
 *   2. `<home>/Downloads/kiro-gpt-bridge` when a home dir is available.
 *
 * Returns `null` when no home directory can be determined.
 */
function resolveLocalDefault(
  env: NodeJS.ProcessEnv,
  homedir: () => string,
): string | null {
  const override = env.KIRO_GPT_MCP_DOWNLOAD_DIR;
  if (typeof override === 'string' && override.trim() !== '') {
    return override;
  }

  let home = '';
  try {
    home = homedir();
  } catch {
    home = '';
  }
  if (typeof home !== 'string' || home.trim() === '') {
    return null;
  }

  // `<home>/Downloads/kiro-gpt-bridge` keeps generated assets grouped in
  // one predictable place on the user's own machine rather than dumping
  // them loose into Downloads.
  return path.join(home, 'Downloads', 'kiro-gpt-bridge');
}

/**
 * Build a {@link WorkspaceResolver} that consults — in priority order —
 * the per-call argument, the `KIRO_GPT_MCP_WORKSPACE` env var, and
 * finally the local-device default download directory, all captured at
 * construction time.
 *
 * Implements R31.5.
 */
export function createWorkspaceResolver(
  opts: WorkspaceResolverOptions = {},
): WorkspaceResolver {
  const env: NodeJS.ProcessEnv = opts.env ?? process.env;
  const homedir: () => string = opts.homedir ?? os.homedir;
  const disableLocalFallback: boolean = opts.disableLocalFallback === true;

  const envRootRaw: string | undefined = env.KIRO_GPT_MCP_WORKSPACE;
  const envRoot: string | null =
    typeof envRootRaw === 'string' && envRootRaw.trim() !== ''
      ? envRootRaw
      : null;

  const localDefault: string | null = disableLocalFallback
    ? null
    : resolveLocalDefault(env, homedir);

  return {
    resolve(perCallArg?: string): string {
      if (typeof perCallArg === 'string' && perCallArg.trim() !== '') {
        return perCallArg;
      }
      if (envRoot !== null) {
        return envRoot;
      }
      if (localDefault !== null) {
        return localDefault;
      }
      throw new WorkspaceRequiredError(
        'WORKSPACE_REQUIRED: set KIRO_GPT_MCP_WORKSPACE env, pass workspaceRoot per-call, or ensure a home directory is available for the local Downloads default',
      );
    },
  };
}
