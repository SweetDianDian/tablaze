# Typed custom tools / 类型化自定义工具

Applications can compose their own typed backend operations with Tablaze's browser tools using `defineTool` and `createToolRegistry`. The registry validates inputs and outputs, supplies trusted application context separately from model arguments, and refreshes site-specific tool availability before each planning decision. It is an SDK extension point; executable handlers and credentials are not loaded from a CLI checkpoint.

应用可以注册库存、订单、内部搜索等业务工具，与浏览器操作共同完成任务。工具的输入、输出使用 Zod 对象校验；租户、凭据和当前浏览器绑定由可信应用提供，不从模型参数或页面文字取得。

```ts
import { z } from 'zod';
import {
  defineTool, createToolRegistry, runAgent,
  type CustomToolExecutionContext,
} from 'tablaze';

type AppContext = {
  inventory: {
    reserve(input: {
      sku: string; quantity: number; idempotencyKey: string;
    }): Promise<{ receiptId: string; quantity: number }>;
  };
};

const reserveStock = defineTool({
  name: 'reserve_stock',
  version: '1',
  description: 'Reserve stock once and return a receipt. Verify the receipt before finishing.',
  effect: 'write',
  allowedOrigins: ['https://inventory.example'],
  input: z.object({ sku: z.string().min(1), quantity: z.number().int().positive() }),
  output: z.object({ receiptId: z.string(), quantity: z.number().int().positive() }),
  async handler(input, execution: CustomToolExecutionContext<AppContext>) {
    await execution.assertCurrent();
    return execution.context.inventory.reserve({
      ...input, idempotencyKey: execution.callId,
    });
  },
});

// connection is an existing connectAgentTools/createMcpToolClient connection.
// engine is the application's BrowserEngine; inventorySessionId was selected by the application.
const tools = createToolRegistry({
  base: connection.tools,
  tools: [reserveStock],
  getContext: async () => ({
    id: await application.currentPrincipalTenantAndPolicyId(),
    value: { inventory: application.inventoryClient() },
  }),
  browser: {
    engine,
    getSessionId: () => engine.list().some(item => item.session_id === inventorySessionId)
      ? inventorySessionId : undefined,
  },
});

const result = await runAgent({
  task: 'Reserve one CEDAR item and verify its receipt.',
  planner,
  tools,
  validateCompletion: application.checkReservationEvidence,
});
```

The application provides the connection, browser, backend client, planner and task-specific acceptance policy in this example. See the executable local fixture in `tests/custom-tool-workflows.test.mjs` for an actual HTTP backend, browser receipt and complete Agent loop. The registry does not dispose the caller's connection or browser; the application owns their cleanup.

## Contracts and execution

- `input` and `output` are Zod 3 object schemas. Their roots reject unexpected properties. The handler receives parsed input; a successful result must also be finite, bounded JSON object data. Zod validation is authoritative, including refinements that cannot be fully represented in JSON Schema. Async refinements are supported.
- `version` is required. Change it when handler behavior or another relevant contract changes. A schema digest cannot detect arbitrary changes to executable code, credentials or remote business logic.
- Custom names cannot duplicate another tool or use the reserved `tab_` / `agent_` prefixes. The complete base tool catalog is also checked for collisions and contract changes.
- The MCP success result is `{ ok: true, data: validatedOutput, session_id? }`; its advertised `outputSchema` describes that envelope. Local JSON Schema references are relocated with the nested output. Error results use fixed codes and omit raw exceptions, stacks and provider bodies.
- `effect: 'read' | 'write'` is trusted application metadata used by the executor. A planner cannot change this classification by changing its tool annotations. A handler declared as a read must actually avoid effects; trusted executable code is not sandboxed by the registry.
- `execution.context` is the value returned by the trusted resolver for that planning context. The registry does not add that value, its raw identifier, private catalog metadata or browser handles to model requests, results or checkpoints. A handler can deliberately return or log sensitive data, so this is a separation of channels rather than a general output redactor.
- The Agent's stable `callId` reaches the handler. An external service may use it for idempotency, but the registry does not automatically deduplicate, retry or roll back that service. Direct `registry.callTool()` calls generate a fresh ID; use the Agent or a catalog's explicit `dispatch` when the application needs a chosen stable ID.

输入无效、权限不匹配等发生在处理函数调用前，返回 `not_started`。写处理函数一旦开始，异常、无效输出或取消都可能对应已经发生的写入，返回 `unknown`；Agent 保留未决记录并要求可信调用方核对，不能自动重试。普通成功结果也不能替代 `tab_verify` 与应用的完成验收策略。

## Site and application identity

`allowedOrigins` uses exact HTTP(S) origins: scheme, hostname and port. Paths, credentials, query strings, fragments and wildcards are rejected. Omit it for an application tool without a site restriction. A restricted tool requires a browser binding and is absent from the model's catalog on other origins; dispatch checks the captured binding again even if the model retained an older tool name.

`browser.getSessionId` selects the intended session from trusted application state. It must return `undefined` when no intended session is open. Tablaze does not infer the selection from a model's `session_id` argument. A browser guard covers the active tab's main document, navigation generation, actual document handle, current location and tab-activation history. Reloads, route changes and switching away and back revoke it. It grants no authority over a cross-origin child frame. Ordinary DOM edits do not count as a document-identity change; existing reference checks and business verification still apply.

The Agent also compares an executor-only context key between planning catalogs. A context change cannot silently carry old verification evidence into a new document. Catalogs are closed after use; call-level cancellation or the end of a dispatch permanently revokes that call's `signal` and `assertCurrent`, including for a handler that resumes after an uncooperative wait.

`getContext` is called again during checks. Its stable `id` must cover the authenticated principal, tenant and applicable policy epoch. If that identity changes, the existing registry/run cannot silently switch accounts. Create a new run for the newly authorized context. The raw identifier is not stored, but its SHA-256 digest is not authentication and does not make a guessable identifier secret.

浏览器检查与外部服务提交不是原子事务。处理函数在等待之后、真正提交之前应再次调用 `assertCurrent()`，并使用已捕获的租户客户端或凭据。严格的一次性写入和并发版本条件仍须由业务服务落实。处理函数忽略取消或绕过检查时，库无法阻止任意外部代码产生副作用。

These origin restrictions apply to registered custom tools. They do not install a network firewall or restrict every request made by the browser's base MCP tools. General browser/domain/file policy controls remain separate work.

## Checkpoints and compatibility

Checkpoint version 3 records the full tool-contract digest and application-context digest for a bound registry. The contract covers both the base catalog and the complete custom tool set, including currently hidden tools, schemas, declared effects, versions and origin policy. Resume requires the same contract and application identity before planning or dispatch; a new browser session can be explicitly mapped after the application restores the correct account.

Unknown writes remain unresolved until trusted reconciliation. Reconciliation does not authorize a tenant change or contract mismatch. A saved `pendingTool.mutating` value is checked against the registry's full trusted effect metadata; editing the saved boolean cannot convert a write into a read.

Strictly valid version-1 and version-2 checkpoints migrate without inventing an application identity. Existing unbound clients keep their execution behavior. An unbound checkpoint cannot silently acquire a registry when resumed, and a bound checkpoint cannot be resumed through the plain CLI: the application must reconstruct its handlers and identity resolver through the SDK. The CLI rejects such a checkpoint before browser restoration.

## Verification scope

The new unit and local browser tests exercise schema enforcement, private context separation, catalog changes, cancellation, actual backend writes, receipt verification and same-origin tenant mismatch during recovery. They use scripted planners and owned HTTP/Chrome fixtures. They do not establish a live model success rate for arbitrary custom tools or an overall ranking against Browser Use. Existing Codex comparison reports retain the exact earlier source hashes they measured.
