import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadSecretConfig } from '../dist/secret-config.js';
import { compileSecretStore, SecretError } from '../dist/secret-store.js';

const ORIGIN = 'https://private-login.example';
const TOP = 'https://private-app.example';
const ENV = 'PRIVATE_LOGIN_CREDENTIAL';
const CANARY = 'private-value-never-in-errors';
const entry = overrides => ({ name: 'password', version: 'v1', allowedOrigins: [ORIGIN], env: ENV, ...overrides });
const config = overrides => ({ contextId: 'private-account-context', secrets: [entry()], ...overrides });
const signal = () => new AbortController().signal;
const secretError = code => error => {
  assert.ok(error instanceof SecretError);
  assert.equal(error.code, code);
  assert.equal(error.cause, undefined);
  assert.equal(JSON.stringify(error).includes(CANARY), false);
  assert.equal(error.message.includes(CANARY), false);
  return true;
};
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'tablaze-private-secret-config-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'private-configuration.json');
  return { directory, path, write: value => writeFile(path, JSON.stringify(value)) };
}

test('configuration does not read env values until an allowed-origin resolution and supports rotation', async t => {
  const f = await fixture(t); await f.write(config({ secrets: [entry({ allowedTopOrigins: [TOP] })] }));
  let reads = 0, current = CANARY;
  const env = Object.defineProperty({}, ENV, { get() { reads++; return current; } });
  const options = loadSecretConfig(f.path, env);
  const store = compileSecretStore(options); t.after(() => store.close());
  assert.equal(reads, 0);
  assert.deepEqual(store.aliases(ORIGIN, TOP), ['password']);
  await assert.rejects(store.resolve('password', ORIGIN, ORIGIN, signal()), secretError('SECRET_ORIGIN_BLOCKED'));
  assert.equal(reads, 0, 'An origin rejection must not access the environment');
  assert.equal(await store.resolve('password', ORIGIN, TOP, signal()), CANARY);
  current = 'rotated-private-value';
  assert.equal(await store.resolve('password', ORIGIN, TOP, signal()), current);
  assert.equal(reads, 2);
  assert.equal(store.redact(`${CANARY} ${current}`), '[redacted] [redacted]');
  const serialized = JSON.stringify(options);
  for (const value of [ENV, CANARY, current, f.path]) assert.equal(serialized.includes(value), false);
});

test('returned configuration and scopes are frozen, with only explicit artifact opt-in', async t => {
  const f = await fixture(t); await f.write(config({ secrets: [entry({ allowedTopOrigins: [TOP] })], allowSensitiveArtifacts: true }));
  const options = loadSecretConfig(f.path, {});
  for (const value of [options, options.secrets, options.secrets[0], options.secrets[0].allowedOrigins, options.secrets[0].allowedTopOrigins]) assert.equal(Object.isFrozen(value), true);
  assert.throws(() => { options.contextId = 'changed'; }, TypeError);
  assert.throws(() => options.secrets[0].allowedOrigins.push(TOP), TypeError);
  const store = compileSecretStore(options); t.after(() => store.close());
  assert.equal(store.allowSensitiveArtifacts, true);
  await f.write(config());
  assert.equal(loadSecretConfig(f.path, {}).allowSensitiveArtifacts, undefined);
});

test('resolvers reject missing, inherited, empty and oversized values without disclosing their source', async t => {
  const f = await fixture(t); await f.write(config());
  for (const env of [{}, Object.create({ [ENV]: CANARY }), { [ENV]: '' }, { [ENV]: 'x'.repeat(2049) }, { [ENV]: 42 }]) {
    const resolve = loadSecretConfig(f.path, env).secrets[0].resolve;
    assert.throws(() => resolve(signal()), secretError('SECRET_VALUE_INVALID'));
  }
  const boundary = 'x'.repeat(2048);
  assert.equal(loadSecretConfig(f.path, { [ENV]: boundary }).secrets[0].resolve(signal()), boundary);
  const env = Object.defineProperty({}, ENV, { get() { throw new Error(`${CANARY} ${ENV} ${f.path}`); } });
  assert.throws(() => loadSecretConfig(f.path, env).secrets[0].resolve(signal()), error => {
    secretError('SECRET_RESOLUTION_FAILED')(error);
    for (const value of [ENV, f.path]) assert.equal(error.message.includes(value), false);
    return true;
  });
});

test('aborted resolution does not read env and an abort during a getter cannot return the value', async t => {
  const f = await fixture(t); await f.write(config());
  let reads = 0;
  const controller = new AbortController();
  const options = loadSecretConfig(f.path, Object.defineProperty({}, ENV, { get() { reads++; controller.abort(CANARY); return CANARY; } }));
  assert.throws(() => options.secrets[0].resolve(controller.signal), secretError('SECRET_CANCELLED'));
  assert.equal(reads, 1);
  assert.throws(() => options.secrets[0].resolve(controller.signal), secretError('SECRET_CANCELLED'));
  assert.equal(reads, 1);
});

test('strict JSON shape and shared SDK metadata limits reject malformed private configurations', async t => {
  const f = await fixture(t);
  const invalid = [null, [], CANARY, {}, config({ unknown: CANARY }), config({ contextId: '' }), config({ contextId: 2 }), config({ secrets: {} }), config({ secrets: [null] }), config({ allowSensitiveArtifacts: null }), config({ allowSensitiveArtifacts: 'true' }), config({ secrets: [entry({ value: CANARY })] }), config({ secrets: [entry({ env: null })] }), config({ secrets: [entry({ env: '1INVALID' })] }), config({ secrets: [entry({ env: 'INVALID\n' })] }), config({ secrets: [entry({ env: 'x'.repeat(257) })] }), config({ secrets: [entry({ name: 'invalid-alias' })] }), config({ secrets: [entry({ version: '' })] }), config({ secrets: [entry(), entry()] }), config({ secrets: [entry({ allowedOrigins: [] })] }), config({ secrets: [entry({ allowedOrigins: [`https://${CANARY}@example.test`] })] }), config({ secrets: [entry({ allowedOrigins: ['https://*.example.test'] })] }), config({ secrets: [entry({ allowedOrigins: [ORIGIN + '/path'] })] }), config({ secrets: [entry({ allowedTopOrigins: null })] }), config({ secrets: Array.from({ length: 33 }, (_, index) => entry({ name: `secret${index}` })) }), config({ secrets: [entry({ allowedOrigins: Array(200).fill(ORIGIN), allowedTopOrigins: [TOP] })] })];
  for (const value of invalid) {
    await f.write(value);
    assert.throws(() => loadSecretConfig(f.path, {}), error => {
      secretError('SECRET_CONFIG_INVALID')(error);
      assert.equal(error.message, 'Invalid secret configuration.');
      assert.equal(error.message.includes(f.path), false);
      return true;
    });
  }
  await f.write(config({ secrets: [] }));
  assert.deepEqual(loadSecretConfig(f.path, {}).secrets, []);
});

test('reader enforces the actual 64 KiB boundary, UTF-8 and regular files with fixed errors', async t => {
  const f = await fixture(t), encoded = JSON.stringify(config());
  await writeFile(f.path, encoded + ' '.repeat(65536 - Buffer.byteLength(encoded)));
  assert.equal(loadSecretConfig(f.path, {}).secrets.length, 1);
  for (const bytes of [encoded + ' '.repeat(65537 - Buffer.byteLength(encoded)), `{"${CANARY}":`, Buffer.from([0x7b, 0xff, 0x7d])]) {
    await writeFile(f.path, bytes);
    assert.throws(() => loadSecretConfig(f.path, {}), secretError('SECRET_CONFIG_INVALID'));
  }
  for (const path of [f.directory, join(f.directory, CANARY)]) {
    assert.throws(() => loadSecretConfig(path, {}), error => secretError('SECRET_CONFIG_INVALID')(error) && !error.message.includes(path));
  }
});

test('reader refuses a FIFO without blocking on a writer', { skip: process.platform === 'win32', timeout: 3000 }, async t => {
  const f = await fixture(t); execFileSync('mkfifo', [f.path]);
  assert.throws(() => loadSecretConfig(f.path, {}), secretError('SECRET_CONFIG_INVALID'));
});
