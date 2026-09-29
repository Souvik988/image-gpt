/**
 * Unit tests for `referenceSlicer.ts` — deterministic sheet slicing.
 * A synthetic 800x600 sheet with four colored 2x2 cards separated by
 * white gutters must slice into exactly four page crops, both by grid
 * and by auto gutter detection, and crops must round-trip losslessly.
 */

import { describe, it, expect } from 'vitest';

import {
  cropToPng,
  decodeImage,
  sliceAuto,
  sliceByGrid,
  type DecodedImage,
} from '../src/referenceSlicer.js';

/** Build the synthetic sheet: white background, 4 solid-color cards. */
function makeSheet(): DecodedImage {
  const width = 800;
  const height = 600;
  const data = new Uint8Array(width * height * 4).fill(255); // white
  const cards = [
    { x: 20, y: 20, w: 360, h: 260, c: [200, 40, 40] },
    { x: 420, y: 20, w: 360, h: 260, c: [40, 200, 40] },
    { x: 20, y: 320, w: 360, h: 260, c: [40, 40, 200] },
    { x: 420, y: 320, w: 360, h: 260, c: [220, 180, 30] },
  ];
  for (const card of cards) {
    for (let y = card.y; y < card.y + card.h; y += 1) {
      for (let x = card.x; x < card.x + card.w; x += 1) {
        const p = (y * width + x) * 4;
        data[p] = card.c[0];
        data[p + 1] = card.c[1];
        data[p + 2] = card.c[2];
        data[p + 3] = 255;
      }
    }
  }
  return { width, height, data };
}

describe('sliceByGrid', () => {
  it('cuts an 800x600 sheet into 2x2 cells, inset-trimmed, row-major', () => {
    const regions = sliceByGrid(makeSheet(), 2, 2);
    expect(regions).toHaveLength(4);
    // Row-major: page 1 = top-left, page 2 = top-right…
    expect(regions[0].x).toBeLessThan(400);
    expect(regions[0].y).toBeLessThan(300);
    expect(regions[1].x).toBeGreaterThanOrEqual(400);
    expect(regions[2].y).toBeGreaterThanOrEqual(300);
    // Inset trims 2px per edge.
    expect(regions[0].width).toBe(400 - 4);
    expect(regions[0].height).toBe(300 - 4);
  });
});

describe('sliceAuto', () => {
  it('detects the four cards through the white gutters', () => {
    const regions = sliceAuto(makeSheet(), 12);
    expect(regions).toHaveLength(4);
    for (const r of regions) {
      // Each detected page is card-sized (± a few px of gutter bleed).
      expect(r.width).toBeGreaterThan(300);
      expect(r.height).toBeGreaterThan(200);
    }
  });

  it('caps at maxPages', () => {
    const regions = sliceAuto(makeSheet(), 2);
    expect(regions).toHaveLength(2);
  });
});

describe('cropToPng round-trip', () => {
  it('re-decodes to the exact region with the card color intact', () => {
    const sheet = makeSheet();
    const region = { x: 20, y: 20, width: 360, height: 260 };
    const png = cropToPng(sheet, region);
    const decoded = decodeImage(png);
    expect(decoded.width).toBe(360);
    expect(decoded.height).toBe(260);
    // Top-left pixel of the crop is the red card color.
    expect(decoded.data[0]).toBe(200);
    expect(decoded.data[1]).toBe(40);
    expect(decoded.data[2]).toBe(40);
    expect(decoded.data[3]).toBe(255);
  });
});

describe('decodeImage', () => {
  it('rejects unsupported formats with a clear error', () => {
    expect(() => decodeImage(new Uint8Array([1, 2, 3, 4]))).toThrow(
      /unsupported image format/,
    );
  });
});
