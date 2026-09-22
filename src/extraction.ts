import { Ajv, type ErrorObject } from 'ajv';
import formatsPlugin from 'ajv-formats';

export type JSONValue = null | boolean | number | string | JSONValue[] | { [key: string]: JSONValue };
export type ExtractionSchema = Record<string, unknown> | boolean;
export interface ExtractionSource { id: string; url: string; text: string }
export interface ExtractionCitation { pointer: string; sourceId: string; quote: string; url?: string }
export interface ExtractionCandidate { data: JSONValue; citations: ExtractionCitation[] }
export interface ValidatedCitation extends ExtractionCitation { url: string; start: number; end: number }
export interface ProvenanceExtraction {
  data: JSONValue;
  citations: ValidatedCitation[];
  schema_validated: true;
  provenance: 'source-quote-presence';
}
export class ExtractionError extends Error {
  constructor(public readonly code: string, message: string, public readonly issues?: { pointer: string; message: string }[]) { super(message); this.name = 'ExtractionError'; }
}

const maxOutputBytes = 2 * 1024 * 1024;
const pointerToken = (value: string) => value.replace(/~/g, '~0').replace(/\//g, '~1');
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const fail = (code: string, message: string): never => { throw new ExtractionError(code, message); };
const url = (value: unknown): string => {
  if (typeof value !== 'string' || value.length > 8192) return fail('INVALID_SOURCE', 'Source URLs must be HTTP(S) strings no longer than 8192 characters.');
  let parsed: URL;
  try { parsed = new URL(value); } catch { return fail('INVALID_SOURCE', 'Source URLs must be absolute HTTP(S) URLs.'); }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) return fail('INVALID_SOURCE', 'Source URLs must use HTTP(S) without embedded credentials.');
  return value;
};

/** Copy only JSON data, avoiding coercion, custom prototypes, accessors, cycles and unbounded depth. */
function jsonCopy(input: unknown, limit: number, code: string): JSONValue {
  const ancestors = new Set<object>();
  let nodes = 0, bytes = 0;
  const copy = (value: unknown, depth: number): JSONValue => {
    if (++nodes > 100000 || depth > 64) return fail(code, 'JSON data exceeds the supported node or depth limit.');
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'number') { if (!Number.isFinite(value)) return fail(code, 'JSON numbers must be finite.'); return value; }
    if (typeof value === 'string') { bytes += Buffer.byteLength(value); if (bytes > limit) return fail(code, 'JSON data exceeds the byte limit.'); return value; }
    if (!value || typeof value !== 'object' || ancestors.has(value)) return fail(code, 'Extraction accepts only acyclic JSON data.');
    if (!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return fail(code, 'Extraction accepts only plain JSON objects.');
    ancestors.add(value);
    let result: JSONValue;
    if (Array.isArray(value)) {
      result = [];
      for (let index = 0; index < value.length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || !('value' in descriptor)) return fail(code, 'Sparse arrays and accessors are not JSON data.');
        result.push(copy(descriptor.value, depth + 1));
      }
    } else {
      result = {};
      for (const key of Object.keys(value)) {
        bytes += Buffer.byteLength(key);
        if (bytes > limit) return fail(code, 'JSON data exceeds the byte limit.');
        const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
        if (!('value' in descriptor)) return fail(code, 'Accessors are not JSON data.');
        Object.defineProperty(result, key, { value: copy(descriptor.value, depth + 1), enumerable: true, configurable: true, writable: true });
      }
    }
    ancestors.delete(value);
    return result;
  };
  const result = copy(input, 0);
  if (Buffer.byteLength(JSON.stringify(result)) > limit) return fail(code, 'JSON data exceeds the byte limit.');
  return result;
}

function schemaValidator(schema: ExtractionSchema) {
  const safeSchema = jsonCopy(schema, 65536, 'INVALID_SCHEMA');
  if (typeof safeSchema !== 'boolean' && !record(safeSchema)) return fail('INVALID_SCHEMA', 'Use a JSON Schema object or boolean.');
  const inspect = (value: JSONValue) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return;
    if (Object.hasOwn(value, '$async')) return fail('INVALID_SCHEMA', 'Asynchronous schemas are not supported.');
    if (typeof value.$ref === 'string' && !value.$ref.startsWith('#')) return fail('INVALID_SCHEMA', 'Only local JSON Schema references are supported; external schemas are never fetched.');
    if (typeof value.$schema === 'string' && !['http://json-schema.org/draft-07/schema#', 'https://json-schema.org/draft-07/schema#'].includes(value.$schema)) return fail('INVALID_SCHEMA', 'Only JSON Schema draft-07 is supported.');
    // Only traverse schema-bearing keywords; const/default/enum objects are literal data.
    if (value.$schema === 'https://json-schema.org/draft-07/schema#') value.$schema = 'http://json-schema.org/draft-07/schema#';
    for (const key of ['additionalProperties', 'additionalItems', 'contains', 'not', 'if', 'then', 'else', 'propertyNames']) if (value[key] !== undefined) inspect(value[key]);
    for (const key of ['allOf', 'anyOf', 'oneOf', 'items']) {
      const nested = value[key];
      if (Array.isArray(nested)) nested.forEach(inspect);
      else if (nested !== undefined) inspect(nested);
    }
    for (const key of ['properties', 'patternProperties', 'definitions', '$defs', 'dependencies']) {
      const nested = value[key];
      if (nested && typeof nested === 'object' && !Array.isArray(nested)) Object.values(nested).forEach(inspect);
    }
  };
  inspect(safeSchema);
  try {
    const ajv = new Ajv({ allErrors: true, strict: true, allowUnionTypes: true, coerceTypes: false, useDefaults: false, removeAdditional: false });
    (formatsPlugin as unknown as (instance: Ajv) => Ajv)(ajv);
    return { schema: safeSchema as ExtractionSchema, validate: ajv.compile(safeSchema as ExtractionSchema) };
  } catch (error) {
    if (error instanceof ExtractionError) throw error;
    return fail('INVALID_SCHEMA', 'The extraction schema is invalid or uses unsupported keywords or references.');
  }
}
function checkSchema(validate: ReturnType<typeof schemaValidator>['validate'], data: JSONValue): void {
  let passed: boolean;
  try { const result = validate(data); if (typeof result !== 'boolean') return fail('INVALID_SCHEMA', 'Validation must be synchronous.'); passed = result; } catch { return fail('INVALID_SCHEMA', 'The schema could not validate this data safely.'); }
  if (!passed) throw new ExtractionError('SCHEMA_MISMATCH', 'Extracted data does not match the requested schema.', (validate.errors ?? []).slice(0, 50).map((error: ErrorObject) => ({ pointer: error.instancePath, message: error.message ?? error.keyword })));
}
function sourcesFor(input: readonly ExtractionSource[]): ExtractionSource[] {
  if (!Array.isArray(input) || input.length < 1 || input.length > 100) return fail('INVALID_SOURCE', 'Supply between 1 and 100 sources.');
  const ids = new Set<string>(); let characters = 0;
  return input.map(source => {
    if (!record(source) || typeof source.id !== 'string' || !source.id.trim() || source.id.length > 160 || ids.has(source.id)) return fail('INVALID_SOURCE', 'Source IDs must be unique nonempty strings no longer than 160 characters.');
    ids.add(source.id);
    if (typeof source.text !== 'string' || source.text.length > 100000 || (characters += source.text.length) > 2000000) return fail('INVALID_SOURCE', 'Each source permits 100000 text characters, with 2000000 characters across all sources.');
    return { id: source.id, url: url(source.url), text: source.text };
  });
}
function leafPointers(data: JSONValue): Set<string> {
  const leaves = new Set<string>();
  const visit = (value: JSONValue, pointer: string) => {
    if (value === null || typeof value !== 'object' || !Object.keys(value).length) leaves.add(pointer);
    else for (const [key, nested] of Object.entries(value)) visit(nested, `${pointer}/${pointerToken(key)}`);
    if (leaves.size > 5000) return fail('INVALID_CANDIDATE', 'Extraction supports at most 5000 populated leaves.');
  };
  visit(data, '');
  return leaves;
}

/** Validates schema conformance and exact quote presence, not semantic support or truth. */
export function validateProvenance(input: { schema: ExtractionSchema; sources: readonly ExtractionSource[]; candidate: unknown }): ProvenanceExtraction {
  const { validate } = schemaValidator(input.schema);
  const sources = sourcesFor(input.sources);
  const candidate = jsonCopy(input.candidate, maxOutputBytes, 'INVALID_CANDIDATE');
  if (!record(candidate) || Object.keys(candidate).some(key => !['data', 'citations'].includes(key)) || !Object.hasOwn(candidate, 'data') || !Array.isArray(candidate.citations) || candidate.citations.length < 1 || candidate.citations.length > 10000) return fail('INVALID_CANDIDATE', 'Return exactly data and between 1 and 10000 citations.');
  const data = candidate.data as JSONValue;
  checkSchema(validate, data);
  const leaves = leafPointers(data);
  const covered = new Set<string>();
  const byId = new Map(sources.map(source => [source.id, source]));
  const citations = candidate.citations.map(entry => {
    if (!record(entry) || Object.keys(entry).some(key => !['pointer', 'sourceId', 'quote', 'url'].includes(key)) || typeof entry.pointer !== 'string' || typeof entry.sourceId !== 'string' || typeof entry.quote !== 'string' || !entry.quote.trim() || entry.quote.length > 2000) return fail('INVALID_CITATION', 'Citations require a canonical leaf JSON pointer, sourceId, and a nonempty exact quote of at most 2000 characters.');
    if (!leaves.has(entry.pointer)) return fail('INVALID_CITATION', 'A citation pointer does not identify a populated leaf; use canonical JSON pointers, including array indices.');
    const source = byId.get(entry.sourceId);
    if (!source) return fail('INVALID_CITATION', 'A citation references an unknown source ID.');
    if (Object.hasOwn(entry, 'url') && entry.url !== source.url) return fail('INVALID_CITATION', 'A citation URL differs from its bound source URL.');
    const start = source.text.indexOf(entry.quote);
    if (start < 0) return fail('INVALID_CITATION', 'A citation quote does not occur exactly in its bound source text.');
    covered.add(entry.pointer);
    return { pointer: entry.pointer, sourceId: source.id, quote: entry.quote, url: source.url, start, end: start + entry.quote.length };
  });
  const missing = [...leaves].filter(pointer => !covered.has(pointer));
  if (missing.length) throw new ExtractionError('INCOMPLETE_EVIDENCE', 'Every primitive or empty-container leaf must have at least one source citation.', missing.slice(0, 50).map(pointer => ({ pointer, message: 'Missing source citation.' })));
  const result: ProvenanceExtraction = { data, citations, schema_validated: true, provenance: 'source-quote-presence' };
  if (Buffer.byteLength(JSON.stringify(result)) > maxOutputBytes) return fail('INVALID_CANDIDATE', 'Validated extraction exceeds the 2 MiB output limit.');
  return result;
}

export type ProvenanceExtractor = (request: { task?: string; schema: ExtractionSchema; sources: readonly Readonly<ExtractionSource>[]; signal: AbortSignal }) => Promise<unknown>;
export interface ProvenanceExtractionOptions {
  schema: ExtractionSchema;
  sources: readonly ExtractionSource[];
  extractor: ProvenanceExtractor;
  task?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Optional trusted application acceptance; only an explicit true accepts. */
  validateSupport?: (result: Readonly<ProvenanceExtraction>) => boolean | string | Promise<boolean | string>;
}
/** One injected extraction/aggregation call over bounded sources; never fetches URLs or retries. */
export async function extractWithProvenance(options: ProvenanceExtractionOptions): Promise<ProvenanceExtraction> {
  const sources = sourcesFor(options.sources);
  const { schema } = schemaValidator(options.schema);
  const timeout = options.timeoutMs ?? 60000;
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 3600000) return fail('INVALID_ARGUMENT', 'timeoutMs must be an integer from 1 to 3600000.');
  if (options.task !== undefined && (typeof options.task !== 'string' || options.task.length > 20000)) return fail('INVALID_ARGUMENT', 'Extraction task text must be a string of at most 20000 characters.');
  const freeze = (value: unknown): void => { if (value && typeof value === 'object') { Object.freeze(value); for (const nested of Object.values(value)) freeze(nested); } };
  freeze(sources); freeze(schema);
  const controller = new AbortController();
  const abort = () => controller.abort(new ExtractionError('CANCELLED', 'Extraction was cancelled.'));
  options.signal?.addEventListener('abort', abort, { once: true });
  if (options.signal?.aborted) abort();
  const timer = setTimeout(() => controller.abort(new ExtractionError('EXTRACTION_TIMEOUT', 'Extraction exceeded its time budget.')), timeout);
  const run = async <T>(operation: () => Promise<T>): Promise<T> => {
    controller.signal.throwIfAborted();
    let remove = () => {};
    const stopped = new Promise<never>((_, reject) => {
      const listener = () => reject(controller.signal.reason);
      controller.signal.addEventListener('abort', listener, { once: true });
      remove = () => controller.signal.removeEventListener('abort', listener);
    });
    try { return await Promise.race([Promise.resolve().then(() => { controller.signal.throwIfAborted(); return operation(); }), stopped]); }
    finally { remove(); }
  };
  try {
    const candidate = await run(() => options.extractor({ task: options.task, schema, sources, signal: controller.signal }));
    const result = validateProvenance({ schema, sources, candidate });
    if (options.validateSupport) {
      freeze(result);
      const accepted = await run(async () => options.validateSupport!(result));
      if (accepted !== true) return fail('SUPPORT_REJECTED', typeof accepted === 'string' ? accepted.slice(0, 2000) : 'The application did not accept the extracted claims.');
    }
    controller.signal.throwIfAborted();
    return result;
  } finally { clearTimeout(timer); options.signal?.removeEventListener('abort', abort); }
}

export type DOMFieldType = 'string' | 'number' | 'integer' | 'boolean';
export type DOMFieldMode = 'text' | 'attribute' | 'value';
export interface DOMFieldPlan { name: string; selector: string; mode: DOMFieldMode; attribute?: string; type?: DOMFieldType; multiple?: boolean; required?: boolean }
export interface DOMFieldObservation {
  ok: boolean;
  url: string;
  selector: string;
  matchIndex: number;
  mode: DOMFieldMode;
  attribute?: string;
  raw?: string;
  truncated?: boolean;
  error?: { code: string; message: string };
}
export interface DOMCitation { pointer: string; url: string; selector: string; matchIndex: number; mode: DOMFieldMode; attribute?: string; quote: string }
export interface DOMExtraction { data: Record<string, JSONValue>; citations: DOMCitation[]; schema_validated: true; provenance: 'dom-observation' }

export type NormalizedDOMFieldPlan = DOMFieldPlan & { type: DOMFieldType; multiple: boolean; required: boolean };
export function validateDOMFieldPlan(fields: readonly DOMFieldPlan[]): NormalizedDOMFieldPlan[] {
  if (!Array.isArray(fields) || fields.length < 1 || fields.length > 30) return fail('INVALID_FIELD_PLAN', 'Supply between 1 and 30 named fields.');
  const names = new Set<string>();
  return fields.map((field: DOMFieldPlan): NormalizedDOMFieldPlan => {
    if (!record(field) || Object.keys(field).some(key => !['name', 'selector', 'mode', 'attribute', 'type', 'multiple', 'required'].includes(key)) || typeof field.name !== 'string' || !field.name.trim() || field.name.length > 160 || names.has(field.name)) return fail('INVALID_FIELD_PLAN', 'Field names must be unique nonempty strings no longer than 160 characters.');
    names.add(field.name);
    if (typeof field.selector !== 'string' || !field.selector.trim() || field.selector.length > 1000 || !['text', 'attribute', 'value'].includes(field.mode)) return fail('INVALID_FIELD_PLAN', 'Each field requires a selector and text, attribute, or value mode.');
    if (field.mode === 'attribute' ? typeof field.attribute !== 'string' || !/^[A-Za-z_:][A-Za-z0-9_:.-]{0,99}$/.test(field.attribute) : field.attribute !== undefined) return fail('INVALID_FIELD_PLAN', 'Attribute mode requires a valid attribute name; other modes do not accept attribute.');
    if (field.type !== undefined && !['string', 'number', 'integer', 'boolean'].includes(field.type) || field.multiple !== undefined && typeof field.multiple !== 'boolean' || field.required !== undefined && typeof field.required !== 'boolean') return fail('INVALID_FIELD_PLAN', 'Invalid field type, multiple, or required option.');
    return { ...field, type: field.type ?? 'string', multiple: field.multiple ?? false, required: field.required ?? false };
  });
}

/** Self-contained page evaluator. Text MUST come from the shared composed-DOM inspector. */
export function inspectDOMField(input: { node: Element; selector: string; mode: DOMFieldMode; attribute?: string; matchIndex?: number; text?: { text: string; truncated: boolean; scan_truncated?: boolean } }): DOMFieldObservation {
  const node = input.node;
  const base = { url: document.location.href, selector: input.selector, matchIndex: input.matchIndex ?? 0, mode: input.mode, ...(input.attribute ? { attribute: input.attribute } : {}) };
  const reject = (code: string, message: string): DOMFieldObservation => ({ ...base, ok: false, error: { code, message } });
  if (!node?.isConnected) return reject('DETACHED_FIELD', 'The selected field is no longer attached.');
  if (node instanceof HTMLInputElement && ['hidden', 'password'].includes(node.type)) return reject('SENSITIVE_VALUE', 'Password and hidden controls cannot be extracted.');
  for (let current: Element | null = node; current;) {
    const style = getComputedStyle(current);
    if (current.hasAttribute('hidden') || current.getAttribute('aria-hidden') === 'true' || style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' || Number(style.opacity) === 0) return reject('HIDDEN_FIELD', 'The selected field is hidden.');
    current = current.assignedSlot ?? current.parentElement ?? (current.getRootNode() instanceof ShadowRoot ? (current.getRootNode() as ShadowRoot).host : null);
  }
  let raw: string;
  if (input.mode === 'text') {
    if (node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement || node instanceof HTMLSelectElement) return reject('FORM_TEXT', 'Use value mode for current form state; form text is not extracted.');
    if (!input.text || typeof input.text.text !== 'string') return reject('MISSING_TEXT', 'Text mode requires shared composed-DOM text evidence.');
    raw = input.text.text;
    if (!raw) return reject('EMPTY_FIELD', 'The selected field has no visible text.');
    if (input.text.truncated || input.text.scan_truncated) return reject('TRUNCATED_FIELD', 'The selected field text was truncated; narrow the selector.');
  } else if (input.mode === 'attribute') {
    if (!input.attribute) return reject('MISSING_ATTRIBUTE', 'Attribute mode requires an attribute name.');
    if (input.attribute.toLowerCase() === 'value' && (node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement || node instanceof HTMLSelectElement)) return reject('RAW_FORM_VALUE', 'Read current form state with value mode instead of a raw value attribute.');
    const value = node.getAttribute(input.attribute);
    if (value === null) return reject('MISSING_ATTRIBUTE', 'The requested attribute is absent.');
    raw = value;
  } else if (input.mode === 'value') {
    if (!(node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement || node instanceof HTMLSelectElement)) return reject('NOT_FORM_CONTROL', 'Value mode requires an input, textarea, or select.');
    if (!node.getClientRects().length) return reject('HIDDEN_FIELD', 'The selected control is not rendered.');
    if (node instanceof HTMLSelectElement && node.multiple) return reject('MULTIPLE_SELECT', 'A multiple select requires explicit option selectors; a single value would omit selections.');
    raw = node instanceof HTMLInputElement && ['checkbox', 'radio'].includes(node.type) ? String(node.checked) : node.value;
  } else return reject('INVALID_MODE', 'Unsupported field extraction mode.');
  if (raw.length > 20000) return reject('TRUNCATED_FIELD', 'The selected field exceeds 20000 characters; narrow the selector.');
  return { ...base, ok: true, raw, truncated: false };
}

/** Assemble trusted browser observations into a strict flat field map with per-value provenance. */
export function assembleDOMExtraction(input: { schema: ExtractionSchema; fields: readonly DOMFieldPlan[]; observations: Record<string, DOMFieldObservation[]> }): DOMExtraction {
  const fields = validateDOMFieldPlan(input.fields);
  const { validate } = schemaValidator(input.schema);
  const names = new Set(fields.map(field => field.name));
  if (!record(input.observations) || Object.keys(input.observations).some(name => !names.has(name))) return fail('INVALID_OBSERVATION', 'Observations must be keyed by the declared field names.');
  const data: Record<string, JSONValue> = {};
  const citations: DOMCitation[] = [];
  let total = 0;
  for (const field of fields) {
    const observations = Object.hasOwn(input.observations, field.name) ? input.observations[field.name] : [];
    if (!Array.isArray(observations) || observations.length > 20 || (total += observations.length) > 100) return fail('INVALID_OBSERVATION', 'Fields permit at most 20 matches each and 100 matches in total.');
    if (!observations.length) { if (field.required) return fail('MISSING_FIELD', `Required field ${JSON.stringify(field.name)} has no matching element.`); continue; }
    if (!field.multiple && observations.length !== 1) return fail('SELECTOR_COUNT', `Field ${JSON.stringify(field.name)} must match exactly one element.`);
    const values = observations.map((observation, index): JSONValue => {
      if (!record(observation) || observation.ok !== true) throw new ExtractionError(typeof observation?.error?.code === 'string' ? observation.error.code : 'INVALID_OBSERVATION', `Field ${JSON.stringify(field.name)} could not be read safely.`);
      if (observation.selector !== field.selector || observation.mode !== field.mode || observation.attribute !== field.attribute || observation.matchIndex !== index || typeof observation.raw !== 'string' || observation.raw.length > 20000 || observation.truncated !== false) return fail('INVALID_OBSERVATION', 'Field evidence does not match its plan, index, or completeness requirements.');
      const sourceUrl = url(observation.url);
      let value: JSONValue = observation.raw;
      const trimmed = observation.raw.trim();
      if (field.type === 'boolean') { if (!['true', 'false'].includes(trimmed)) return fail('TYPE_CONVERSION', `Field ${JSON.stringify(field.name)} must contain literal true or false.`); value = trimmed === 'true'; }
      else if (field.type === 'number' || field.type === 'integer') {
        if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(trimmed)) return fail('TYPE_CONVERSION', `Field ${JSON.stringify(field.name)} must contain an unambiguous JSON number.`);
        value = Number(trimmed);
        if (!Number.isFinite(value) || field.type === 'integer' && !Number.isSafeInteger(value)) return fail('TYPE_CONVERSION', `Field ${JSON.stringify(field.name)} is outside the supported numeric range.`);
      }
      citations.push({ pointer: `/${pointerToken(field.name)}${field.multiple ? `/${index}` : ''}`, url: sourceUrl, selector: field.selector, matchIndex: index, mode: field.mode, ...(field.attribute ? { attribute: field.attribute } : {}), quote: observation.raw });
      return value;
    });
    Object.defineProperty(data, field.name, { value: field.multiple ? values : values[0], enumerable: true, configurable: true, writable: true });
  }
  checkSchema(validate, data);
  const result: DOMExtraction = { data, citations, schema_validated: true, provenance: 'dom-observation' };
  if (Buffer.byteLength(JSON.stringify(result)) > maxOutputBytes) return fail('INVALID_OBSERVATION', 'DOM extraction exceeds the 2 MiB output limit.');
  return result;
}
