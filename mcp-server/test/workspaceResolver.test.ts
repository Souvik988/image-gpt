/**
 * Unit tests for the workspace-root resolver.
 *
 * Covers the four-tier resolution order:
 *  1. Per-call argument wins over everything.
 *  2. `KIRO_GPT_MCP_WORKSPACE` env var when no per-call arg.
 *  3. `KIRO_GPT_MCP_DOWNLOAD_DIR` override for the local default.
 *  4. `<home>/Downloads/kiro-gpt-bridge` local-device default.
 * Plus the hard-error paths:
 *  - `disableLocalFallback` makes the resolver throw when unconfigured.
 *  - A missing home directory throws `WorkspaceRequiredError`.
 *
 * @packageDocumentation
 */

import { describe, expect, it } from 'vitest';
import * as path from 'node:path';

import {
  createWorkspaceResolver,
  WorkspaceRequiredError,
} from '../src/workspaceResolver.js';

describe('createWorkspaceResolver', () => {
  it('prefers the per-call argument over the env var and local default', () => {
    const resolver = createWorkspaceResolver({
      env: { KIRO_GPT_MCP_WORKSPACE: '/from/env' },
      homedir: () => '/home/user',
    });
    expect(resolver.resolve('/from/arg')).toBe('/from/arg');
  });

  it('falls back to KIRO_GPT_MCP_WORKSPACE when no per-call arg', () => {
    const resolver = createWorkspaceResolver({
      env: { KIRO_GPT_MCP_WORKSPACE: '/from/env' },
      homedir: () => '/home/user',
    });
    expect(resolver.resolve()).toBe('/from/env');
    expect(resolver.resolve('   ')).toBe('/from/env');
  });

  it('falls back to <home>/Downloads/kiro-gpt-bridge when nothing is configured', () => {
    const resolver = createWorkspaceResolver({
      env: {},
      homedir: () => path.join('/home', 'sayan'),
    });
    expect(resolver.resolve()).toBe(
      path.join('/home', 'sayan', 'Downloads', 'kiro-gpt-bridge'),
    );
  });

  it('honours KIRO_GPT_MCP_DOWNLOAD_DIR as the local default override', () => {
    const resolver = createWorkspaceResolver({
      env: { KIRO_GPT_MCP_DOWNLOAD_DIR: '/custom/downloads' },
      homedir: () => '/home/user',
    });
    expect(resolver.resolve()).toBe('/custom/downloads');
  });

  it('ranks the explicit workspace env above the download-dir override', () => {
    const resolver = createWorkspaceResolver({
      env: {
        KIRO_GPT_MCP_WORKSPACE: '/from/env',
        KIRO_GPT_MCP_DOWNLOAD_DIR: '/custom/downloads',
      },
      homedir: () => '/home/user',
    });
    expect(resolver.resolve()).toBe('/from/env');
  });

  it('throws WorkspaceRequiredError when local fallback is disabled and nothing is set', () => {
    const resolver = createWorkspaceResolver({
      env: {},
      homedir: () => '/home/user',
      disableLocalFallback: true,
    });
    expect(() => resolver.resolve()).toThrow(WorkspaceRequiredError);
  });

  it('throws WorkspaceRequiredError when no home directory is available', () => {
    const resolver = createWorkspaceResolver({
      env: {},
      homedir: () => '',
    });
    expect(() => resolver.resolve()).toThrow(WorkspaceRequiredError);
  });

  it('still resolves the per-call arg even when local fallback is disabled', () => {
    const resolver = createWorkspaceResolver({
      env: {},
      homedir: () => '/home/user',
      disableLocalFallback: true,
    });
    expect(resolver.resolve('/explicit')).toBe('/explicit');
  });
});
