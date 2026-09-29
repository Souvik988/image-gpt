/**
 * MCP tool handler: `generate_from_reference`.
 *
 * Phase 8 — the full reference-decomposition pipeline:
 *
 *   1. Slice the reference sheet into page crops (deterministic, local)
 *      and write each crop to disk IMMEDIATELY.
 *   2. For every page: submit a generation with the crop ATTACHED so
 *      ChatGPT sees the reference, recreating the page as a production
 *      mockup. Each mockup is written to disk the moment its bytes
 *      arrive — per-asset instant delivery, never batched at the end.
 *   3. For every page: extract each requested element (logo, nav bar,
 *      buttons, icons…) as standalone PNGs at the requested pixel
 *      sizes, again with the page crop attached as the visual
 *      reference, again writing each file on arrival.
 *
 * Resilience: every generation goes through the policy-retry submit
 * path; a failed page/element is recorded and the pipeline CONTINUES —
 * one bad asset never aborts the batch.
 */

import * as fsp from 'node:fs/promises';
import * as path from 'node:path';

import type { Attachment } from '@kiro-gpt-bridge/shared';

import { analyzeDesignContext } from '../designContext.js';
import {
  cropToPng,
  decodeImage,
  sliceAuto,
  sliceByGrid,
  type SliceRegion,
} from '../referenceSlicer.js';
import { composePrompt } from '../promptComposer.js';
import {
  atomicWrite,
  decodeFinalChunk,
  fail,
  resolveTargetPath,
  submitImageRequest,
  tryResolveWorkspace,
  type McpFailure,
  type McpToolContext,
} from './common.js';

/** Arguments for `generate_from_reference`. */
export interface GenerateFromReferenceArgs {
  reference_path?: unknown;
  rows?: unknown;
  cols?: unknown;
  max_pages?: unknown;
  workspace_root?: unknown;
  framework?: unknown;
  /** Generate per-page element assets (default true). */
  generate_elements?: unknown;
  /** Custom element list (default: a standard e-commerce/app set). */
  elements?: unknown;
  /** Element canvas size, e.g. "512x512" (default). */
  element_size?: unknown;
  /** "1x" | "2x" | "both" (default "1x"). "both" doubles the calls. */
  element_scale?: unknown;
}

/** Per-page outcome. */
export interface PageOutcome {
  page: string;
  mockup?: string;
  mockupError?: string;
  elements: Array<{ element: string; savedPath?: string; error?: string }>;
}

export interface GenerateFromReferenceSuccess {
  ok: true;
  pages: PageOutcome[];
  savedPaths: string[];
}

export type GenerateFromReferenceResult =
  | GenerateFromReferenceSuccess
  | McpFailure;

/** Default element extraction set. */
const DEFAULT_ELEMENTS = [
  'logo',
  'navigation bar',
  'hero banner',
  'primary button',
  'app icon set',
];

const MAX_PAGES = 12;
const MAX_ELEMENTS_PER_PAGE = 8;

/** Run the `generate_from_reference` pipeline. */
export async function generateFromReference(
  args: GenerateFromReferenceArgs | undefined,
  ctx: McpToolContext,
): Promise<GenerateFromReferenceResult> {
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

  // ─── Step 1: slice (deterministic, instant delivery of crops) ──────────
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
  const maxPages =
    typeof a.max_pages === 'number' && a.max_pages >= 1
      ? Math.min(MAX_PAGES, Math.floor(a.max_pages))
      : MAX_PAGES;
  const regions: SliceRegion[] =
    gridRows >= 1 && gridCols >= 1
      ? sliceByGrid(img, gridRows, gridCols)
      : sliceAuto(img, maxPages);
  if (regions.length === 0) {
    return fail(
      'SCHEMA_INVALID',
      'no pages detected — pass rows and cols explicitly for sheets without clean gutters',
    );
  }

  const framework = typeof a.framework === 'string' ? a.framework : undefined;
  const design = await analyzeDesignContext(ws.workspaceRoot);

  const generateElements = a.generate_elements !== false;
  const elementList = (
    Array.isArray(a.elements)
      ? a.elements.filter((e): e is string => typeof e === 'string' && e.trim().length > 0)
      : DEFAULT_ELEMENTS
  ).slice(0, MAX_ELEMENTS_PER_PAGE);
  const sizeMatch =
    typeof a.element_size === 'string' && /^\d{2,4}x\d{2,4}$/.test(a.element_size)
      ? a.element_size.split('x').map((v) => Number.parseInt(v, 10))
      : [512, 512];
  const elementW = sizeMatch[0] ?? 512;
  const elementH = sizeMatch[1] ?? 512;
  const scale =
    a.element_scale === '2x' || a.element_scale === 'both' ? a.element_scale : '1x';
  const scales: Array<1 | 2> = scale === 'both' ? [1, 2] : [scale === '2x' ? 2 : 1];

  const pagesDir = path.join(ws.workspaceRoot, 'reference', 'pages');
  const mockupsDir = path.join(ws.workspaceRoot, 'mockups');
  const elementsDir = path.join(ws.workspaceRoot, 'elements');
  const savedPaths: string[] = [];
  const outcomes: PageOutcome[] = [];

  // ─── Step 2: per-page mockup recreation (attachment rides the request) ─
  for (let i = 0; i < regions.length; i += 1) {
    const region = regions[i];
    if (region === undefined) break;
    const pageName = `page-${String(i + 1).padStart(2, '0')}.png`;
    const pagePath = path.join(pagesDir, pageName);
    const crop = cropToPng(img, region);
    await atomicWrite(pagePath, crop);
    savedPaths.push(pagePath);

    const outcome: PageOutcome = { page: pageName, elements: [] };
    outcomes.push(outcome);

    const attachment: Attachment = {
      filename: pageName,
      mimeType: 'image/png',
      base64: Buffer.from(crop).toString('base64'),
    };

    // Mockup recreation with the crop attached.
    const prompt = composePrompt({
      kind: 'ui',
      specifics:
        `Using the attached reference page image, recreate this EXACT page as a ` +
        `production ${framework ?? 'web'} UI mockup: identical layout, hierarchy, ` +
        `sections, text content and spacing as the reference, rendered at higher ` +
        `visual fidelity. Viewport 1440x900. Page ${i + 1} of ${regions.length}.`,
      design,
    });
    try {
      const submitted = await submitImageRequest(ctx, prompt, {
        attachments: [attachment],
      });
      if (submitted.ok !== true) {
        outcome.mockupError = `${submitted.errorCode}: ${submitted.message}`;
      } else {
        const decoded = decodeFinalChunk(submitted.finalChunk);
        if (decoded.ok !== true) {
          outcome.mockupError = `${decoded.errorCode}: ${decoded.message}`;
        } else {
          const target = await resolveTargetPath({
            workspaceRoot: ws.workspaceRoot,
            framework: coerceFrameworkLocal(framework),
            assetCategory: 'mockup',
            filename: `page-${String(i + 1).padStart(2, '0')}-mockup`,
            prompt,
            mimeType: decoded.mimeType,
            overwrite: false,
          });
          if (target.ok !== true) {
            outcome.mockupError = target.message;
          } else {
            await atomicWrite(target.absolutePath, decoded.bytes);
            outcome.mockup = target.absolutePath;
            savedPaths.push(target.absolutePath);
          }
        }
      }
    } catch (err) {
      outcome.mockupError =
        err instanceof Error ? err.message : String(err);
    }

    // ─── Step 3: element extraction (page crop stays attached) ────────────
    if (generateElements) {
      for (const element of elementList) {
        for (const s of scales) {
          const w = elementW * s;
          const h = elementH * s;
          const elementPrompt = composePrompt({
            kind: 'ui',
            specifics:
              `Using the attached reference page image, generate ONLY the ` +
              `"${element}" of that page as a standalone production asset: ` +
              `${w}x${h}px canvas, ${s === 2 ? '@2x resolution, ' : ''}` +
              `transparent background where applicable, matching the page's ` +
              `colors, typography and style exactly.`,
            design,
          });
          const slug = element
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-+|-+$/g, '');
          try {
            const submitted = await submitImageRequest(ctx, elementPrompt, {
              attachments: [attachment],
            });
            if (submitted.ok !== true) {
              outcome.elements.push({
                element: `${element}@${s}x`,
                error: `${submitted.errorCode}: ${submitted.message}`,
              });
              continue;
            }
            const decoded = decodeFinalChunk(submitted.finalChunk);
            if (decoded.ok !== true) {
              outcome.elements.push({
                element: `${element}@${s}x`,
                error: `${decoded.errorCode}: ${decoded.message}`,
              });
              continue;
            }
            const elementPath = await writeElementAsset(
              ws.workspaceRoot,
              framework,
              `page-${String(i + 1).padStart(2, '0')}-${slug}-${s}x`,
              decoded.mimeType,
              decoded.bytes,
            );
            outcome.elements.push({ element: `${element}@${s}x`, savedPath: elementPath });
            savedPaths.push(elementPath);
          } catch (err) {
            outcome.elements.push({
              element: `${element}@${s}x`,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
      }
    }
  }

  return { ok: true, pages: outcomes, savedPaths };
}

const BASE_DIR_BY_FRAMEWORK: Readonly<Record<string, string>> = {
  next: 'public',
  nuxt: 'public',
  vite: 'public',
  cra: 'public',
  sveltekit: 'static',
  angular: 'src/assets',
  unknown: 'assets',
};

const EXT_BY_MIME: Readonly<Record<string, string>> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
};

/**
 * Write an element asset under `<base>/elements/<name><ext>`, appending
 * -2, -3, … on collision. Instant delivery: the file lands the moment
 * its bytes exist.
 */
async function writeElementAsset(
  workspaceRoot: string,
  framework: string | undefined,
  stem: string,
  mime: string,
  bytes: Uint8Array,
): Promise<string> {
  const baseDir = BASE_DIR_BY_FRAMEWORK[framework ?? 'unknown'] ?? 'assets';
  const ext = EXT_BY_MIME[mime] ?? '.png';
  const dir = path.join(workspaceRoot, baseDir, 'elements');
  let target = path.join(dir, `${stem}${ext}`);
  let n = 2;
  while (await exists(target)) {
    target = path.join(dir, `${stem}-${n}${ext}`);
    n += 1;
  }
  await atomicWrite(target, bytes);
  return target;
}

async function exists(p: string): Promise<boolean> {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

/** Local framework coercion (same closed set as common.coerceFramework). */
function coerceFrameworkLocal(value: string | undefined) {
  const allowed = new Set([
    'next', 'nuxt', 'sveltekit', 'vite', 'angular', 'cra', 'unknown',
  ]);
  return value !== undefined && allowed.has(value)
    ? (value as 'next' | 'nuxt' | 'sveltekit' | 'vite' | 'angular' | 'cra' | 'unknown')
    : 'unknown';
}
