import { createHash } from 'node:crypto';
import { compileJSONSchema, type ExtractionSchema } from './extraction.js';

/** Compile once, then bind the exact safe schema to an Agent checkpoint. */
export function compileFinalOutput(schema: ExtractionSchema) {
  const compiled = compileJSONSchema(schema);
  const hash = createHash('sha256').update(JSON.stringify(compiled.schema)).digest('hex');
  return { ...compiled, hash };
}
