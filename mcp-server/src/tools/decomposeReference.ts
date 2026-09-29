/**
 * MCP tool handler: `decompose_reference`.
 *
 * Phase 8 — deterministic, pixel-exact slicing of a large reference
 * sheet into individual page crops. Done entirely in code (no ChatGPT
 * round-trip): the crops ARE the reference, bit-for-bit regions of the
 * original. Every crop is written to disk immediately (instant
 * delivery) under `<workspace>/reference/pages/page-NN.png`.
 *
 * Accepted arguments:
 *   - reference_path   (string, required — absolute path to a PNG/JPEG sheet)
 *   - rows, cols       (numbers, optional — explicit grid mode)
 *   - max_pages        (number, optional — auto-mode cap, default 12, max 24)
 *   - workspace_root   (string, optional)
 */

import * as fsp from 'node:fs/promises';
import * as path from 'node:path';

import {
  cropToPng,
  decodeImage,
  sliceAuto,
  sliceByGrid,
} from '../referenceSlicer.js';
import {
  atomicWrite,
  fail,
  tryResolveWorkspace,
  type McpToolContext,
} from './common.js';

/** Arguments for `decompose_reference`. */
export interface DecomposeReferenceArgs {
  reference_path?: unknown;
  rows?: unknown;
  cols?: unknown;
  max_pages?: unknown;
  workspace_root?: unknown;
}

/** Success shape of {@link decomposeReference}. */
export interface DecomposeReferenceSuccess {
  ok: true;
  /** 'grid' when rows/cols were given, 'auto' for gutter detection. */
  mode: 'grid' | 'auto';
  count: number;
  savedPaths: string[];
  sourceWidth: number;
  sourceHeight: number;
}

export type DecomposeReferenceResult =
  | DecomposeReferenceSuccess
  | McpFailureType;

import type { McpFailure as McpFailureType } from './common.js';

/**
 * Run the `decompose_reference` tool. Read-only on the reference; every
 * crop is atomically written the moment it is computed.
 */
export async function decomposeReference(
  args: DecomposeReferenceArgs | undefined,
  ctx: McpToolContext,
): Promise<DecomposeReferenceResult> {
  const a = args ?? {};
  if (
    typeof a.reference_path !== 'string' ||
    a.reference_path.trim().length === 0
  ) {
    return fail(
      'SCHEMA_INVALID',
      'reference_path is required (absolute path to a PNG or JPEG sheet)',
    );
  }
  const ws = tryResolveWorkspace(
    ctx,
    typeof a.workspace_root === 'string' ? a.workspace_root : undefined,
  );
  if (ws.ok !== true) return ws;

  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await fsp.readFile(a.reference_path));
  } catch (err) {
    return fail(
      'SCHEMA_INVALID',
      `reference_path is unreadable: ${(err as Error).message}`,
    );
  }

  let img;
  try {
    img = decodeImage(bytes);
  } catch (err) {
    return fail('SCHEMA_INVALID', (err as Error).message);
  }

  const gridRows = typeof a.rows === 'number' ? Math.floor(a.rows) : 0;
  const gridCols = typeof a.cols === 'number' ? Math.floor(a.cols) : 0;
  const useGrid = gridRows >= 1 && gridCols >= 1;
  const maxPages =
    typeof a.max_pages === 'number' && a.max_pages >= 1
      ? Math.min(24, Math.floor(a.max_pages))
      : 12;

  const regions = useGrid
    ? sliceByGrid(img, gridRows, gridCols)
    : sliceAuto(img, maxPages);
  if (regions.length === 0) {
    return fail(
      'SCHEMA_INVALID',
      'no pages detected — pass rows and cols explicitly for sheets without clean gutters',
    );
  }

  const outDir = path.join(ws.workspaceRoot, 'reference', 'pages');
  const savedPaths: string[] = [];
  for (let i = 0; i < regions.length; i += 1) {
    const region = regions[i];
    if (region === undefined) break;
    const png = cropToPng(img, region);
    const target = path.join(outDir, `page-${String(i + 1).padStart(2, '0')}.png`);
    await atomicWrite(target, png);
    savedPaths.push(target);
  }

  return {
    ok: true,
    mode: useGrid ? 'grid' : 'auto',
    count: savedPaths.length,
    savedPaths,
    sourceWidth: img.width,
    sourceHeight: img.height,
  };
}
