import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { BrowserEngine } from '../dist/browser.js';
import { startTaskService } from '../bench/comparison/fixture.mjs';

const ref = (snapshot, name) => {
  const entry = snapshot.elements.find(item => item.name === name);
  assert.ok(entry, `Missing ${name}`);
  return entry.ref;
};

test('network-receipt comparison task requires the authenticated response and one independently judged write', { timeout: 30_000 }, async t => {
  const service = await startTaskService();
  const attempt = await service.createAttempt('network-receipt', 23);
  const engine = new BrowserEngine({ captureNetwork: true, popupPolicy: 'follow-single', channel: process.env.TABLAZE_BROWSER_CHANNEL || undefined });
  t.after(async () => { await engine.dispose(); await service.close(); });
  const opened = await engine.open(attempt.url);
  const before = await attempt.judge();
  assert.equal(before.passed, false);
  const popupAction = await engine.act(opened.session_id, opened.snapshot_id, [{ type: 'click', ref: ref(opened, 'Connect account') }]);
  assert.equal(popupAction.ok, true, JSON.stringify(popupAction));
  assert.equal(popupAction.replan_required, true);
  const popup = popupAction.snapshot;
  assert.match(popup.url, /\/auth$/);
  const authorized = await engine.act(opened.session_id, popup.snapshot_id, [{ type: 'click', ref: ref(popup, 'Authorize account') }]);
  assert.equal(authorized.ok, true, JSON.stringify(authorized));
  const original = await engine.tabs(opened.session_id, { action: 'switch', tabId: opened.tab_id });
  assert.equal(original.ok, true);
  let receipt;
  for (let i = 0; i < 100; i++) {
    receipt = (await engine.network(opened.session_id)).records.find(item => item.url.endsWith('/network.json'));
    if (receipt) break;
    await delay(25);
  }
  assert.ok(receipt, 'The original app must fetch its authenticated JSON receipt');
  assert.equal(receipt.status, 200);
  const body = await engine.network(opened.session_id, { responseId: receipt.response_id });
  const reference = JSON.parse(body.response.body).reference;
  assert.match(reference, /^R-[A-F0-9]{10}$/);
  const ready = await engine.snapshot(opened.session_id);
  const submitted = await engine.act(opened.session_id, ready.snapshot_id, [
    { type: 'fill', ref: ref(ready, 'Receipt reference'), value: reference },
    { type: 'click', ref: ref(ready, 'Submit receipt') },
  ]);
  assert.equal(submitted.ok, true, JSON.stringify(submitted));
  const judged = await attempt.judge();
  assert.equal(judged.passed, true, JSON.stringify(judged));
  assert.equal(judged.evidence.writeCount, 1);
  assert.equal(judged.evidence.authorizations, 1);
  assert.equal(judged.evidence.receiptRequests, 1);
});
