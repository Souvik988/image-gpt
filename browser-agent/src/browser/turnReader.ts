/**
 * Single-round-trip reader for the ChatGPT conversation DOM.
 *
 * This module is the ONLY place in the browser-agent that interprets the
 * assistant-turn DOM contract. Every consumer (stream extractor, image
 * driver refusal detection, turn baselining) goes through
 * {@link readLastTurnState} so there is exactly one implementation of the
 * "which turn am I reading" logic.
 *
 * Why this module exists
 * ---------------------
 * The original implementation used CSS selectors like
 * `[data-message-author-role="assistant"]:last-of-type` combined with
 * `document.querySelector`. `:last-of-type` matches "the last sibling of
 * its element *type*" — in ChatGPT's DOM each assistant turn is wrapped in
 * its own container, so EVERY assistant turn matches the selector, and
 * `document.querySelector` (first match in document order) resolves the
 * OLDEST turn. In a continuing conversation the stream extractor therefore
 * read turn 1 — a complete, static message — and reported the request as
 * finished instantly with the wrong text.
 *
 * The fix: `document.querySelectorAll('[data-message-author-role=
 * "assistant"]')` and index the LAST element. No reliance on `:last-of-type`
 * semantics at all.
 *
 * Performance
 * -----------
 * The previous poll cycle made 5+ sequential `page.evaluate` round-trips
 * (error banner, body text, finished marker, regenerate, stop). Each CDP
 * round-trip costs ~2-10 ms plus scheduler jitter. This reader collapses
 * the whole cycle into ONE evaluate that returns a
 * {@link LastTurnState} snapshot.
 *
 * @packageDocumentation
 */

/**
 * Snapshot of the conversation state relevant to streaming and image
 * extraction. All fields are derived from a single in-page pass.
 */
export interface LastTurnState {
  /**
   * Total number of assistant turns currently in the DOM. Used as a
   * baseline marker: a response to a newly-submitted prompt arrives as a
   * NEW turn, so `turnCount > baseline.turnCount` means the new response
   * has started rendering.
   */
  turnCount: number;
  /** `innerText` of the last assistant turn ('' when there are none). */
  text: string;
  /**
   * True when the last assistant turn appears complete: an explicit
   * `data-message-finished` marker, or (regenerate visible AND stop
   * hidden AND non-empty text) as the structural fallback.
   */
  finished: boolean;
  /** Visible error text inside the last assistant turn, if any. */
  errorText: string | null;
  /** Whether any "Regenerate" action is visible in the document. */
  regenVisible: boolean;
  /** Whether the streaming "Stop" button is visible in the document. */
  stopVisible: boolean;
  /**
   * `src` of the first qualifying image (https / blob / data:image) with
   * natural dimensions ≥ 256px inside the last assistant turn, or `null`.
   * Used by the image driver's DOM fallback.
   */
  imageUrl: string | null;
}

/**
 * Structural subset of the puppeteer `Page` surface consumed by the
 * reader. Production code passes the puppeteer page; tests pass a stub.
 */
export interface TurnReaderPage {
  evaluate<R>(fn: (...args: unknown[]) => R | Promise<R>, ...args: unknown[]): Promise<R>;
}

/**
 * Minimum natural pixel dimension for an `<img>` inside the last turn to
 * qualify as a generated-image candidate for the DOM fallback path.
 * Lowered from the old 1024 hard floor: DALL-E preview tiles can render
 * smaller than the final asset, and the network-interception path (which
 * enforces its own stricter checks) remains primary.
 */
const MIN_DOM_IMAGE_DIM = 256;

/** Error-text fragments treated as a visible generation failure. */
const ERROR_MARKERS = [
  'content policy',
  "can't create that",
  'cannot create that',
  'against my guidelines',
  "can't generate that",
  'cannot generate that',
  'something went wrong',
  'there was an error',
] as const;

/**
 * Read the state of the last assistant turn in one evaluate round-trip.
 *
 * Returns a zero-valued snapshot (`turnCount: 0`, empty text) when the
 * conversation has no assistant turns yet, and never throws for
 * page-navigation races — callers get a usable snapshot or `null` when
 * the evaluate itself failed (context destroyed, target closed).
 *
 * @param page Live or stubbed puppeteer page.
 * @returns The snapshot, or `null` when the page is unreachable.
 */
export async function readLastTurnState(
  page: TurnReaderPage,
): Promise<LastTurnState | null> {
  try {
    return await page.evaluate(
      (...args: unknown[]): LastTurnState => {
        const minImgDim = (args[0] as number) ?? 256;
        const errorMarkers = args[1] as readonly string[];

        const turns = document.querySelectorAll(
          '[data-message-author-role="assistant"]',
        );
        const turnCount = turns.length;

        const state: LastTurnState = {
          turnCount,
          text: '',
          finished: false,
          errorText: null,
          regenVisible: false,
          stopVisible: false,
          imageUrl: null,
        };

        // Document-level streaming affordances. These live outside the
        // turn containers, so probe the whole document.
        state.stopVisible = document.querySelector(
          [
            'button[data-testid="stop-button"]',
            'button[aria-label="Stop streaming"]',
            'button[aria-label="Stop generating"]',
          ].join(', '),
        ) !== null;
        state.regenVisible = document.querySelector(
          [
            'button[data-testid="regenerate-button"]',
            'button[aria-label="Regenerate"]',
          ].join(', '),
        ) !== null;

        if (turnCount === 0) return state;

        const last = turns[turnCount - 1] as HTMLElement;

        // --- text ---
        state.text =
          typeof last.innerText === 'string' ? last.innerText : (last.textContent ?? '');

        // --- finished signal ---
        const hasMarker =
          last.hasAttribute('data-message-finished') ||
          last.querySelector('[data-message-finished]') !== null;
        state.finished =
          hasMarker ||
          (state.regenVisible && !state.stopVisible && state.text.trim().length > 0);

        // --- visible error text, scoped to the last turn ---
        const errorCandidates = last.querySelectorAll(
          '[role="alert"], .text-token-text-error',
        );
        for (let i = 0; i < errorCandidates.length; i += 1) {
          const raw = (errorCandidates[i] as HTMLElement).textContent ?? '';
          const trimmed = raw.trim();
          if (trimmed.length > 0) {
            state.errorText = trimmed;
            break;
          }
        }
        if (state.errorText === null) {
          // Textual markers anywhere in the last turn (refusals are often
          // plain paragraphs, not alert-role elements).
          const lower = state.text.toLowerCase();
          for (const marker of errorMarkers) {
            if (lower.includes(marker)) {
              state.errorText = state.text.trim();
              break;
            }
          }
        }

        // --- qualifying generated image inside the last turn ---
        const images = last.querySelectorAll('img');
        for (let i = 0; i < images.length; i += 1) {
          const img = images[i] as HTMLImageElement;
          const src = img.src ?? '';
          const qualifyingSrc =
            src.startsWith('https://') ||
            src.startsWith('blob:') ||
            src.startsWith('data:image/');
          if (!qualifyingSrc) continue;
          if (img.naturalWidth < minImgDim || img.naturalHeight < minImgDim) continue;
          state.imageUrl = src;
          break;
        }

        return state;
      },
      MIN_DOM_IMAGE_DIM,
      ERROR_MARKERS,
    );
  } catch {
    // Execution context destroyed (navigation), target closed, etc.
    return null;
  }
}

/**
 * Snapshot taken BEFORE a prompt is submitted, used by the stream
 * extractor to distinguish the NEW response turn from pre-existing turns.
 */
export interface StreamBaseline {
  /** Assistant-turn count at snapshot time. */
  turnCount: number;
  /** Text of the last assistant turn at snapshot time ('' when none). */
  lastText: string;
}

/**
 * Capture a pre-submit baseline. Cheap — one evaluate.
 */
export async function captureStreamBaseline(
  page: TurnReaderPage,
): Promise<StreamBaseline | null> {
  const state = await readLastTurnState(page);
  if (state === null) return null;
  return { turnCount: state.turnCount, lastText: state.text };
}
