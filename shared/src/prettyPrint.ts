/**
 * Deterministic, schema-aware JSON pretty printer.
 *
 * Walks any wire-protocol value (Request, StreamChunk, Session, …) and
 * emits a 2-space-indented JSON-compatible string. At each object level
 * keys are emitted in {@link FIELD_ORDER} order for the active type tag;
 * any keys not in that order are sorted lexicographically and appended.
 * `undefined` properties are skipped entirely (never emitted as `null`).
 *
 * The output is byte-stable for any two structurally equal inputs, which
 * is what makes the on-disk session format (R26.3, R26.4) and the wire
 * pretty-form (R26.2) deterministic across producers regardless of how
 * the source object was constructed (own-property insertion order,
 * `JSON.parse`, `structuredClone`, …).
 *
 * Round-trip safe: {@link parsePrettyPrinted} composed with
 * {@link prettyPrint} yields a structurally equal object.
 *
 * Implements R26.2 (deterministic pretty printer), R26.3 (round-trip
 * safe schema), R26.4 (image and attachment round-trip).
 */

// ─── Field order tables ────────────────────────────────────────────────────

/**
 * Type tag → canonical field order. At each object level, listed keys are
 * emitted first in this exact order; any owned-but-unlisted keys are sorted
 * lexicographically and appended after the known ones.
 *
 * Adding a wire field requires touching this table so the pretty form
 * stays deterministic; missing keys are tolerated (treated as unknown and
 * sorted), but absent keys never appear in output.
 */
export const FIELD_ORDER = {
  Request:           ['protocolVersion', 'requestId', 'clientId', 'sessionId', 'type', 'prompt', 'codeContext', 'history', 'attachments', 'submittedAt'],
  StreamChunk:       ['protocolVersion', 'requestId', 'chunkIndex', 'text', 'isFinal', 'mediaType', 'base64', 'status', 'errorCode', 'message'],
  CodeContext:       ['selection', 'filePath', 'language', 'fileContent', 'expandedTokens', 'truncated'],
  ExpandedToken:     ['token', 'kind', 'bytes'],
  Attachment:        ['filename', 'mimeType', 'base64'],
  HistoryMessage:    ['role', 'text', 'createdAt'],
  CancelSignal:      ['protocolVersion', 'requestId'],
  RequestStatusEvent:['protocolVersion', 'kind', 'requestId', 'status', 'agentId', 'queuePosition', 'retryCount'],
  AgentStatusEvent:  ['protocolVersion', 'kind', 'agentId', 'status', 'message'],
  ServerStatusEvent: ['protocolVersion', 'kind', 'registeredAgents', 'agentsReady', 'queueDepth', 'loginRequiredAll'],
  AgentHeartbeat:    ['protocolVersion', 'agentId', 'emittedAt'],
  ClientHandshake:   ['kiroSecret', 'clientVersion'],
  AgentHandshake:    ['agentSecret', 'agentVersion', 'capabilities'],
  Session:           ['sessionId', 'createdAt', 'updatedAt', 'messages'],
  SessionMessage:    ['id', 'role', 'text', 'mediaType', 'createdAt'],
} as const;

/** Closed union of every type tag known to the pretty printer. */
export type TypeTag = keyof typeof FIELD_ORDER;

/**
 * Sentinel used internally for nested objects whose shape has no dedicated
 * field-order list (e.g. {@link CodeContext.truncated} and the small
 * `capabilities` record on {@link AgentHandshake}). For inline values, all
 * keys are sorted lexicographically.
 */
const INLINE = '<inline>' as const;
type EmitTag = TypeTag | typeof INLINE;

/**
 * Heuristic field-name → type-tag map used to recurse into nested objects
 * and arrays. When an object property holds another schema object, the
 * walker looks up the property name here to pick the next field-order
 * list. Property names not in this map fall through to {@link INLINE}
 * (lexicographic ordering of their own keys).
 *
 * For arrays, the looked-up tag is applied to *each element* (e.g. every
 * entry in `attachments[]` is emitted with the `Attachment` order).
 */
const FIELD_TO_TYPE: Record<string, EmitTag> = {
  codeContext: 'CodeContext',
  attachments: 'Attachment',
  history: 'HistoryMessage',
  expandedTokens: 'ExpandedToken',
  messages: 'SessionMessage',
  capabilities: INLINE,
  truncated: INLINE,
};

// ─── Walker ────────────────────────────────────────────────────────────────

/** Two-space indent unit, fixed by R26.2. */
const INDENT_UNIT = '  ';

/** True for non-null, non-array objects (the only shape we recurse into as records). */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Render any value using the schema-aware ordering rules. The `tag`
 * controls how object keys at *this* level are ordered; for primitives
 * and arrays it is simply forwarded to children.
 */
function emitValue(value: unknown, tag: EmitTag, depth: number): string {
  if (value === null) {
    return 'null';
  }
  switch (typeof value) {
    case 'string':
      // Use JSON.stringify so escapes (\uXXXX, \", \\, control chars) match
      // the JSON spec exactly — this is what makes round-tripping safe.
      return JSON.stringify(value);
    case 'number':
      // JSON has no NaN/Infinity; match JSON.stringify's behaviour of
      // coercing them to null so the output is always parseable.
      return Number.isFinite(value) ? String(value) : 'null';
    case 'boolean':
      return value ? 'true' : 'false';
    case 'bigint':
      // Out of schema; coerce to its decimal form so we never throw on
      // unexpected inputs. (No wire field is a bigint today.)
      return String(value);
    case 'object': {
      if (Array.isArray(value)) {
        return emitArray(value, tag, depth);
      }
      if (isPlainObject(value)) {
        return emitObject(value, tag, depth);
      }
      // Date, Map, Set, etc. are not part of the wire schema — fall back
      // to JSON.stringify so we never explode on an unexpected payload.
      return JSON.stringify(value);
    }
    default:
      // `undefined`, `function`, `symbol` — should be filtered by callers.
      return 'null';
  }
}

/**
 * Render an object as `{\n  "k": v,\n  ...\n}` with keys ordered by
 * {@link FIELD_ORDER}[tag] first, then any remaining keys sorted
 * lexicographically. Properties whose value is `undefined` are omitted.
 */
function emitObject(obj: Record<string, unknown>, tag: EmitTag, depth: number): string {
  const childIndent = INDENT_UNIT.repeat(depth + 1);
  const closeIndent = INDENT_UNIT.repeat(depth);

  // All present keys (excluding undefined values, which are not emitted).
  const presentKeys = Object.keys(obj).filter((k) => obj[k] !== undefined);

  const known: readonly string[] = tag === INLINE ? [] : FIELD_ORDER[tag];
  const knownSet = new Set<string>(known);

  // Known keys in declared order, but only those actually present.
  const orderedKnown = known.filter((k) => presentKeys.includes(k));
  // Anything else, sorted lexicographically (Array.prototype.sort default).
  const orderedUnknown = presentKeys.filter((k) => !knownSet.has(k)).sort();
  const orderedKeys = [...orderedKnown, ...orderedUnknown];

  if (orderedKeys.length === 0) {
    return '{}';
  }

  const lines = orderedKeys.map((key) => {
    const childTag: EmitTag = FIELD_TO_TYPE[key] ?? INLINE;
    const rendered = emitValue(obj[key], childTag, depth + 1);
    return `${childIndent}${JSON.stringify(key)}: ${rendered}`;
  });

  return `{\n${lines.join(',\n')}\n${closeIndent}}`;
}

/**
 * Render an array as `[\n  v,\n  ...\n]`. Element order is preserved
 * (arrays are ordered data; only object key order is normalised). Each
 * element is rendered with the parent-derived `tag` so e.g. every entry
 * of an `attachments` array is emitted with the `Attachment` ordering.
 */
function emitArray(arr: readonly unknown[], tag: EmitTag, depth: number): string {
  if (arr.length === 0) {
    return '[]';
  }
  const childIndent = INDENT_UNIT.repeat(depth + 1);
  const closeIndent = INDENT_UNIT.repeat(depth);

  const lines = arr.map((item) => `${childIndent}${emitValue(item, tag, depth + 1)}`);
  return `[\n${lines.join(',\n')}\n${closeIndent}]`;
}

// ─── Public API ────────────────────────────────────────────────────────────

/**
 * Deterministic, schema-aware JSON pretty printer. Walks `value` and emits
 * keys in `FIELD_ORDER[typeTag]` order at each object level; unknown keys
 * are sorted lexicographically and appended after the known ones. Arrays
 * preserve their input order. Indent is fixed at 2 spaces. No trailing
 * newline. Output is UTF-8 bytes by character.
 *
 * For two structurally-equal inputs `x` and `y`,
 * `prettyPrint(t, x) === prettyPrint(t, y)` as a string (Property 5
 * determinism). The output is also valid JSON, so
 * {@link parsePrettyPrinted} composed with this function is the identity
 * up to structural equality (Property 5 round-trip).
 *
 * Implements R26.2, R26.3, R26.4.
 *
 * @param typeTag Schema type at the *root* of `value`; controls top-level
 *                key ordering. Nested object/array shapes are recursed
 *                into using the heuristic field-name → type map.
 * @param value   Any value matching the wire schema for `typeTag`.
 *                `undefined` properties are silently dropped.
 * @returns Canonical pretty form, no trailing newline.
 */
export function prettyPrint<T>(typeTag: TypeTag, value: T): string {
  return emitValue(value, typeTag, 0);
}

/**
 * Parse the output of {@link prettyPrint} back into a structurally-equal
 * object. The pretty form is standard JSON, so this is `JSON.parse`
 * followed by an unsafe cast — round-trip safety is the caller's
 * contract (i.e. only feed this strings produced by {@link prettyPrint}
 * or another deterministic JSON source).
 *
 * Implements R26.3, R26.4.
 */
export function parsePrettyPrinted<T>(input: string): T {
  return JSON.parse(input) as T;
}
