/**
 * Reference slicer — deterministic, pixel-exact decomposition of a large
 * reference sheet (e.g. a 7x4 grid of Flutter page mockups) into
 * individual page crops.
 *
 * Pure TypeScript on pngjs (PNG) and jpeg-js (JPEG decode) — no native
 * dependencies, so it runs anywhere Node runs.
 *
 * Two modes:
 *  - Grid (`sliceByGrid`): the caller states rows × cols; the sheet is
 *    divided into equal cells with a small edge inset that removes
 *    divider lines.
 *  - Auto (`sliceAuto`): gutter detection. Rows whose pixels are all
 *    within tolerance of that row's dominant color are "blank"; blank
 *    row bands split the sheet into horizontal strips, then each strip
 *    is split by blank columns. Handles sheets of uneven page sizes on
 *    a solid background.
 *
 * Crops are re-encoded as PNG (lossless — the crop IS the reference).
 *
 * @packageDocumentation
 */

import { PNG } from 'pngjs';
import * as jpeg from 'jpeg-js';

// ─── Public types ──────────────────────────────────────────────────────────

/** Decoded RGBA image. */
export interface DecodedImage {
  width: number;
  height: number;
  /** RGBA, 4 bytes per pixel, row-major. */
  data: Uint8Array;
}

/** One crop region in source pixels. */
export interface SliceRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

// ─── Decode / encode ───────────────────────────────────────────────────────

/** Magic-byte sniffing: PNG starts 89 50 4E 47, JPEG starts FF D8 FF. */
export function decodeImage(bytes: Uint8Array): DecodedImage {
  const isPng =
    bytes.length > 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47;
  if (isPng) {
    const png = PNG.sync.read(Buffer.from(bytes));
    return { width: png.width, height: png.height, data: new Uint8Array(png.data) };
  }
  const isJpeg =
    bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (isJpeg) {
    const img = jpeg.decode(Buffer.from(bytes), { useTArray: true, formatAsRGBA: true });
    return { width: img.width, height: img.height, data: new Uint8Array(img.data) };
  }
  throw new Error('unsupported image format (expected PNG or JPEG)');
}

/** Encode a crop of `img` as a lossless PNG. */
export function cropToPng(img: DecodedImage, region: SliceRegion): Uint8Array {
  const out = new PNG({ width: region.width, height: region.height });
  for (let y = 0; y < region.height; y += 1) {
    const srcRow = (region.y + y) * img.width + region.x;
    const dstRow = y * region.width;
    for (let x = 0; x < region.width; x += 1) {
      const s = (srcRow + x) * 4;
      const d = (dstRow + x) * 4;
      out.data[d] = img.data[s] ?? 0;
      out.data[d + 1] = img.data[s + 1] ?? 0;
      out.data[d + 2] = img.data[s + 2] ?? 0;
      out.data[d + 3] = img.data[s + 3] ?? 0;
    }
  }
  return new Uint8Array(PNG.sync.write(out));
}

// ─── Grid mode ─────────────────────────────────────────────────────────────

/** Edge inset (px) trimmed from each cell to drop divider lines. */
const GRID_INSET = 2;

/**
 * Slice the sheet into `rows × cols` equal cells (inset-trimmed),
 * returned row-major (page 1 = top-left).
 */
export function sliceByGrid(
  img: DecodedImage,
  rows: number,
  cols: number,
): SliceRegion[] {
  const cellW = Math.floor(img.width / cols);
  const cellH = Math.floor(img.height / rows);
  const regions: SliceRegion[] = [];
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      const x = c * cellW + GRID_INSET;
      const y = r * cellH + GRID_INSET;
      const width = Math.min(cellW - GRID_INSET * 2, img.width - x);
      const height = Math.min(cellH - GRID_INSET * 2, img.height - y);
      if (width > 0 && height > 0) regions.push({ x, y, width, height });
    }
  }
  return regions;
}

// ─── Auto mode ─────────────────────────────────────────────────────────────

/** A row/column is "blank" when every sampled pixel is within this distance of the band's dominant color. */
const BLANK_TOLERANCE = 12;
/** Sample every Nth pixel when scanning rows/columns (speed). */
const SCAN_STEP = 4;
/** Minimum content band size (px) — anything smaller is treated as noise. */
const MIN_CONTENT_PX = 120;
/** Minimum gutter width (px) — thinner gaps are not separators. */
const MIN_GUTTER_PX = 8;

/**
 * Auto-detect pages: split blank row bands, then blank column bands
 * within each strip. Returns content regions ordered top-to-bottom,
 * left-to-right.
 */
export function sliceAuto(img: DecodedImage, maxPages: number): SliceRegion[] {
  const rowBands = splitBands(img, 0, img.height, 'row');
  const regions: SliceRegion[] = [];
  for (const rowBand of rowBands) {
    const colBands = splitBands(img, rowBand.start, rowBand.end, 'col');
    for (const colBand of colBands) {
      regions.push({
        x: colBand.start,
        y: rowBand.start,
        width: colBand.end - colBand.start,
        height: rowBand.end - rowBand.start,
      });
      if (regions.length >= maxPages) return regions;
    }
  }
  return regions;
}

/**
 * Find content bands along one axis (`mode`): maximal runs of non-blank
 * lines separated by gutters of at least MIN_GUTTER_PX blank lines.
 * 'row' scans full-width horizontal lines; 'col' scans a vertical strip
 * between yStart..yEnd. Offsets returned are absolute source pixels.
 */
function splitBands(
  img: DecodedImage,
  yStart: number,
  yEnd: number,
  mode: 'row' | 'col',
): Array<{ start: number; end: number }> {
  const bg = detectBackgroundColor(img);
  const isBlank = (a: number): boolean =>
    mode === 'row'
      ? isRowBlank(img, a * img.width, bg)
      : isColBlank(img, a, yStart, yEnd, bg);

  // The scan runs along the split axis: rows scan yStart..yEnd, columns
  // scan the FULL x axis (yStart/yEnd only bound isColBlank's vertical
  // sampling).
  const scanStart = mode === 'col' ? 0 : yStart;
  const scanEnd = mode === 'col' ? img.width : yEnd;

  const bands: Array<{ start: number; end: number }> = [];
  let i = scanStart;
  while (i < scanEnd) {
    if (isBlank(i)) {
      i += 1;
      continue;
    }
    const start = i;
    let gutter = 0;
    let end = i;
    while (i < yEnd) {
      if (isBlank(i)) {
        gutter += 1;
        if (gutter >= MIN_GUTTER_PX) {
          end = i - gutter + 1;
          break;
        }
      } else {
        gutter = 0;
        end = i + 1;
      }
      i += 1;
    }
    if (end - start >= MIN_CONTENT_PX) {
      bands.push({ start, end });
    }
    if (gutter >= MIN_GUTTER_PX) {
      i = end + gutter;
    }
  }
  return bands;
}

/** True when every sampled pixel in column `x` between yStart..yEnd matches the sheet background. */
function isColBlank(
  img: DecodedImage,
  x: number,
  yStart: number,
  yEnd: number,
  bg: { r: number; g: number; b: number },
): boolean {
  for (let y = yStart; y < yEnd; y += SCAN_STEP) {
    const p = (y * img.width + x) * 4;
    if (
      Math.abs((img.data[p] ?? 0) - bg.r) > BLANK_TOLERANCE ||
      Math.abs((img.data[p + 1] ?? 0) - bg.g) > BLANK_TOLERANCE ||
      Math.abs((img.data[p + 2] ?? 0) - bg.b) > BLANK_TOLERANCE
    ) {
      return false;
    }
  }
  return true;
}

/**
 * The sheet's background color, sampled from the border ring (the outer
 * 2px frame). Gutter lines must match THIS color — a local-dominant test
 * would misclassify solid-color card regions as gutters.
 */
function detectBackgroundColor(img: DecodedImage): { r: number; g: number; b: number } {
  let r = 0;
  let g = 0;
  let b = 0;
  let samples = 0;
  const sample = (x: number, y: number): void => {
    const p = (y * img.width + x) * 4;
    r += img.data[p] ?? 0;
    g += img.data[p + 1] ?? 0;
    b += img.data[p + 2] ?? 0;
    samples += 1;
  };
  for (let x = 0; x < img.width; x += SCAN_STEP) {
    sample(x, 0);
    sample(x, 1);
    sample(x, img.height - 1);
    sample(x, img.height - 2);
  }
  for (let y = 0; y < img.height; y += SCAN_STEP) {
    sample(0, y);
    sample(1, y);
    sample(img.width - 1, y);
    sample(img.width - 2, y);
  }
  if (samples === 0) return { r: 255, g: 255, b: 255 };
  return {
    r: Math.round(r / samples),
    g: Math.round(g / samples),
    b: Math.round(b / samples),
  };
}

/** True when every sampled pixel in the row matches the sheet background. */
function isRowBlank(
  img: DecodedImage,
  rowStartIdx: number,
  bg: { r: number; g: number; b: number },
): boolean {
  for (let x = 0; x < img.width; x += SCAN_STEP) {
    const p = (rowStartIdx + x) * 4;
    if (
      Math.abs((img.data[p] ?? 0) - bg.r) > BLANK_TOLERANCE ||
      Math.abs((img.data[p + 1] ?? 0) - bg.g) > BLANK_TOLERANCE ||
      Math.abs((img.data[p + 2] ?? 0) - bg.b) > BLANK_TOLERANCE
    ) {
      return false;
    }
  }
  return true;
}
