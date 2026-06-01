// @ts-check
/**
 * ChatGPT Bridge sidebar webview runtime — task 18.2.
 *
 * Owns DOM construction and the webview ↔ host message loop. Imports
 * nothing — pure ES module loaded directly by the browser inside the
 * VS Code webview (no bundler, no React). The matching protocol is
 * defined in `kiro-extension/src/webview/messageBridge.ts`
 * (`WebviewToHost` / `HostToWebview`).
 *
 * Implements:
 *   R12.1  panel rendering
 *   R13.6  Copy / Insert at cursor per fenced code block
 *   R16.2  syntax highlighting matching language tag
 *   R16.3  unrecognised language → plain monospaced text
 *   R16.4  while streaming, hide Copy / Insert / Save action buttons
 *   R16.5  on isFinal:true the action buttons become visible & enabled
 *   R17.1  Chat / Image mode toggle (defaults to Chat per session)
 *   R20.1  Stop button per in-flight message
 *
 * Highlighting strategy: we deliberately avoid Prism / highlight.js.
 * Each fenced code block is rendered as
 *   `<div class="code-block" data-lang="ts">…</div>`
 * with a small per-language tokenizer that wraps keywords, strings,
 * numbers, and comments in `<span class="tok-…">`. CSS in panel.css
 * provides the colours via VS Code symbol-icon theme tokens. For any
 * language tag NOT in `RECOGNISED_LANGS` (or no tag at all) we emit
 * just the HTML-escaped text inside the code element, satisfying R16.3.
 *
 * No `any`-equivalents: this file is plain JS but every type-relevant
 * value is constructed locally and validated against the discriminator
 * `kind` of incoming messages. ES2022 features (optional chaining,
 * nullish coalescing, top-level const, structured Map) are used freely.
 */

/* eslint-env browser */
/* global acquireVsCodeApi */

const vscode = acquireVsCodeApi();

/**
 * Module-private state. Kept as a frozen-keys object to make it easy
 * to reason about which fields exist; values are mutated in place.
 *
 * @type {{
 *   mode: 'chat' | 'image',
 *   sessionId: string | null,
 *   attachments: Array<{ filename: string, mimeType: string, sizeBytes: number }>,
 *   inflight: Set<string>,
 * }}
 */
const state = {
  mode: 'chat',
  sessionId: null,
  attachments: [],
  inflight: new Set(),
};

// ─── Message dispatch ────────────────────────────────────────────────────

/**
 * Send a {@link WebviewToHost} payload to the extension host. Caller is
 * responsible for the discriminated-union shape; the host re-validates
 * via `parseWebviewMessage` before forwarding.
 *
 * @param {Record<string, unknown>} msg
 */
function sendToHost(msg) {
  vscode.postMessage(msg);
}

window.addEventListener('message', (event) => {
  const msg = event.data;
  if (msg === null || typeof msg !== 'object' || typeof msg.kind !== 'string') {
    return;
  }
  switch (msg.kind) {
    case 'status':
      updateStatus(msg);
      break;
    case 'session.created':
      onSessionCreated(msg);
      break;
    case 'session.loaded':
      renderSession(msg.session);
      break;
    case 'request.queued':
      onRequestQueued(msg);
      break;
    case 'request.dispatched':
      onRequestDispatched(msg);
      break;
    case 'stream.chunk':
      appendChunk(msg);
      break;
    case 'stream.interrupted':
      showInterrupted(msg.requestId);
      break;
    case 'request.terminal':
      finalizeMessage(msg);
      break;
    case 'agent.status':
      // Per-agent state is summarised by the next 'status' frame; the
      // panel only renders the aggregate counts. Nothing to do here.
      break;
    case 'error':
      showError(typeof msg.message === 'string' ? msg.message : 'Unknown error');
      break;
    default:
      // Unknown discriminator — ignore silently.
      break;
  }
});

// ─── Header / status ─────────────────────────────────────────────────────

/**
 * @param {{ panelStatus: string, agents: number, queue: number }} msg
 */
function updateStatus(msg) {
  const status = document.getElementById('header-status');
  const agents = document.getElementById('agent-count');
  const queue = document.getElementById('queue-depth');
  if (status !== null) {
    status.dataset.state = msg.panelStatus;
    status.textContent = capitalize(msg.panelStatus);
  }
  if (agents !== null) {
    agents.textContent = `${msg.agents} agent${msg.agents === 1 ? '' : 's'}`;
  }
  if (queue !== null) {
    queue.textContent = `${msg.queue} queued`;
  }
}

/**
 * @param {string} s
 */
function capitalize(s) {
  if (s.length === 0) return s;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// ─── Session lifecycle ───────────────────────────────────────────────────

/**
 * @param {{ sessionId: string }} msg
 */
function onSessionCreated(msg) {
  state.sessionId = msg.sessionId;
}

/**
 * @param {{ sessionId: string, messages?: Array<{ role: string, text: string, requestId?: string }> }} session
 */
function renderSession(session) {
  state.sessionId = session.sessionId;
  const messages = document.getElementById('messages');
  if (messages === null) return;
  messages.replaceChildren();
  const list = Array.isArray(session.messages) ? session.messages : [];
  for (const m of list) {
    const elem = createMessageElement(
      m.role === 'user' ? 'user' : 'assistant',
      typeof m.requestId === 'string' ? m.requestId : `restored-${cryptoRandomId()}`,
    );
    elem.dataset.streaming = 'false';
    const body = elem.querySelector('.body');
    if (body !== null) {
      body.innerHTML = renderMarkdown(typeof m.text === 'string' ? m.text : '');
      attachCodeBlockHandlers(elem);
    }
    if (m.role !== 'user') {
      addSaveAsFileButton(elem);
    }
    messages.appendChild(elem);
  }
  scrollMessagesToBottom();
}

/**
 * @param {{ requestId: string, queuePosition: number }} msg
 */
function onRequestQueued(msg) {
  const elem = ensureMessageElement('assistant', msg.requestId);
  const status = elem.querySelector('.message-status');
  if (status !== null) {
    status.textContent = `queued (#${msg.queuePosition + 1})`;
  }
}

/**
 * @param {{ requestId: string, agentId: string }} _msg
 */
function onRequestDispatched(_msg) {
  const elem = ensureMessageElement('assistant', _msg.requestId);
  const status = elem.querySelector('.message-status');
  if (status !== null) {
    status.textContent = 'streaming…';
  }
}

// ─── Mode toggle ─────────────────────────────────────────────────────────

document.getElementById('mode-chat')?.addEventListener('click', () => setMode('chat'));
document.getElementById('mode-image')?.addEventListener('click', () => setMode('image'));

/**
 * @param {'chat' | 'image'} mode
 */
function setMode(mode) {
  state.mode = mode;
  const chatBtn = document.getElementById('mode-chat');
  const imageBtn = document.getElementById('mode-image');
  if (chatBtn !== null) chatBtn.setAttribute('aria-selected', mode === 'chat' ? 'true' : 'false');
  if (imageBtn !== null) imageBtn.setAttribute('aria-selected', mode === 'image' ? 'true' : 'false');
}

// ─── New thread ──────────────────────────────────────────────────────────

document.getElementById('new-thread')?.addEventListener('click', () => {
  sendToHost({ kind: 'newSession' });
});

// ─── Send ────────────────────────────────────────────────────────────────

document.getElementById('send')?.addEventListener('click', onSend);
document.getElementById('input')?.addEventListener('keydown', (event) => {
  // Ctrl/Cmd+Enter submits.
  if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
    event.preventDefault();
    onSend();
  }
});

function onSend() {
  const input = /** @type {HTMLTextAreaElement | null} */ (document.getElementById('input'));
  const errorEl = document.getElementById('composer-error');
  if (input === null) return;
  const text = input.value.trim();
  if (text.length === 0) {
    if (errorEl !== null) errorEl.textContent = 'Prompt is empty.';
    return;
  }
  if (state.mode === 'image' && text.length > 4000) {
    if (errorEl !== null) errorEl.textContent = 'Image prompt must be 1–4000 characters.';
    return;
  }
  if (errorEl !== null) errorEl.textContent = '';

  // Echo the user message into the panel immediately so the user has
  // visual confirmation. The host owns the canonical message log and
  // will replay it via session.loaded on reconnect.
  const messages = document.getElementById('messages');
  if (messages !== null) {
    const userElem = createMessageElement('user', `local-${cryptoRandomId()}`);
    userElem.dataset.streaming = 'false';
    const body = userElem.querySelector('.body');
    if (body !== null) body.textContent = text;
    messages.appendChild(userElem);
    scrollMessagesToBottom();
  }

  sendToHost({
    kind: 'submit',
    sessionId: state.sessionId ?? '<new>',
    mode: state.mode,
    text,
    attachments: state.attachments,
    codeContextTokens: extractCodeContextTokens(text),
  });

  input.value = '';
  state.attachments = [];
  renderAttachments();
}

/**
 * Extract `#File:<path>` and `#Folder:<path>` tokens (R14). The host
 * resolves them; the webview only forwards the raw matches.
 *
 * @param {string} text
 * @returns {string[]}
 */
function extractCodeContextTokens(text) {
  const matches = text.match(/#(?:File|Folder):[^\s]+/g);
  return matches === null ? [] : Array.from(matches);
}

// ─── Attachments ─────────────────────────────────────────────────────────

function renderAttachments() {
  const container = document.getElementById('attachments');
  if (container === null) return;
  container.replaceChildren();
  for (const [index, attachment] of state.attachments.entries()) {
    const chip = document.createElement('span');
    chip.className = 'chip';
    const name = document.createElement('span');
    name.className = 'chip-name';
    name.textContent = attachment.filename;
    chip.appendChild(name);
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'chip-remove';
    remove.setAttribute('aria-label', `Remove ${attachment.filename}`);
    remove.textContent = '×';
    remove.addEventListener('click', () => {
      state.attachments.splice(index, 1);
      renderAttachments();
    });
    chip.appendChild(remove);
    container.appendChild(chip);
  }
}

// ─── Streaming chunk handling ────────────────────────────────────────────

/**
 * Append a streamed chunk to the assistant message identified by
 * `requestId`. Creates the message element on first sight.
 *
 * @param {{
 *   requestId: string,
 *   text: string,
 *   chunkIndex: number,
 *   isFinal: boolean,
 *   mediaType?: string,
 *   base64?: string,
 * }} msg
 */
function appendChunk(msg) {
  const elem = ensureMessageElement('assistant', msg.requestId);
  const body = elem.querySelector('.body');
  if (body === null) return;

  if (msg.isFinal === true) {
    elem.dataset.streaming = 'false';
    state.inflight.delete(msg.requestId);

    const isImage =
      typeof msg.mediaType === 'string' &&
      typeof msg.base64 === 'string' &&
      msg.mediaType.startsWith('image/');

    if (isImage === true) {
      // R17.4: render image inline.
      body.replaceChildren();
      const img = document.createElement('img');
      img.alt = 'Generated image';
      img.src = `data:${msg.mediaType};base64,${msg.base64}`;
      body.appendChild(img);
      addSaveImageButton(elem, msg.requestId);
    } else {
      // R16.5: replace streaming plain text with rendered markdown
      // (so fenced blocks become real <pre> nodes that get Copy/Insert).
      const accumulated = (elem.dataset.fullText ?? '') + (typeof msg.text === 'string' ? msg.text : '');
      elem.dataset.fullText = accumulated;
      body.innerHTML = renderMarkdown(accumulated);
      attachCodeBlockHandlers(elem);
      addSaveAsFileButton(elem);
    }

    const status = elem.querySelector('.message-status');
    if (status !== null) status.textContent = 'done';
    enableFinalActions(elem);
  } else {
    // While streaming, render text as plain text — markdown parsing
    // happens once on isFinal:true so we don't repeatedly rebuild
    // half-parsed code fences.
    const next = (elem.dataset.fullText ?? '') + (typeof msg.text === 'string' ? msg.text : '');
    elem.dataset.fullText = next;
    body.textContent = next;
    elem.dataset.streaming = 'true';
    const stop = elem.querySelector('.stop-btn');
    if (stop instanceof HTMLButtonElement) {
      stop.disabled = false;
    }
    state.inflight.add(msg.requestId);
    const status = elem.querySelector('.message-status');
    if (status !== null) status.textContent = 'streaming…';
  }
  scrollMessagesToBottom();
}

/**
 * R16.6: stream interrupted (no final chunk within 30 s of last chunk).
 *
 * @param {string} requestId
 */
function showInterrupted(requestId) {
  const elem = document.querySelector(`[data-request-id="${cssEscape(requestId)}"]`);
  if (!(elem instanceof HTMLElement)) return;
  elem.dataset.streaming = 'false';
  elem.dataset.status = 'interrupted';
  state.inflight.delete(requestId);
  const status = elem.querySelector('.message-status');
  if (status !== null) status.textContent = 'stream interrupted';
}

/**
 * @param {{
 *   requestId: string,
 *   terminal: 'completed' | 'cancelled' | 'failed' | 'queue_timeout',
 *   errorCode?: string,
 *   message?: string,
 * }} msg
 */
function finalizeMessage(msg) {
  const elem = document.querySelector(`[data-request-id="${cssEscape(msg.requestId)}"]`);
  if (!(elem instanceof HTMLElement)) return;
  elem.dataset.streaming = 'false';
  elem.dataset.status = msg.terminal;
  state.inflight.delete(msg.requestId);
  const status = elem.querySelector('.message-status');
  if (status !== null) {
    if (msg.terminal === 'completed') {
      status.textContent = 'done';
    } else {
      const code = typeof msg.errorCode === 'string' ? ` [${msg.errorCode}]` : '';
      const text = typeof msg.message === 'string' ? `: ${msg.message}` : '';
      status.textContent = `${msg.terminal}${code}${text}`;
    }
  }
  // R16.5: if terminal !== 'completed' the body may already be rendered
  // by an earlier final chunk; either way, expose the action buttons.
  if (msg.terminal === 'completed') {
    enableFinalActions(elem);
  }
}

/**
 * @param {string} message
 */
function showError(message) {
  const errorEl = document.getElementById('composer-error');
  if (errorEl !== null) errorEl.textContent = message;
}

// ─── Message element construction ────────────────────────────────────────

/**
 * Get an existing message element by requestId, or create a new
 * assistant message and append it to the messages region.
 *
 * @param {'user' | 'assistant'} role
 * @param {string} requestId
 * @returns {HTMLElement}
 */
function ensureMessageElement(role, requestId) {
  const existing = document.querySelector(`[data-request-id="${cssEscape(requestId)}"]`);
  if (existing instanceof HTMLElement) return existing;
  const elem = createMessageElement(role, requestId);
  const messages = document.getElementById('messages');
  if (messages !== null) messages.appendChild(elem);
  return elem;
}

/**
 * Build a new `.message` element with the standard sub-tree.
 *
 * @param {'user' | 'assistant'} role
 * @param {string} requestId
 * @returns {HTMLElement}
 */
function createMessageElement(role, requestId) {
  const article = document.createElement('article');
  article.className = 'message';
  article.dataset.role = role;
  article.dataset.requestId = requestId;
  article.dataset.streaming = 'true';

  const header = document.createElement('header');
  header.className = 'message-header';
  const roleSpan = document.createElement('span');
  roleSpan.className = 'message-role';
  roleSpan.textContent = role;
  const statusSpan = document.createElement('span');
  statusSpan.className = 'message-status';
  statusSpan.textContent = role === 'user' ? '' : 'starting…';
  header.appendChild(roleSpan);
  header.appendChild(statusSpan);

  const body = document.createElement('div');
  body.className = 'body';

  const actions = document.createElement('div');
  actions.className = 'message-actions';

  // Stop button (R20.1) — present on assistant messages only.
  if (role === 'assistant') {
    const stop = document.createElement('button');
    stop.type = 'button';
    stop.className = 'stop-btn';
    stop.textContent = 'Stop';
    stop.addEventListener('click', () => onStop(requestId));
    actions.appendChild(stop);
  }

  article.appendChild(header);
  article.appendChild(body);
  article.appendChild(actions);
  return article;
}

/**
 * R20.2 (webview side): send exactly one cancel; disable the button
 * immediately so a double-click cannot send a duplicate.
 *
 * @param {string} requestId
 */
function onStop(requestId) {
  sendToHost({ kind: 'cancel', requestId });
  const elem = document.querySelector(`[data-request-id="${cssEscape(requestId)}"]`);
  if (!(elem instanceof HTMLElement)) return;
  const stop = elem.querySelector('.stop-btn');
  if (stop instanceof HTMLButtonElement) {
    stop.disabled = true;
  }
}

// ─── Action buttons (R16.5) ──────────────────────────────────────────────

/**
 * Add the per-block Copy / Insert buttons inside every fenced code
 * block on the message element. Idempotent — re-running on the same
 * element does not produce duplicates.
 *
 * @param {HTMLElement} messageElem
 */
function attachCodeBlockHandlers(messageElem) {
  const blocks = messageElem.querySelectorAll('.code-block');
  for (const block of blocks) {
    if (block.querySelector('.code-actions') !== null) continue;
    const code = block.querySelector('code.code-inner');
    if (code === null) continue;
    const actions = document.createElement('div');
    actions.className = 'code-actions';

    const copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'copy-btn';
    copy.textContent = 'Copy';
    copy.addEventListener('click', () => {
      sendToHost({ kind: 'copyCode', code: textOf(code) });
      flashButton(copy, 'Copied');
    });

    const insert = document.createElement('button');
    insert.type = 'button';
    insert.className = 'insert-btn';
    insert.textContent = 'Insert at cursor';
    insert.addEventListener('click', () => {
      sendToHost({ kind: 'insertCode', code: textOf(code) });
      flashButton(insert, 'Inserted');
    });

    actions.appendChild(copy);
    actions.appendChild(insert);
    block.appendChild(actions);
  }
}

/**
 * Add a "Save as file" button to the message-actions row. Idempotent.
 *
 * @param {HTMLElement} messageElem
 */
function addSaveAsFileButton(messageElem) {
  const actions = messageElem.querySelector('.message-actions');
  if (actions === null) return;
  if (actions.querySelector('.save-btn') !== null) return;
  const requestId = messageElem.dataset.requestId ?? '';
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'save-btn';
  button.textContent = 'Save as file';
  button.addEventListener('click', () => {
    sendToHost({
      kind: 'saveMarkdown',
      messageId: requestId,
      defaultName: 'response.md',
    });
  });
  actions.appendChild(button);
}

/**
 * Add a "Save to workspace" button (image responses only).
 *
 * @param {HTMLElement} messageElem
 * @param {string} requestId
 */
function addSaveImageButton(messageElem, requestId) {
  const actions = messageElem.querySelector('.message-actions');
  if (actions === null) return;
  if (actions.querySelector('.save-btn') !== null) return;
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'save-btn';
  button.textContent = 'Save to workspace';
  button.addEventListener('click', () => {
    sendToHost({
      kind: 'saveImage',
      messageId: requestId,
      defaultName: 'image.png',
    });
  });
  actions.appendChild(button);
}

/**
 * R16.5: explicitly enable each final-message action button. CSS hides
 * them while `.message[data-streaming="true"]`; once data-streaming
 * flips to "false" the rules go inactive. We additionally clear any
 * `disabled` attribute that might have been set earlier.
 *
 * @param {HTMLElement} messageElem
 */
function enableFinalActions(messageElem) {
  const buttons = messageElem.querySelectorAll('.copy-btn, .insert-btn, .save-btn');
  for (const button of buttons) {
    if (button instanceof HTMLButtonElement) {
      button.disabled = false;
    }
  }
}

/**
 * @param {HTMLButtonElement} button
 * @param {string} label
 */
function flashButton(button, label) {
  const original = button.textContent ?? '';
  button.textContent = label;
  window.setTimeout(() => {
    button.textContent = original;
  }, 1200);
}

// ─── Markdown renderer ───────────────────────────────────────────────────

/**
 * Recognised language tags. Anything outside this set falls through to
 * plain monospaced text per R16.3. Aliases map onto a canonical name
 * so token regexes can be looked up consistently.
 *
 * @type {Readonly<Record<string, string>>}
 */
const LANG_ALIAS = Object.freeze({
  ts: 'ts',
  typescript: 'ts',
  tsx: 'ts',
  js: 'js',
  javascript: 'js',
  jsx: 'js',
  py: 'py',
  python: 'py',
  json: 'json',
  html: 'html',
  css: 'css',
  scss: 'css',
  sh: 'sh',
  bash: 'sh',
  shell: 'sh',
  sql: 'sql',
  yaml: 'yaml',
  yml: 'yaml',
});

/**
 * Per-language reserved-word sets. Used by the tokenizer below.
 *
 * @type {Readonly<Record<string, ReadonlySet<string>>>}
 */
const KEYWORDS = Object.freeze({
  ts: new Set([
    'abstract', 'as', 'async', 'await', 'boolean', 'break', 'case', 'catch',
    'class', 'const', 'continue', 'debugger', 'declare', 'default', 'delete',
    'do', 'else', 'enum', 'export', 'extends', 'false', 'finally', 'for',
    'from', 'function', 'get', 'if', 'implements', 'import', 'in',
    'instanceof', 'interface', 'is', 'keyof', 'let', 'namespace', 'new',
    'null', 'number', 'of', 'private', 'protected', 'public', 'readonly',
    'return', 'set', 'static', 'string', 'super', 'switch', 'this', 'throw',
    'true', 'try', 'type', 'typeof', 'undefined', 'unknown', 'var', 'void',
    'while', 'yield',
  ]),
  js: new Set([
    'async', 'await', 'break', 'case', 'catch', 'class', 'const', 'continue',
    'debugger', 'default', 'delete', 'do', 'else', 'export', 'extends',
    'false', 'finally', 'for', 'from', 'function', 'if', 'import', 'in',
    'instanceof', 'let', 'new', 'null', 'of', 'return', 'super', 'switch',
    'this', 'throw', 'true', 'try', 'typeof', 'undefined', 'var', 'void',
    'while', 'yield',
  ]),
  py: new Set([
    'False', 'None', 'True', 'and', 'as', 'assert', 'async', 'await', 'break',
    'class', 'continue', 'def', 'del', 'elif', 'else', 'except', 'finally',
    'for', 'from', 'global', 'if', 'import', 'in', 'is', 'lambda', 'nonlocal',
    'not', 'or', 'pass', 'raise', 'return', 'try', 'while', 'with', 'yield',
  ]),
  sh: new Set([
    'if', 'then', 'else', 'elif', 'fi', 'case', 'esac', 'for', 'while',
    'until', 'do', 'done', 'in', 'function', 'echo', 'export', 'return',
    'set', 'unset', 'shift', 'local', 'readonly', 'cd', 'true', 'false',
  ]),
  sql: new Set([
    'select', 'from', 'where', 'and', 'or', 'not', 'insert', 'into', 'values',
    'update', 'set', 'delete', 'create', 'table', 'index', 'view', 'drop',
    'alter', 'add', 'column', 'primary', 'key', 'foreign', 'references',
    'join', 'inner', 'left', 'right', 'outer', 'on', 'group', 'by', 'order',
    'asc', 'desc', 'limit', 'offset', 'as', 'distinct', 'union', 'all',
    'null', 'is', 'in', 'between', 'like', 'case', 'when', 'then', 'else',
    'end', 'with', 'having',
  ]),
  json: new Set(['true', 'false', 'null']),
  yaml: new Set(['true', 'false', 'null', 'yes', 'no', 'on', 'off']),
  html: new Set([]),
  css: new Set([]),
});

/**
 * Render a markdown-ish string into HTML. Supported features (kept
 * intentionally minimal):
 *   - fenced code blocks with optional language tag
 *   - inline `code`
 *   - paragraph breaks on blank lines
 *   - line breaks inside paragraphs
 *
 * Headings, lists, and emphasis pass through as escaped text (so a
 * server-side markdown viewer remains the source of truth for rich
 * formatting). The renderer is pure and side-effect free.
 *
 * @param {string} text
 * @returns {string}  Sanitised HTML.
 */
function renderMarkdown(text) {
  /** @type {string[]} */
  const out = [];
  /** Split on fenced blocks first so inline-code/paragraphs ignore them. */
  const fenceRe = /```([A-Za-z0-9_+\-]*)\n([\s\S]*?)\n?```/g;
  let last = 0;
  let m = fenceRe.exec(text);
  while (m !== null) {
    if (m.index > last) {
      out.push(renderProse(text.slice(last, m.index)));
    }
    const lang = (m[1] ?? '').trim().toLowerCase();
    const body = m[2] ?? '';
    out.push(renderCodeBlock(body, lang));
    last = fenceRe.lastIndex;
    m = fenceRe.exec(text);
  }
  if (last < text.length) {
    out.push(renderProse(text.slice(last)));
  }
  return out.join('');
}

/**
 * Render plain prose: paragraphs split by blank lines, with `<br>`
 * preserving in-paragraph line breaks and inline `code`.
 *
 * @param {string} chunk
 * @returns {string}
 */
function renderProse(chunk) {
  if (chunk.length === 0) return '';
  const paragraphs = chunk.split(/\n\s*\n/);
  const html = paragraphs
    .map((p) => p.replace(/^\s+|\s+$/g, ''))
    .filter((p) => p.length > 0)
    .map((p) => `<p>${inlineMarkup(p)}</p>`)
    .join('');
  return html;
}

/**
 * Inline-level markup: escape HTML, then re-introduce `<code>` for
 * single-backtick spans and `<br>` for line breaks. Order matters —
 * we replace inline code first against the escaped text so that
 * back-tick boundaries are preserved.
 *
 * @param {string} s
 * @returns {string}
 */
function inlineMarkup(s) {
  const escaped = escapeHtml(s);
  // Single-backtick inline code. Greedy is fine because the regex is
  // bounded by backticks and the escaper has already neutralised any
  // HTML inside.
  const withCode = escaped.replace(/`([^`\n]+)`/g, (_match, body) => `<code>${body}</code>`);
  return withCode.replace(/\n/g, '<br>');
}

/**
 * Render a fenced code block. R13.6: emit a wrapper that
 * `attachCodeBlockHandlers` can later decorate with Copy / Insert
 * buttons. R16.2 / R16.3: highlight known languages, monospaced plain
 * text otherwise.
 *
 * @param {string} body
 * @param {string} rawLang
 * @returns {string}
 */
function renderCodeBlock(body, rawLang) {
  const lang = rawLang.length === 0 ? '' : (LANG_ALIAS[rawLang] ?? '');
  const inner = lang === '' ? escapeHtml(body) : highlight(body, lang);
  const langAttr = rawLang.length === 0 ? '' : ` data-lang="${escapeHtml(rawLang)}"`;
  return `<div class="code-block"${langAttr}><pre><code class="code-inner">${inner}</code></pre></div>`;
}

/**
 * Tokenise `code` for `lang` (already canonicalised via `LANG_ALIAS`).
 * Each match is wrapped in a span; everything else is HTML-escaped.
 *
 * @param {string} code
 * @param {string} lang
 * @returns {string}
 */
function highlight(code, lang) {
  const keywords = KEYWORDS[lang];
  if (keywords === undefined) return escapeHtml(code);

  // Combined token regex per language family. Order matters: comments
  // and strings before identifiers and numbers.
  const re = pickTokenRegex(lang);
  re.lastIndex = 0;

  let out = '';
  let cursor = 0;
  let match = re.exec(code);
  while (match !== null) {
    if (match.index > cursor) {
      out += escapeHtml(code.slice(cursor, match.index));
    }
    const groups = match.groups ?? {};
    if (typeof groups.com === 'string') {
      out += `<span class="tok-comment">${escapeHtml(groups.com)}</span>`;
    } else if (typeof groups.str === 'string') {
      out += `<span class="tok-string">${escapeHtml(groups.str)}</span>`;
    } else if (typeof groups.num === 'string') {
      out += `<span class="tok-number">${escapeHtml(groups.num)}</span>`;
    } else if (typeof groups.id === 'string') {
      const id = groups.id;
      const lookup = lang === 'sql' ? id.toLowerCase() : id;
      if (keywords.has(lookup)) {
        out += `<span class="tok-keyword">${escapeHtml(id)}</span>`;
      } else {
        out += escapeHtml(id);
      }
    } else {
      out += escapeHtml(match[0]);
    }
    cursor = re.lastIndex;
    match = re.exec(code);
  }
  if (cursor < code.length) {
    out += escapeHtml(code.slice(cursor));
  }
  return out;
}

/**
 * @param {string} lang
 * @returns {RegExp}
 */
function pickTokenRegex(lang) {
  switch (lang) {
    case 'ts':
    case 'js':
      return /(?<com>\/\/[^\n]*|\/\*[\s\S]*?\*\/)|(?<str>"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)|(?<num>\b\d+(?:\.\d+)?\b)|(?<id>[A-Za-z_$][A-Za-z0-9_$]*)/g;
    case 'py':
      return /(?<com>#[^\n]*)|(?<str>"""[\s\S]*?"""|'''[\s\S]*?'''|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')|(?<num>\b\d+(?:\.\d+)?\b)|(?<id>[A-Za-z_][A-Za-z0-9_]*)/g;
    case 'sh':
      return /(?<com>#[^\n]*)|(?<str>"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')|(?<num>\b\d+\b)|(?<id>[A-Za-z_][A-Za-z0-9_]*)/g;
    case 'sql':
      return /(?<com>--[^\n]*|\/\*[\s\S]*?\*\/)|(?<str>'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")|(?<num>\b\d+(?:\.\d+)?\b)|(?<id>[A-Za-z_][A-Za-z0-9_]*)/g;
    case 'json':
      return /(?<str>"(?:[^"\\]|\\.)*")|(?<num>-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b)|(?<id>true|false|null)/g;
    case 'yaml':
      return /(?<com>#[^\n]*)|(?<str>"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')|(?<num>\b\d+(?:\.\d+)?\b)|(?<id>true|false|null|yes|no|on|off)/g;
    case 'html':
    case 'css':
    default:
      return /(?<com>\/\*[\s\S]*?\*\/)|(?<str>"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')|(?<num>\b\d+(?:\.\d+)?\b)|(?<id>[A-Za-z_][A-Za-z0-9_-]*)/g;
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────

/**
 * @param {string} s
 * @returns {string}
 */
function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * CSS.escape polyfill for query-selector lookups by attribute value.
 * Modern Chromium (which VS Code's webview uses) ships CSS.escape so
 * we delegate to it when available.
 *
 * @param {string} s
 * @returns {string}
 */
function cssEscape(s) {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
    return CSS.escape(s);
  }
  return s.replace(/[^a-zA-Z0-9_-]/g, (ch) => `\\${ch}`);
}

/**
 * @param {Element} node
 * @returns {string}
 */
function textOf(node) {
  return node.textContent ?? '';
}

function scrollMessagesToBottom() {
  const messages = document.getElementById('messages');
  if (messages === null) return;
  messages.scrollTop = messages.scrollHeight;
}

/**
 * @returns {string}
 */
function cryptoRandomId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `id-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`;
}

// ─── Drag-and-drop pass-through (R18) ────────────────────────────────────
// The actual file-validation logic lives in the host (task 19.7) so the
// 25 MB / extension allow-list checks happen against the host's filesystem
// view. Here we only suppress the default browser behaviour; the host
// receives DnD events via VS Code's tree-data-transfer API, not through
// the webview.
['dragover', 'drop'].forEach((evt) => {
  document.body.addEventListener(evt, (event) => {
    event.preventDefault();
  });
});

// ─── Init ────────────────────────────────────────────────────────────────

renderAttachments();
setMode('chat');
