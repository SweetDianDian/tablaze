import type { Page } from 'playwright';

export type PageScriptOutcome =
  | { kind: 'ok'; json: string; bytes: number }
  | { kind: 'syntax' | 'runtime' | 'output_too_large' | 'output_unsupported' };

const maxOutputBytes = 64 * 1024;

/** Runs operator-enabled code in the active page origin. The page has full origin authority. */
export function executePageScript(page: Page, source: string, input: unknown): Promise<PageScriptOutcome> {
  return page.evaluate(async ({ source, input, maxOutputBytes }) => {
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (...args: string[]) => (input: unknown) => Promise<unknown>;
    const stringify = JSON.stringify.bind(JSON);
    let script: (input: unknown) => Promise<unknown>;
    try { script = new AsyncFunction('input', source); }
    catch { return { kind: 'syntax' as const }; }
    let value: unknown;
    try { value = await script(input); }
    catch { return { kind: 'runtime' as const }; }
    try {
      let nodes = 0, budget = 0;
      const json = stringify(value === undefined ? null : value, (key, item) => {
        nodes++;
        budget += key.length + (typeof item === 'string' ? item.length : typeof item === 'number' ? 32 : 4);
        if (nodes > 5_000 || budget > maxOutputBytes) throw new RangeError('bounded result');
        return item;
      });
      if (typeof json !== 'string' || json.length > maxOutputBytes) return { kind: 'output_too_large' as const };
      const bytes = new TextEncoder().encode(json).byteLength;
      if (bytes > maxOutputBytes) return { kind: 'output_too_large' as const };
      return { kind: 'ok' as const, json, bytes };
    } catch (error) {
      return { kind: error instanceof RangeError ? 'output_too_large' as const : 'output_unsupported' as const };
    }
  }, { source, input, maxOutputBytes });
}
