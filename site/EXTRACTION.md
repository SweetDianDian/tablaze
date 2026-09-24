# Schema extraction and provenance

Tablaze provides deterministic extraction from browser fields and a separate provider-independent API for aggregating supplied source text. Both validate JSON Schema draft-07 without coercing values, inserting defaults, or deleting unexpected properties. Schemas support standard formats through `ajv-formats` and local references such as `#/definitions/price`. External references, asynchronous schemas, and other schema dialects are rejected; no schema URL is fetched.

Provenance validation proves where an observation or quoted passage came from. **An exact quote does not prove that it supports the extracted claim, that the source is truthful, or that the result is complete for the user's task.** Use application acceptance checks for those requirements. The provider-independent API labels its guarantee `source-quote-presence` explicitly.

## Read typed browser fields

`BrowserEngine.extractStructured(sessionId, { schema, fields })` and the MCP tool `tab_extract_structured` operate on the active observed frame. Select a frame with `tab_snapshot` first when needed. A field plan names each top-level output property and the selector used to read it:

```json
{
  "session_id": "the-session-from-tab-open",
  "schema": {
    "type": "object",
    "properties": {
      "title": { "type": "string", "minLength": 1 },
      "price": { "type": "number", "minimum": 0 },
      "in_stock": { "type": "boolean" },
      "features": { "type": "array", "items": { "type": "string" } }
    },
    "required": ["title", "price", "in_stock", "features"],
    "additionalProperties": false
  },
  "fields": [
    { "name": "title", "selector": "h1", "mode": "text", "required": true },
    { "name": "price", "selector": "[data-price]", "mode": "attribute", "attribute": "data-price", "type": "number", "required": true },
    { "name": "in_stock", "selector": "#in-stock", "mode": "value", "type": "boolean", "required": true },
    { "name": "features", "selector": ".feature", "mode": "text", "multiple": true, "required": true }
  ]
}
```

The result contains `data`, `schema_validated: true`, `provenance: "dom-observation"`, and a citation for every returned scalar. Each citation includes its JSON pointer, actual frame URL, selector, zero-based `matchIndex`, reading mode, optional attribute, and the exact raw observation before type conversion. Array values use pointers such as `/features/0`.

Field behavior:

| Option | Behavior |
| --- | --- |
| `mode: "text"` | Uses the same whitespace-normalized composed DOM reader as snapshots and text verification, including open shadow roots and assigned slots. Empty visible text and truncated evidence fail. Form controls require value mode. |
| `mode: "attribute"` | Reads the named attribute with `getAttribute`; URLs in attributes remain in their original relative or absolute form. Missing attributes fail. Raw `value` attributes on form controls are rejected. |
| `mode: "value"` | Reads current input, textarea, or select state. Checkbox/radio controls return the checked state as `true` or `false`. Multiple-select controls require explicit option selectors to avoid silently losing selections. |
| `type` | Defaults to `string`; also supports `number`, `integer`, and `boolean`. Numbers require JSON numeric syntax; currency signs, thousands separators, leading zeroes, and nonfinite values fail. Integers must be safe JavaScript integers. Booleans require literal lowercase `true` or `false`. |
| `multiple` | Defaults to false, requiring a single match. When true, matching elements form an array in locator order. |
| `required` | Defaults to false. Unmatched optional fields are omitted, including optional array fields. An unmatched required field fails. The final JSON Schema can independently require properties. |

Password inputs, hidden inputs, and hidden target ancestry are rejected before returning a value. Initial textarea text is not extracted through text mode. Current values in ordinary visible form controls may still contain sensitive information; selector and task scope remain the caller's responsibility.

Plans allow 30 fields, 20 matches per field, 100 matches total, and 20,000 characters per observation. The serialized final result is limited to 2 MiB. A source URL must be HTTP(S), without embedded credentials. Closed shadow roots are outside the DOM reader's supported scope. Fields are collected sequentially; this is not a transactional snapshot of a page changing asynchronously.

Applications implementing another browser adapter can reuse `validateDOMFieldPlan`, the self-contained `inspectDOMField` page evaluator, and `assembleDOMExtraction`. Pass `inspectDOMField` an element, selector, mode, optional attribute, and match index. For text mode, first collect `{ text, truncated, scan_truncated }` from the shared `inspectDOM` evaluator and pass it as `text`. The assembler receives `{ schema, fields, observations }`, where observations map each field name to its observation array. These observations must come from trusted browser code; accepting model-invented observation objects would defeat DOM provenance.

## Aggregate several supplied sources

`extractWithProvenance` makes one call to an injected extractor. It does not select a model, fetch source URLs, retry calls, or require a paid provider. The callback can call a configured model, use a deterministic parser, or query an existing extraction service.

```js
import { extractWithProvenance } from 'tablaze';

const result = await extractWithProvenance({
  task: 'List the two offers and their prices.',
  sources: [
    { id: 'offer-a', url: 'https://example.test/a', text: 'Lisbon: 25 EUR.' },
    { id: 'offer-b', url: 'https://example.test/b', text: 'Porto: 15 EUR.' },
  ],
  schema: {
    type: 'object',
    properties: {
      prices: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 },
    },
    required: ['prices'],
    additionalProperties: false,
  },
  extractor: async ({ sources, schema, task, signal }) => {
    // Substitute your configured provider or parser here. Return this shape.
    return {
      data: { prices: [25, 15] },
      citations: [
        { pointer: '/prices/0', sourceId: sources[0].id, quote: '25 EUR' },
        { pointer: '/prices/1', sourceId: sources[1].id, quote: '15 EUR' },
      ],
    };
  },
  validateSupport: ({ data }) => data.prices.every(price => price >= 0),
});
```

The last callback is an example application constraint, not a general fact checker. For calculated totals, cite each contributing source at the total's pointer and independently verify the calculation in `validateSupport`.

The extractor receives copied, frozen source records and a frozen schema. Its candidate must contain exactly `{ data, citations }`. A citation contains:

```json
{ "pointer": "/prices/0", "sourceId": "offer-a", "quote": "25 EUR" }
```

Every primitive, `null`, and empty-container leaf needs at least one citation. Nonempty containers cannot stand in for their descendants. JSON pointers use `~0` for `~`, `~1` for `/`, decimal array indices, and `""` for a root scalar or empty container. Multiple citations may support one leaf.

Quotes must occur exactly in their bound source text; matching is case-sensitive and does not normalize whitespace. Unknown source IDs, invented or non-leaf pointers, missing evidence, and mismatched optional citation URLs are rejected. The API supplies each accepted citation's source URL and first matching UTF-16 `start`/`end` offsets. URLs are bound to the caller-supplied source records; they are not independently authenticated or fetched.

`validateProvenance({ schema, sources, candidate })` exposes the same synchronous schema and quote checks for a candidate obtained elsewhere. `validateSupport` belongs to `extractWithProvenance`; when installed it must explicitly return `true`, synchronously or asynchronously. False, nullish results, and corrective strings reject the extraction. Neither API silently repairs an invalid candidate.

## Use a separate extraction model

`extractWithPlanner` connects any supported `AgentPlanner` to the same bounded source, JSON Schema and exact-quote validator. Choose the extraction model explicitly; it is independent of the browser task planner. The model receives source text as lower-trust data and must return exactly one `submit_extraction` tool call. A model `agent_finish`, multiple calls, invalid schema, invented citation, or missing leaf citation cannot become a successful extraction. It makes one model request and no browser calls; `extractWithProvenance` still enforces timeout, cancellation and the optional trusted `validateSupport` check.

```js
import { createCodexPlanner, extractWithPlanner } from 'tablaze';

const planner = createCodexPlanner({ model: 'your-explicit-codex-model' });
try {
  const result = await extractWithPlanner({
    task: 'Extract the Lisbon offer.',
    sources: [{ id: 'offer', url: 'https://example.test/offer', text: 'Lisbon: 25 EUR.' }],
    schema: { type: 'object', properties: { city: { type: 'string' }, price: { type: 'number' } }, required: ['city', 'price'], additionalProperties: false },
    planner,
  });
  console.log(result.data, result.citations);
} finally { await planner.close(); }
```

The `tablaze-extract` command accepts a regular UTF-8 JSON source file (an array of `{id,url,text}`) and a draft-07 schema file. It does not visit the source URLs; obtain trusted, non-truncated observations first, for example with `tab_extract`. The default provider is Codex and uses its existing login. Other supported providers accept the same explicit model, endpoint and key environment conventions as `tablaze run`.

```sh
tablaze-extract --task 'Extract the Lisbon offer.' \
  --sources ./sources.json --schema ./offer.schema.json \
  --provider codex --model YOUR_CODEX_MODEL
```

The output includes validated `data`, bound citations, and only usage counters actually reported by the provider. Source text and extracted values may contain private page data; use the usual provider and output handling rules. Exact quote presence does not prove semantic support or completeness. This is currently a separate SDK/CLI extraction step, not an Agent-integrated replacement for Browser Use's `page_extraction_llm`. The [one real Codex sample](MODEL_EXTRACTION_20260924.md) and local tests validate the new path, not model accuracy across varied pages or comparative cost and latency.

Limits are 100 sources, 100,000 text characters per source, 2,000,000 source characters total, a 64 KiB schema, a 2 MiB candidate/final result, 5,000 leaves, 10,000 citations, and 2,000 characters per quote. JSON input is bounded to depth 64 and 100,000 nodes; cycles, accessors, sparse arrays, nonfinite numbers, and non-JSON object types are rejected. The timeout defaults to 60 seconds and supports up to one hour. `signal` propagates to the extractor and waiting stops even when the callback ignores it; cancellation cannot undo or forcibly stop external work already started.

Errors use `ExtractionError.code`, including `INVALID_SCHEMA`, `SCHEMA_MISMATCH`, `INVALID_SOURCE`, `INVALID_CANDIDATE`, `INVALID_CITATION`, `INCOMPLETE_EVIDENCE`, `SUPPORT_REJECTED`, `TYPE_CONVERSION`, `MISSING_FIELD`, `TRUNCATED_FIELD`, `CANCELLED`, and `EXTRACTION_TIMEOUT`. Schema mismatch and missing-evidence errors include bounded pointer-level `issues`. Error messages omit raw field and source values.

The local tests cover strict schema enforcement, hostile or incomplete provenance, nested and multi-source results, source limits, cancellation, explicit acceptance policies, and real Chrome field collection across open shadow roots and form controls. They make no paid model calls and do not establish model extraction accuracy or comparative success rates.
