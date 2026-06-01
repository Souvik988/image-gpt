/**
 * Centralized selectors for driving ChatGPT_Pro via puppeteer.
 *
 * Each entry is a tuple of fallback selectors ordered most-stable to most-
 * fragile: the chat driver should try them in order and use the first one
 * that resolves. This shape is the single source of truth for DOM contracts
 * with chat.openai.com and chatgpt.com — every other browser-agent module
 * (`chatDriver.ts`, `streamExtractor.ts`, `imageDriver.ts`, `stopAction.ts`,
 * `authDetector.ts`) consumes this map.
 *
 * Fallback ordering rationale (reflects the actual ChatGPT DOM circa 2024):
 *   1. `data-testid` attributes — most stable across releases when present.
 *   2. `aria-label` attributes — moderately stable; tied to a11y contract.
 *   3. Structural CSS / id / class selectors — most fragile; first to break
 *      on a frontend refactor, but keep us alive when the test ids change.
 *
 * Implements R9.1 (input-field discovery), R9.5 (final-chunk completion
 * detection), R20.4 (stop-button click). Indirectly supports R10.2 / R10.4
 * (image extraction) via `GENERATED_IMAGE`.
 */
export const SEL = {
  /** Chat composer textarea / contenteditable. R9.1. */
  INPUT: [
    'textarea[id="prompt-textarea"]',
    'textarea[data-id="prompt-textarea"]',
    'div[contenteditable="true"][data-virtualkeyboard="true"]',
    '#prompt-textarea',
    'div.ProseMirror[contenteditable="true"]',
    'div[contenteditable="true"][id="prompt-textarea"]',
    'main form div[contenteditable="true"]',
    'div[contenteditable="true"]',
  ],

  /** "Send" / submit button. R9.3. */
  SEND: [
    'button[data-testid="send-button"]',
    'button[aria-label="Send prompt"]',
    'button[aria-label="Send message"]',
    'form button[type="submit"]',
  ],

  /** "Stop generating" button — present only while a response is streaming. R20.4. */
  STOP: [
    'button[data-testid="stop-button"]',
    'button[aria-label="Stop streaming"]',
    'button[aria-label="Stop generating"]',
  ],

  /** Container of the most recent assistant message. R9.4 (stream-extractor target). */
  ASSISTANT_MESSAGE_CONTAINER: [
    '[data-message-author-role="assistant"]:last-of-type',
    'div[data-testid^="conversation-turn-"][data-message-author-role="assistant"]:last-of-type',
    'main [data-message-author-role="assistant"]:last-of-type',
  ],

  /** Inline message body inside an assistant turn (where text content lives). R9.4. */
  ASSISTANT_MESSAGE_BODY: [
    '[data-message-author-role="assistant"]:last-of-type .markdown',
    '[data-message-author-role="assistant"]:last-of-type [data-message-id]',
    '[data-message-author-role="assistant"]:last-of-type',
  ],

  /** Marker that the assistant message has finished streaming. R9.5. */
  MESSAGE_FINISHED_MARKER: [
    '[data-message-author-role="assistant"]:last-of-type[data-message-finished]',
    '[data-message-author-role="assistant"]:last-of-type [data-message-finished]',
  ],

  /**
   * "Regenerate" button — appears once a message is fully done; complementary
   * signal to STOP disappearing for end-of-stream detection. R9.5.
   */
  REGENERATE: [
    'button[data-testid="regenerate-button"]',
    'button[aria-label="Regenerate"]',
  ],

  /** Login landing controls — used by `authDetector` to flag `login_required`. R8.6, R23.1. */
  LOGIN_BUTTON: [
    'button[data-testid="login-button"]',
    'button[data-testid="mobile-login-button"]',
    'a[href*="auth/login"]',
  ],

  /** Generated image inside an assistant turn — used by `imageDriver`. R10.2. */
  GENERATED_IMAGE: [
    '[data-message-author-role="assistant"]:last-of-type img[alt="Generated image"]',
    '[data-message-author-role="assistant"]:last-of-type img[alt^="Generated"]',
    '[data-message-author-role="assistant"]:last-of-type img[src^="https://"]',
  ],

  /** Visible chat error banner shown by ChatGPT inside the conversation. R9.6. */
  CHAT_ERROR_BANNER: [
    '[data-message-author-role="assistant"]:last-of-type [class*="error"]',
    '.text-token-text-error',
    '[role="alert"]',
  ],

  /**
   * DALL-E content-policy refusal text. R10.6.
   *
   * NOTE: The `:has-text(...)` pseudo-selector is Playwright syntax and is
   * NOT supported by puppeteer's `page.$()` / `page.$$()` directly. These
   * entries are consumed by code that does manual `textContent` matching:
   * the chat driver / image driver should iterate over candidate elements
   * (e.g., children of `ASSISTANT_MESSAGE_BODY`) and check
   * `textContent.includes('content policy')` themselves rather than passing
   * these strings to `page.$()`.
   */
  CONTENT_POLICY_TEXT: [
    '[data-message-author-role="assistant"]:last-of-type :is(p,div):has-text("content policy")',
    '[data-message-author-role="assistant"]:last-of-type :is(p,div):has-text("can\'t create that")',
  ],
} as const;

/**
 * Domains where ChatGPT_Pro currently lives. The `/auth/login` path on either
 * domain is the login landing.
 */
export const CHATGPT_DOMAINS = ['chat.openai.com', 'chatgpt.com'] as const;

/**
 * Auth landing URL fragments — match against `page.url()` to detect the
 * `login_required` agent state. R8.6, R23.1.
 */
export const AUTH_URL_FRAGMENTS = ['/auth/login', '/login'] as const;

/** Selector key type, derived for type-safety in callers. */
export type SelectorKey = keyof typeof SEL;
