import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compileSecretStore, SecretError } from '../dist/secret-store.js';

const ORIGIN = 'https://login.example:8443';
const TOP = 'https://app.example';
const controller = () => new AbortController();
const definition = overrides => ({ name: 'password', version: 'v1', allowedOrigins: [ORIGIN], resolve: () => 'default-canary', ...overrides });
const options = overrides => ({ contextId: 'tenant-a', secrets: [definition()], ...overrides });
const store = overrides => compileSecretStore(options(overrides));
const resolve = (value, signal = controller().signal) => value.resolve('password', ORIGIN, ORIGIN, signal);
const code = expected => error => error instanceof SecretError && error.code === expected && error.cause === undefined;
const invalid = value => assert.throws(() => compileSecretStore(value), code('SECRET_CONFIG_INVALID'));
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
async function bounded(operation) {
  let timer;
  try { return await Promise.race([operation, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Cancellation did not settle promptly')), 300); })]); }
  finally { clearTimeout(timer); }
}

test('undefined disables secrets; compiled facade is frozen, detached methods work, and values are private', async () => {
  assert.equal(compileSecretStore(), undefined);
  const value = store();
  assert.equal(Object.isFrozen(value), true);
  assert.match(value.hash, /^[a-f0-9]{64}$/);
  assert.equal(value.allowSensitiveArtifacts, false);
  const { aliases, resolve: get, redact, contains } = value;
  assert.deepEqual(aliases(ORIGIN, ORIGIN), ['password']);
  assert.equal(await get('password', ORIGIN, ORIGIN, controller().signal), 'default-canary');
  assert.equal(redact('default-canary'), '[redacted]');
  assert.equal(contains('default-canary'), true);
  assert.equal(JSON.stringify(value).includes('default-canary'), false);
  assert.throws(() => { value.hash = 'changed'; }, TypeError);
});

test('strict options reject unknown keys, accessors, prototypes and wrong optional types without invoking getters', () => {
  for (const value of [null, false, [], {}, options({ contextId: '' }), options({ contextId: ' x ' }), options({ contextId: 'x'.repeat(257) }), options({ contextId: 'x\n' }), options({ unknown: true }), options({ getContextId: 3 }), options({ getContextId: null }), options({ allowSensitiveArtifacts: null }), options({ allowSensitiveArtifacts: 'false' }), options({ secrets: null })]) invalid(value);
  const accessor = options(); let reads = 0;
  Object.defineProperty(accessor, 'getContextId', { get() { reads++; throw new Error('private-data'); } });
  invalid(accessor); assert.equal(reads, 0);
  invalid(Object.assign(Object.create({ inherited: true }), options()));
  invalid({ ...options(), [Symbol('private')]: true });
  invalid(new Proxy({}, { ownKeys() { throw new Error('private-data'); } }));
});

test('strict definitions reject invalid names, versions, duplicate aliases, unknown fields and inherited resolvers', () => {
  for (const entry of [null, definition({ name: '' }), definition({ name: '_private' }), definition({ name: 'password-ref' }), definition({ name: 'p'.repeat(65) }), definition({ version: '' }), definition({ version: 'v'.repeat(129) }), definition({ version: 'bad\0version' }), definition({ resolve: null }), definition({ value: 'plaintext' })]) invalid(options({ secrets: [entry] }));
  invalid(options({ secrets: [definition(), definition()] }));
  invalid(options({ secrets: [Object.assign(Object.create({ resolve: () => 'private' }), { name: 'password', version: 'v1', allowedOrigins: [ORIGIN] })] }));
  const getter = definition(); Object.defineProperty(getter, 'resolve', { get() { throw new Error('must not run'); } });
  invalid(options({ secrets: [getter] }));
});

test('arrays reject holes, extra properties and getters; alias and configured-origin limits are bounded', () => {
  invalid(options({ secrets: new Array(1) }));
  const extra = [definition()]; extra.extra = 'private'; invalid(options({ secrets: extra }));
  const accessor = [definition()]; Object.defineProperty(accessor, '0', { get() { throw new Error('private'); } }); invalid(options({ secrets: accessor }));
  invalid(options({ secrets: Array.from({ length: 33 }, (_, i) => definition({ name: `secret${i}` })) }));
  const origins = Array.from({ length: 200 }, (_, i) => `https://site${i}.example`);
  assert.ok(store({ secrets: [definition({ allowedOrigins: origins })] }));
  invalid(options({ secrets: [definition({ allowedOrigins: origins, allowedTopOrigins: [TOP] })] }));
  invalid(options({ secrets: [definition({ allowedOrigins: [...origins, ORIGIN] })] }));
  assert.deepEqual(store({ secrets: [] }).aliases(ORIGIN, ORIGIN), []);
});

test('origin lists require exact nonempty HTTP(S) origins; wildcard, credentials, path and opaque origins are rejected', () => {
  for (const origins of [[], undefined, null, [null], ['*.example'], ['https://*.example'], ['https://name:private@login.example'], ['https://login.example/path'], ['data:text/plain,private'], ['https://login.example?private'], [' https://login.example']]) invalid(options({ secrets: [definition({ allowedOrigins: origins })] }));
  invalid(options({ secrets: [definition({ allowedTopOrigins: [] })] }));
  invalid(options({ secrets: [definition({ allowedTopOrigins: ['https://*.example'] })] }));
});

test('frame and top origins are both required, including port and scheme; scope failure never invokes resolver', async () => {
  let calls = 0;
  const value = store({ secrets: [definition({ allowedTopOrigins: [TOP], resolve: () => { calls++; return 'private'; } })] });
  for (const [frame, top] of [[ORIGIN, ORIGIN], [TOP, TOP], ['https://login.example', TOP], ['http://login.example:8443', TOP], [ORIGIN, TOP + ':8443'], ['about:blank', TOP], ['https://name:private@login.example:8443', TOP]]) {
    assert.deepEqual(value.aliases(frame, top), []);
    await assert.rejects(value.resolve('password', frame, top, controller().signal), code('SECRET_ORIGIN_BLOCKED'));
  }
  assert.equal(calls, 0);
  assert.deepEqual(value.aliases(ORIGIN, TOP), ['password']);
  assert.equal(await value.resolve('password', ORIGIN, TOP, controller().signal), 'private');
  assert.equal(calls, 1);
  await assert.rejects(value.resolve('unknown', ORIGIN, TOP, controller().signal), code('SECRET_NOT_FOUND'));
});

test('hash normalizes ordering, duplicates and explicit default top scope; excludes callbacks and resolved values', async () => {
  const a = store({ secrets: [definition({ allowedOrigins: [TOP, ORIGIN, TOP] }), definition({ name: 'otp', resolve: () => 'first' })] });
  const b = store({ getContextId: () => 'tenant-a', secrets: [definition({ name: 'otp', allowedTopOrigins: [ORIGIN], resolve: () => 'different' }), definition({ allowedOrigins: [ORIGIN, TOP], allowedTopOrigins: [TOP, ORIGIN], resolve: () => 'second' })] });
  assert.equal(a.hash, b.hash);
  await resolve(a); await resolve(b); assert.equal(a.hash, b.hash);
  for (const change of [{ contextId: 'tenant-b' }, { allowSensitiveArtifacts: true }, { secrets: [definition({ version: 'v2' })] }, { secrets: [definition({ name: 'other' })] }, { secrets: [definition({ allowedOrigins: [TOP] })] }, { secrets: [definition({ allowedTopOrigins: [TOP] })] }]) assert.notEqual(store().hash, store(change).hash);
});

test('caller mutations cannot change cloned scopes, metadata or captured resolver', async () => {
  const entry = definition(); const input = options({ secrets: [entry] }); const value = compileSecretStore(input); const hash = value.hash;
  entry.allowedOrigins.push(TOP); entry.name = 'other'; entry.version = 'v2'; entry.resolve = () => 'changed'; input.contextId = 'tenant-b'; input.secrets.length = 0;
  assert.equal(value.hash, hash); assert.equal(value.contextId, 'tenant-a');
  assert.deepEqual(value.aliases(TOP, TOP), []);
  assert.deepEqual(value.aliases(ORIGIN, ORIGIN), ['password']);
  assert.equal(await resolve(value), 'default-canary');
});

test('context is checked before resolving and again before delivering; failed delivery still redacts the resolved value', async () => {
  let current = 'tenant-b'; let calls = 0;
  const value = store({ getContextId: () => current, secrets: [definition({ resolve: () => { calls++; current = 'tenant-b'; return 'flipped-canary'; } })] });
  await assert.rejects(resolve(value), code('SECRET_CONTEXT_CHANGED')); assert.equal(calls, 0);
  current = 'tenant-a';
  await assert.rejects(resolve(value), code('SECRET_CONTEXT_CHANGED')); assert.equal(calls, 1);
  assert.equal(value.redact('flipped-canary'), '[redacted]');
});

test('resolver and context exceptions are fixed and never expose raw thrown objects or messages', async () => {
  for (const thrown of [new Error('private-canary'), 'private-canary', { secret: 'private-canary' }, new SecretError('SECRET_NOT_FOUND')]) {
    for (const value of [store({ secrets: [definition({ resolve: () => { throw thrown; } })] }), store({ getContextId: () => { throw thrown; } })]) {
      await assert.rejects(resolve(value), error => code('SECRET_RESOLUTION_FAILED')(error) && !JSON.stringify(error).includes('private-canary') && !error.message.includes('private-canary'));
    }
  }
});

test('pre-aborted calls invoke neither context nor resolver and never expose the abort reason', async () => {
  let calls = 0; const abort = controller(); abort.abort(new Error('private-abort-reason'));
  const value = store({ getContextId: () => { calls++; return 'tenant-a'; }, secrets: [definition({ resolve: () => { calls++; return 'private'; } })] });
  await assert.rejects(resolve(value, abort.signal), error => code('SECRET_CANCELLED')(error) && !error.message.includes('private'));
  await assert.rejects(value.assertContext(abort.signal), code('SECRET_CANCELLED'));
  assert.equal(calls, 0);
});

test('cancellation bounds a hanging pre-context check and does not enter the resolver later', async () => {
  const started = deferred(), context = deferred(), abort = controller(); let calls = 0;
  const value = store({ getContextId: () => { started.resolve(); return context.promise; }, secrets: [definition({ resolve: () => { calls++; return 'private'; } })] });
  const result = resolve(value, abort.signal); await started.promise; abort.abort();
  await assert.rejects(bounded(result), code('SECRET_CANCELLED'));
  context.resolve('tenant-a'); await new Promise(setImmediate); assert.equal(calls, 0);
});

test('cancellation bounds resolver wait, passes an aborted signal, and registers its late value while store remains alive', async () => {
  const started = deferred(), result = deferred(), abort = controller(); let passedSignal;
  const value = store({ secrets: [definition({ resolve: signal => { passedSignal = signal; started.resolve(); return result.promise; } })] });
  const pending = resolve(value, abort.signal); await started.promise; abort.abort('private-reason');
  await assert.rejects(bounded(pending), code('SECRET_CANCELLED')); assert.equal(passedSignal.aborted, true);
  result.resolve('late-canary'); await new Promise(setImmediate);
  assert.equal(value.redact('late-canary'), '[redacted]');
  assert.equal(await resolve(store()), 'default-canary');
});

test('late resolver rejection after cancellation is observed without unhandled rejection', async () => {
  const started = deferred(), result = deferred(), abort = controller();
  const value = store({ secrets: [definition({ resolve: () => { started.resolve(); return result.promise; } })] });
  const pending = resolve(value, abort.signal); await started.promise; abort.abort();
  await assert.rejects(pending, code('SECRET_CANCELLED')); result.reject(new Error('private-late-error')); await new Promise(setImmediate);
});

test('cancellation bounds a hanging post-resolution context check while preserving redaction', async () => {
  const checking = deferred(), second = deferred(), abort = controller(); let checks = 0;
  const value = store({ getContextId: () => ++checks === 1 ? 'tenant-a' : (checking.resolve(), second.promise) });
  const pending = resolve(value, abort.signal); await checking.promise; abort.abort();
  await assert.rejects(bounded(pending), code('SECRET_CANCELLED'));
  assert.equal(value.contains('default-canary'), true); second.resolve('tenant-a'); await new Promise(setImmediate);
});

test('all rotated and cross-alias values remain redacted; duplicate values do not consume retention slots', async () => {
  let current = 'first-rotation'; const value = store({ secrets: [definition({ resolve: () => current }), definition({ name: 'secondary', resolve: () => 'second-alias' })] });
  await resolve(value); current = 'second-rotation'; await resolve(value);
  await value.resolve('secondary', ORIGIN, ORIGIN, controller().signal);
  for (let i = 0; i < 140; i++) await resolve(value);
  assert.equal(value.redact('first-rotation / second-rotation / second-alias'), '[redacted] / [redacted] / [redacted]');
});

test('resolved values must be nonempty bounded well-formed strings and errors contain no returned value', async () => {
  for (const output of ['', null, 42, {}, '\ud800', 'secret'.repeat(400)]) {
    await assert.rejects(resolve(store({ secrets: [definition({ resolve: () => output })] })), error => code('SECRET_VALUE_INVALID')(error) && !error.message.includes('secretsecret'));
  }
});

test('128 distinct-value limit fails before delivery without dropping earlier redactions', async () => {
  let count = 0; const value = store({ secrets: [definition({ resolve: () => `retained-${++count}-canary` })] });
  for (let i = 0; i < 128; i++) await resolve(value);
  await assert.rejects(resolve(value), code('SECRET_LIMIT_EXCEEDED'));
  assert.equal(value.redact('retained-1-canary retained-128-canary'), '[redacted] [redacted]');
});

test('64 KiB retention limit counts UTF-8 bytes and rejects overflow atomically', async () => {
  let count = 0; const value = store({ secrets: [definition({ resolve: () => String(count++).padStart(4, '0') + 'x'.repeat(2044) })] });
  for (let i = 0; i < 32; i++) await resolve(value);
  await assert.rejects(resolve(value), code('SECRET_LIMIT_EXCEEDED'));
  assert.equal(value.contains('0000' + 'x'.repeat(2044)), true);
  let unicode = 0; const wide = store({ secrets: [definition({ resolve: () => String(unicode++).padStart(4, '0') + '\u0800'.repeat(2044) })] });
  for (let i = 0; i < 10; i++) await resolve(wide);
  await assert.rejects(resolve(wide), code('SECRET_LIMIT_EXCEEDED'));
});

test('raw, whitespace-normalized, URI and JSON-escaped variants redact literally and contains follows the same set', async () => {
  const secret = 'key.*+[x]? /\t\n"☃"'; const normalized = secret.replace(/\s+/gu, ' ').trim();
  const value = store({ secrets: [definition({ resolve: () => secret })] }); await resolve(value);
  for (const source of [secret, normalized]) for (const variant of [source, encodeURIComponent(source), encodeURI(source), JSON.stringify(source).slice(1, -1)]) {
    assert.equal(value.contains(`before|${variant}|after`), true);
    assert.equal(value.redact(`before|${variant}|after`), 'before|[redacted]|after');
    assert.equal(value.contains(variant), true);
  }
  assert.equal(value.redact('unrelated'), 'unrelated'); assert.equal(value.contains('unrelated'), false);
});

test('overlapping secrets use longest simultaneous replacement and never reprocess the replacement marker', async () => {
  const value = store({ secrets: ['alpha', 'alphabet', 'redacted'].map((text, i) => definition({ name: `item${i}`, resolve: () => text })) });
  for (let i = 0; i < 3; i++) await value.resolve(`item${i}`, ORIGIN, ORIGIN, controller().signal);
  assert.equal(value.redact('alphabet alpha redacted'), '[redacted] [redacted] [redacted]');
});

test('crossing and chained matches cover every sensitive character in original coordinates', async () => {
  const values = ['abc', 'bcd', 'cde', '/', '2Fz', 'aa'];
  const value = store({ secrets: values.map((text, i) => definition({ name: `item${i}`, resolve: () => text })) });
  for (let i = 0; i < values.length; i++) await value.resolve(`item${i}`, ORIGIN, ORIGIN, controller().signal);
  assert.equal(value.redact('safe abcde tail'), 'safe [redacted] tail');
  assert.equal(value.redact('%2Fz'), '[redacted]', 'Encoded and literal variants can overlap too');
  assert.equal(value.redact('aaaaa'), '[redacted]', 'A secret can overlap its own later occurrences');
  assert.equal(value.redact('abcbcd'), '[redacted][redacted]', 'Adjacent independent matches retain ordinary replacement semantics');
  assert.equal(value.redactPrefix('safe abcde tail', 8), 'safe ');
  assert.equal(value.redactPrefix('safe abcde tail', 10), 'safe [redacted]');
  assert.equal(value.contains('abcde'), true);
  assert.equal(value.redact('safe abcde tail'), 'safe [redacted] tail', 'Matching state must reset between different operations');
});

test('public aliases equal to known values are hidden without changing configured resolution or unrelated names', async () => {
  let current = 'password';
  const value = store({ secrets: [definition({ resolve: () => current }), definition({ name: 'secondary' })] });
  assert.deepEqual(value.aliases(ORIGIN, ORIGIN), ['password', 'secondary']);
  assert.equal(await resolve(value), 'password');
  assert.deepEqual(value.aliases(ORIGIN, ORIGIN), ['secondary']);
  assert.equal(await resolve(value), 'password', 'Hiding an alias must not disable trusted resolution');
  current = 'secondary'; await resolve(value);
  assert.deepEqual(value.aliases(ORIGIN, ORIGIN), [], 'Another alias can equal a previously resolved value');
  const short = store({ secrets: [definition({ resolve: () => 'a' })] }); await resolve(short);
  assert.deepEqual(short.aliases(ORIGIN, ORIGIN), ['password'], 'Public configuration is not rewritten because it shares a letter with a short value');
});

test('a late cancelled value and a newer rotated value are both retained until close', async () => {
  const started = deferred(), late = deferred(), abort = controller(); let calls = 0;
  const value = store({ secrets: [definition({ resolve: () => ++calls === 1 ? (started.resolve(), late.promise) : 'rotated-value' })] });
  const pending = resolve(value, abort.signal); await started.promise; abort.abort();
  await assert.rejects(pending, code('SECRET_CANCELLED'));
  assert.equal(await resolve(value), 'rotated-value');
  late.resolve('password'); await new Promise(setImmediate);
  assert.equal(value.redact('password rotated-value'), '[redacted] [redacted]');
  assert.deepEqual(value.aliases(ORIGIN, ORIGIN), []);
  value.close();
  assert.throws(() => value.redactPrefix('password rotated-value', 8), code('SECRET_STORE_CLOSED'));
});

test('padding covers maximum URI and JSON forms; redaction before truncation does not reveal a secret prefix', async () => {
  const raw = '\u0800'.repeat(2048); const value = store({ secrets: [definition({ resolve: () => raw })] }); await resolve(value);
  const encoded = encodeURIComponent(raw); assert.equal(encoded.length, 18_432); assert.ok(value.padding >= encoded.length);
  const limit = 11, text = `prefix:${encoded}:suffix`;
  assert.equal(value.redact(text.slice(0, limit + value.padding)).slice(0, limit), value.redact(text).slice(0, limit));
  assert.equal(value.redact(text).includes('%E0'), false);
  const escaped = store({ secrets: [definition({ resolve: () => '\u0001'.repeat(2048) })] }); await resolve(escaped);
  assert.ok(escaped.padding >= JSON.stringify('\u0001'.repeat(2048)).slice(1, -1).length);
});

test('close revokes active resolution, aborts the resolver signal and prevents silent redaction bypass afterward', async () => {
  const started = deferred(), source = deferred(); let passedSignal;
  const value = store({ secrets: [definition({ resolve: signal => { passedSignal = signal; started.resolve(); return source.promise; } })] });
  const pending = resolve(value); await started.promise; value.close(); value.close();
  await assert.rejects(bounded(pending), code('SECRET_STORE_CLOSED')); assert.equal(passedSignal.aborted, true);
  source.resolve('late-after-close'); await new Promise(setImmediate);
  await assert.rejects(resolve(value), code('SECRET_STORE_CLOSED'));
  await assert.rejects(value.assertContext(controller().signal), code('SECRET_STORE_CLOSED'));
  for (const use of [() => value.aliases(ORIGIN, ORIGIN), () => value.redact('late-after-close'), () => value.redactPrefix('late-after-close', 10), () => value.contains('late-after-close')]) assert.throws(use, code('SECRET_STORE_CLOSED'));
});
