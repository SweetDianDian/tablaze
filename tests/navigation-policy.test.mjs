import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { compileNavigationPolicy, NavigationPolicyError } from '../dist/navigation-policy.js';

const invalid = value => assert.throws(() => compileNavigationPolicy(value), error => error instanceof NavigationPolicyError && error.code === 'NAVIGATION_POLICY_INVALID' && error.message === 'Invalid navigation policy configuration.' && error.cause === undefined);

test('undefined disables policy while configured empty policy permits only HTTP(S)', () => {
  assert.equal(compileNavigationPolicy(), undefined);
  const policy = compileNavigationPolicy({});
  assert.equal(policy.isAllowed('https://example.com/path?value=1#part'), true);
  assert.equal(policy.isAllowed('http://localhost:8123/'), true);
  for (const url of ['about:blank', 'data:text/html,hello', 'file:///private/tmp/file', 'javascript:alert(1)', 'blob:https://example.com/id', 'ftp://example.com/', '/relative', 'example.com', 'https:example.com', 'https:///example.com', 'https://', 'https://@example.com/', 'https://name:secret@example.com/']) {
    assert.equal(policy.isAllowed(url), false, url);
  }
});

test('explicit empty allowlist denies all targets and differs from an absent allowlist', () => {
  const empty = compileNavigationPolicy({ allowedOrigins: [] });
  const absent = compileNavigationPolicy({});
  assert.equal(empty.isAllowed('https://example.com'), false);
  assert.notEqual(empty.identity, absent.identity);
  assert.notEqual(empty.hash, absent.hash);
  assert.deepEqual(empty.policy, { allowedOrigins: [], blockedOrigins: [] });
});

test('exact origin matching preserves scheme, port and host boundaries with blocked precedence', () => {
  const policy = compileNavigationPolicy({ allowedOrigins: ['https://example.com', 'https://example.com:8443'], blockedOrigins: ['https://example.com:8443'] });
  assert.equal(policy.isAllowed('https://example.com/a?next=https://evil.test/#part'), true);
  assert.equal(policy.isAllowed('https://example.com:443'), true);
  for (const url of ['http://example.com/', 'https://example.com:8443/', 'https://example.com:444/', 'https://sub.example.com/', 'https://example.com.evil.test/', 'https://evil.test/example.com', 'https://example.com@evil.test/', 'https://example.com./']) {
    assert.equal(policy.isAllowed(url), false, url);
  }
  const blockOnly = compileNavigationPolicy({ blockedOrigins: ['https://example.com'] });
  assert.equal(blockOnly.isAllowed('https://example.com/path'), false);
  assert.equal(blockOnly.isAllowed('http://example.com/path'), true);
  assert.equal(blockOnly.isAllowed('https://different.example/'), true);
});

test('WHATWG normalization covers case, default ports, Unicode hostnames, IPv4 and IPv6', () => {
  const policy = compileNavigationPolicy({ allowedOrigins: ['HTTPS://BÜCHER.example:443/', 'http://127.000.000.001:80', 'http://[0:0:0:0:0:0:0:1]:8080/'] });
  assert.deepEqual(policy.policy.allowedOrigins, ['http://127.0.0.1', 'http://[::1]:8080', 'https://xn--bcher-kva.example']);
  for (const url of ['https://bücher.example/a', 'https://xn--bcher-kva.example:443/b', 'http://127.0.0.1/', 'http://[::1]:8080/a']) assert.equal(policy.isAllowed(url), true, url);
  assert.equal(policy.isAllowed('https://xn--bcher-kva.example:444/'), false);
  assert.equal(policy.isAllowed('http://[::1]/'), false);
});

test('canonical identity is versioned, stable across equivalent ordering and does not collapse deny-all', () => {
  const a = compileNavigationPolicy({ allowedOrigins: ['https://b.example', 'https://A.example:443/', 'https://a.example'], blockedOrigins: ['http://blocked.example:80', 'http://blocked.example/'] });
  const b = compileNavigationPolicy({ blockedOrigins: ['http://blocked.example'], allowedOrigins: ['https://a.example/', 'https://b.example/'] });
  assert.equal(a.identity, b.identity);
  assert.equal(a.hash, b.hash);
  assert.deepEqual(JSON.parse(a.identity), { version: 1, allowedOrigins: ['https://a.example', 'https://b.example'], blockedOrigins: ['http://blocked.example'] });
  assert.equal(a.hash, createHash('sha256').update(a.identity).digest('hex'));
  assert.match(a.hash, /^[a-f0-9]{64}$/);
  assert.equal(compileNavigationPolicy({}).hash, compileNavigationPolicy({ blockedOrigins: [] }).hash);
  assert.notEqual(a.hash, compileNavigationPolicy({ allowedOrigins: ['https://a.example'], blockedOrigins: ['http://blocked.example'] }).hash);
});

test('compiled policy and copied arrays cannot be mutated and detached methods retain their policy', () => {
  const allowedOrigins = ['https://allowed.example'];
  const blockedOrigins = ['https://blocked.example'];
  const input = { allowedOrigins, blockedOrigins };
  const policy = compileNavigationPolicy(input);
  const originalHash = policy.hash;
  allowedOrigins.push('https://unexpected.example');
  blockedOrigins.length = 0;
  input.allowedOrigins = [];
  const { isAllowed, assertAllowed } = policy;
  assert.equal(isAllowed('https://allowed.example/a'), true);
  assert.equal(isAllowed('https://unexpected.example/'), false);
  assert.equal(isAllowed('https://blocked.example/'), false);
  assert.doesNotThrow(() => assertAllowed('https://allowed.example'));
  for (const value of [policy, policy.policy, policy.policy.allowedOrigins, policy.policy.blockedOrigins]) assert.equal(Object.isFrozen(value), true);
  assert.throws(() => policy.policy.allowedOrigins.push('https://unexpected.example'), TypeError);
  assert.throws(() => { policy.policy.allowedOrigins = []; }, TypeError);
  assert.throws(() => { policy.isAllowed = () => true; }, TypeError);
  assert.equal(policy.hash, originalHash);
});

test('only origins are accepted as rules; URL parser repairs and wildcard guesses are rejected', () => {
  for (const origin of [
    'example.com', '//example.com', 'https:example.com', 'https:/example.com', 'https:///example.com',
    'https://example.com/path', 'https://example.com/.', 'https://example.com/..', 'https://example.com//', 'https://example.com/%2e',
    'https://example.com?', 'https://example.com?token=private', 'https://example.com#', 'https://example.com/#fragment',
    'https://name:password@example.com', 'https://@example.com', 'https://*.example.com', 'https://%2A.example.com', '*',
    'file:///tmp', 'data:text/html,hi', 'null', 'blob:https://example.com/id', 'ftp://example.com',
    ' https://example.com', 'https://example.com ', 'https://exam\tple.com', 'https://example.com\n', 'https://example.com\u0000',
    'https://example.com\\', 'https://example.com\\@other.test', 'https://example.com:65536', 'https://[::1', '',
  ]) {
    invalid({ allowedOrigins: [origin] });
    invalid({ blockedOrigins: [origin] });
  }
});

test('strict bounded configuration rejects unknown fields, wrong types, sparse arrays and accessors', () => {
  for (const input of [null, false, 1, 'https://example.com', [], { allowedOrigin: [] }, { extra: true }, { allowedOrigins: null }, { blockedOrigins: 'https://example.com' }, { allowedOrigins: [1] }, { allowedOrigins: [undefined] }, { blockedOrigins: [{}] }, { allowedOrigins: Array(1) }, new Date(), { [Symbol('extra')]: true }]) invalid(input);
  invalid(Object.create({ allowedOrigins: ['https://example.com'] }));
  let reads = 0;
  invalid({ get allowedOrigins() { reads++; return []; } });
  const array = [];
  Object.defineProperty(array, '0', { get() { reads++; return 'https://example.com'; } });
  invalid({ allowedOrigins: array });
  assert.equal(reads, 0);
  assert.equal(compileNavigationPolicy(Object.assign(Object.create(null), { allowedOrigins: [] })).isAllowed('https://example.com'), false);
});

test('combined allow/block input is limited to 200 entries before normalization or deduplication', () => {
  const origin = 'https://example.com';
  assert.deepEqual(compileNavigationPolicy({ allowedOrigins: Array(100).fill(origin), blockedOrigins: Array(100).fill(origin) }).policy, { allowedOrigins: [origin], blockedOrigins: [origin] });
  invalid({ allowedOrigins: Array(201).fill(origin) });
  invalid({ blockedOrigins: Array(201).fill(origin) });
  invalid({ allowedOrigins: Array(100).fill(origin), blockedOrigins: Array(101).fill(origin) });
});

test('invalid configuration, malformed navigation and denied URLs never surface private input', () => {
  const secret = 'private-password-do-not-surface';
  for (const input of [{ allowedOrigins: [`https://user:${secret}@example.com`] }, { blockedOrigins: [`https://${secret}.example:invalid`] }, new Proxy({}, { ownKeys() { throw Error(secret); } })]) {
    let caught;
    try { compileNavigationPolicy(input); } catch (error) { caught = error; }
    assert.ok(caught instanceof NavigationPolicyError);
    assert.equal(caught.code, 'NAVIGATION_POLICY_INVALID');
    assert.equal(`${caught.stack} ${JSON.stringify(caught)}`.includes(secret), false);
  }
  const policy = compileNavigationPolicy({ allowedOrigins: ['https://allowed.example'] });
  for (const url of [`https://denied.example/?token=${secret}`, `https://user:${secret}@allowed.example`, `https://${secret}.example:invalid`, undefined, { toString() { throw Error(secret); } }]) {
    assert.equal(policy.isAllowed(url), false);
    assert.throws(() => policy.assertAllowed(url), error => error instanceof NavigationPolicyError && error.code === 'NAVIGATION_BLOCKED' && error.message === 'Navigation is blocked by the configured policy.' && !`${error.stack} ${JSON.stringify(error)}`.includes(secret) && error.cause === undefined);
  }
});
