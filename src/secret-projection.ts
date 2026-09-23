/** Host-side text operations; no secret values are sent to a page evaluator. */
export interface SecretRedactor {
  redact(text: string): string;
  redactPrefix(text: string, rawLimit: number): string;
  contains(text: string): boolean;
}

type Output = Record<string, unknown>;
const object = (value: unknown): value is Output => value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * Retain only the original raw prefix, using trailing lookahead to recognize a
 * secret crossing its boundary. A shorter replacement must never promote the
 * lookahead into public output: its far end may itself cut another secret.
 * A boundary-crossing replacement can conservatively shorten the returned text.
 */
export function projectSecretText(text: string, limit: number, redactor: SecretRedactor): string {
  if (typeof text !== 'string' || !Number.isInteger(limit) || limit < 0 || limit > 20000) throw new Error('Invalid secret text projection.');
  if (!limit) return '';
  return redactor.redactPrefix(text, limit).slice(0, limit);
}

function projectFields(value: Output, limits: Record<string, number>, redactor: SecretRedactor): Output {
  const result = { ...value };
  for (const [key, limit] of Object.entries(limits)) {
    if (typeof value[key] === 'string') result[key] = projectSecretText(value[key], limit, redactor);
  }
  return result;
}

/** Copy a public snapshot; opaque refs, IDs, roles, codes and truncation stay intact.
 * Nested action snapshots are deliberately not projected here: call separately.
 */
export function projectSecretSnapshot(output: Output, textLimit: number, redactor: SecretRedactor): Output {
  const result = projectFields(output, { text: textLimit, title: 1000, url: 4000 }, redactor);
  const entry = (value: unknown): unknown => {
    if (!object(value)) return value;
    const projected = projectFields(value, { name: 400, value: 1000, href: 2000 }, redactor);
    if (Array.isArray(value.options)) projected.options = value.options.map(option => object(option)
      ? projectFields(option, { value: 100, label: 100 }, redactor) : option);
    return projected;
  };
  for (const key of ['elements', 'added', 'changed']) {
    if (Array.isArray(output[key])) result[key] = output[key].map(entry);
  }
  if (Array.isArray(output.tabs)) result.tabs = output.tabs.map(tab => object(tab) ? projectFields(tab, { url: 4000 }, redactor) : tab);
  if (Array.isArray(output.frames)) result.frames = output.frames.map(frame => object(frame) ? projectFields(frame, { url: 4000, name: 200 }, redactor) : frame);
  if (object(output.scope)) result.scope = projectFields(output.scope, { selector: 1000 }, redactor);
  return result;
}

/** Redact before public clipping, retaining the reader's original 20k allocation.
 * The DOM reader charges href before link text; reproduce that order even though
 * each returned item lists text first. Redaction never expands the raw allocation.
 */
export function projectSecretExtraction(output: Output, kind: 'text' | 'links' | 'table', redactor: SecretRedactor): Output {
  const result = { ...output };
  if (kind === 'text') {
    if (typeof output.text === 'string') result.text = projectSecretText(output.text, 20000, redactor);
    return result;
  }
  let rawRemaining = 20000, publicRemaining = 20000;
  const limited = (text: string, limit: number): string => {
    const allocation = Math.min(limit, rawRemaining);
    rawRemaining -= Math.min(text.length, allocation);
    const projected = projectSecretText(text, allocation, redactor).slice(0, publicRemaining);
    publicRemaining -= projected.length;
    return projected;
  };
  if (Array.isArray(output.items)) {
    if (kind === 'links') result.items = output.items.map(item => {
      if (!object(item)) return item;
      const projected = { ...item };
      if (typeof item.href === 'string') projected.href = limited(item.href, 2000);
      if (typeof item.text === 'string') projected.text = limited(item.text, 1000);
      return projected;
    });
    else if (kind === 'table') result.items = output.items.map(row => Array.isArray(row)
      ? row.map(cell => typeof cell === 'string' ? limited(cell, 1000) : cell) : row);
  }
  return result;
}

/**
 * Redact a caller-selected JSON metadata subtree, before any caller-side clip.
 * This intentionally has no knowledge of protocol IDs: never pass a whole tool
 * envelope or schema/citation result. Property names remain unchanged.
 */
export function redactSecretMetadata<T>(value: T, redactor: SecretRedactor): T {
  const ancestors = new Set<object>();
  let nodes = 0, units = 0, publicUnits = 0;
  const visit = (item: unknown, depth: number): unknown => {
    if (++nodes > 100000 || depth > 64) throw new Error('Secret metadata exceeds the projection limit.');
    if (typeof item === 'string') {
      units += item.length;
      if (units > 8 * 1024 * 1024) throw new Error('Secret metadata exceeds the projection limit.');
      const projected = redactor.redact(item);
      publicUnits += projected.length;
      if (publicUnits > 8 * 1024 * 1024) throw new Error('Secret metadata exceeds the projection limit.');
      return projected;
    }
    if (item === null || typeof item === 'number' || typeof item === 'boolean' || item === undefined) return item;
    if (typeof item !== 'object' || ancestors.has(item)) throw new Error('Invalid secret metadata projection.');
    ancestors.add(item);
    let result: unknown;
    if (Array.isArray(item)) result = item.map(child => visit(child, depth + 1));
    else {
      if (![Object.prototype, null].includes(Object.getPrototypeOf(item))) throw new Error('Invalid secret metadata projection.');
      result = Object.fromEntries(Object.entries(item).map(([key, child]) => [key, visit(child, depth + 1)]));
    }
    ancestors.delete(item);
    return result;
  };
  return visit(value, 0) as T;
}
