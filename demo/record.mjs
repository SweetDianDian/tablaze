import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdir, readFile, readdir, writeFile, rm, copyFile, rename } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { startDemoFixture } from './fixture.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const output = resolve(root, process.env.TABLAZE_DEMO_OUTPUT || 'demo/output');
const channel = process.env.TABLAZE_BROWSER_CHANNEL || undefined;
const quick = process.env.TABLAZE_DEMO_QUICK === '1';
const ffmpeg = process.env.TABLAZE_DEMO_FFMPEG;
await mkdir(output, { recursive: true });
const recording = join(output, 'recording');
await mkdir(recording, { recursive: true });
const sha256 = data => createHash('sha256').update(data).digest('hex');
const sourceFiles = ['package.json', 'package-lock.json', 'demo/record.mjs', 'demo/viewer.html', 'demo/fixture.mjs',
  ...(await readdir(join(root, 'src'))).filter(name => name.endsWith('.ts')).map(name => 'src/' + name),
  ...(await readdir(join(root, 'dist'))).filter(name => name.endsWith('.js')).map(name => 'dist/' + name)].sort();
const sourceHashes = Object.fromEntries(await Promise.all(sourceFiles.map(async name => [name, sha256(await readFile(join(root, name)))])));
const report = {
  schema_version: 2, started_at: new Date().toISOString(), status: 'running', source_sha256: sourceHashes,
  environment: { node: process.version, platform: process.platform, arch: process.arch, browser_channel: channel || 'managed-chromium' },
  method: {
    client: 'Real MCP TypeScript SDK client over stdio. Deterministic script; no Codex/model inference.',
    display: 'Normal-speed recording of a presentation rendering actual MCP responses and tab_capture images. Not a continuous video feed from the controlled tab.',
    fixture: 'One continuous localhost travel workflow, with a real form, DOM replacement, approval popup, server-side order and CSV download. No external booking or payment.',
    pauses: 'Explicit reading holds are excluded from tool elapsed_ms. No timeline acceleration.',
    independent_checks: 'Fixture server counters and locally read downloaded bytes supplement browser assertions. They are recorder checks, not additional MCP tools.',
    quick_mode: quick,
  },
  task: { destination: 'Lisbon', nights: 3, travelers: 2, free_cancellation: true, budget_eur: 900, requester: 'Lin Chen', cost_center: 'design' },
  events: [], chapters: [], presentation_holds: [], checks: {},
};
const started = performance.now();
let videoStarted, fixture, server, browser, context, viewer, client, video;
const stdout = message => process.stdout.write(message + '\n');
const elapsed = () => Number((performance.now() - started).toFixed(3));
const videoTime = () => Number(((performance.now() - videoStarted) / 1000).toFixed(3));
const present = state => viewer.evaluate(state => window.present(state), state);
async function chapter(id, titleZh, titleEn, state = {}) {
  report.chapters.push({ id, start_seconds: id === 'overview' ? 0 : videoTime(), title_zh: titleZh, title_en: titleEn });
  await present({ stage: id, chapter: `${String(report.chapters.length).padStart(2, '0')} / ${id.toUpperCase()}`, title: titleZh, subtitle: titleEn, ...state });
  stdout('Chapter ' + id);
}
async function hold(seconds) {
  const ms = quick ? 100 : seconds * 1000;
  report.presentation_holds.push({ at_ms: elapsed(), duration_ms: ms });
  await present({ hold: quick ? '快速校验 · 非发布录像' : `讲解停留 ${seconds}s · 工具耗时单独记录` });
  await delay(ms);
  await present({ hold: '正常速度录制 · 无剪辑加速' });
}
async function call(name, args) {
  await present({ state: '执行中', detail: name });
  const begin = performance.now();
  const response = await client.callTool({ name, arguments: args });
  const data = response.structuredContent;
  assert.ok(data, 'Expected structured result from ' + name);
  const event = { at_ms: elapsed(), name, arguments: args, result: data, is_error: response.isError === true, elapsed_ms: Number((performance.now() - begin).toFixed(3)) };
  report.events.push(event);
  await present({ events: report.events, state: event.is_error ? '已停止 · 需重新观察' : '已完成' });
  return { data, response, event };
}
function independent(name, result) {
  report.events.push({ at_ms: elapsed(), name, result, is_error: false, elapsed_ms: 0, not_mcp: true });
}
async function capture(sessionId, filename) {
  const { response, event } = await call('tab_capture', { session_id: sessionId });
  const block = response.content.find(item => item.type === 'image');
  assert.ok(block, 'A real screenshot must accompany capture');
  await writeFile(join(output, filename), Buffer.from(block.data, 'base64'));
  event.image_file = filename;
  await present({ image: 'data:' + block.mimeType + ';base64,' + block.data, capture: 'tab_capture · 真实截图', location: 'WAYFAR / ' + new URL(event.result.url).pathname });
}
const ref = (snapshot, name) => {
  const item = snapshot.elements.find(element => element.name === name);
  assert.ok(item, 'Missing observed control ' + name + '; found ' + snapshot.elements.map(e => e.name).join(', '));
  return item.ref;
};
const caption = (zh, en) => ({ zh, en });
const proof = (label, value, detail) => ({ label, value: String(value), ...(detail ? { detail } : {}) });
try {
  fixture = await startDemoFixture();
  const html = await readFile(join(root, 'demo/viewer.html'));
  server = http.createServer(async (request, response) => {
    if (request.url === '/video.webm') { response.writeHead(200, { 'content-type': 'video/webm' }).end(await readFile(join(output, 'tablaze-demo.webm'))); return; }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(html);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  browser = await chromium.launch({ headless: true, channel });
  report.environment.browser_version = browser.version();
  // Establish the SDK connection before video recording to avoid a blank setup segment.
  client = new Client({ name: 'tablaze-demo-recorder', version: '0.2.0' });
  const transport = new StdioClientTransport({ command: process.execPath, args: ['dist/cli.js', '--popup-policy', 'follow-single', ...(channel ? ['--channel', channel] : [])], cwd: root, stderr: 'pipe' });
  let stderr = ''; transport.stderr?.on('data', chunk => { stderr += chunk; });
  await client.connect(transport);
  const listed = await client.listTools();
  const expectedTools = ['tab_act', 'tab_capture', 'tab_close', 'tab_dialog', 'tab_downloads', 'tab_extract', 'tab_extract_structured', 'tab_list', 'tab_navigate', 'tab_open', 'tab_pdf', 'tab_snapshot', 'tab_state', 'tab_tabs', 'tab_verify'];
  assert.deepEqual(listed.tools.map(tool => tool.name).sort(), expectedTools);
  report.checks.handshake = { server: client.getServerVersion(), tools: listed.tools.map(tool => tool.name) };
  context = await browser.newContext({ viewport: { width: 1440, height: 900 }, recordVideo: { dir: recording, size: { width: 1440, height: 900 } } });
  videoStarted = performance.now();
  viewer = await context.newPage(); video = viewer.video();
  await viewer.goto('http://127.0.0.1:' + server.address().port);
  await chapter('overview', '从一句任务，到一份可交付的行程。', 'One task. An approved trip. A verified file.', {
    task: '里斯本 · 3 晚 · 2 人 · 预算 €900 · 免费取消',
    detail: '筛选酒店 → 验证结果 → 审批 → 下载文件',
    proof: [proof('真实连接', listed.tools.length + ' 个工具', 'MCP SDK · stdio'), proof('演示任务', '1 条完整流程', '本地差旅审批')],
    caption: caption('看 Tablaze 如何完成一整项工作，也看它在页面变化时如何停止并恢复。', 'Follow a complete task, including a deliberate page change and recovery.'),
  });
  const opened = (await call('tab_open', { url: fixture.url + '/' })).data;
  assert.equal(opened.ok, true); const sessionId = opened.session_id;
  await capture(sessionId, '01-plan.jpg');
  await present({ state: '已读取页面', detail: 'tab_open 返回真实元素引用，后续操作只使用这些引用。' });
  await hold(10);

  await chapter('batch', '六个步骤，一次有序提交。', 'Six actions in one ordered request.', {
    detail: '填写城市 → 选择晚数 → 选择人数 → 设置预算 → 勾选取消政策 → 搜索',
    proof: [proof('待执行批次', '6 个动作', '来自同一份已观察快照'), proof('任务要求', '€900 / 3 晚 / 2 人')],
    caption: caption('把连续的表单操作放进一个请求。每一步按顺序执行，遇到失败就停止。', 'A single request carries the ordered actions. The batch stops on its first failure.'),
  });
  await hold(6);
  const actions = [
    { type: 'fill', ref: ref(opened, '目的地'), value: 'Lisbon' },
    { type: 'select', ref: ref(opened, '住宿晚数'), values: ['3'] },
    { type: 'select', ref: ref(opened, '出行人数'), values: ['2'] },
    { type: 'fill', ref: ref(opened, '预算上限（EUR）'), value: '900' },
    { type: 'check', ref: ref(opened, '免费取消'), checked: true },
    { type: 'click', ref: ref(opened, '查找酒店') },
  ];
  const batch = await call('tab_act', { session_id: sessionId, snapshot_id: opened.snapshot_id, actions });
  assert.equal(batch.data.ok, true, JSON.stringify(batch.data)); assert.equal(batch.data.completed, 6);
  assert.deepEqual(fixture.state().filters, { destination: 'Lisbon', nights: '3', travelers: '2', budget: '900', flexible: 'yes' });
  assert.equal(fixture.state().searches, 1);
  report.checks.batch = { completed: 6, requested: 6, tool_elapsed_ms: batch.event.elapsed_ms, server_filters: fixture.state().filters, search_requests: 1 };
  await capture(sessionId, '02-results.jpg');
  await present({ title: '六步已完成，筛选条件全部落地。', detail: 'tab_act → completed: 6 / 6',
    proof: [proof('本批次完成', '6 / 6', '1 次 tab_act 请求'), proof('实际工具耗时', (batch.event.elapsed_ms / 1000).toFixed(2) + ' 秒', '不含画面讲解停留')],
    caption: caption('结果页已应用城市、晚数、人数、预算与取消政策；服务器也确认只收到一次搜索。', 'The result reflects all filters; the fixture server independently counted one search.'),
  });
  await hold(12);

  await chapter('verify', '点完之后，再验收五项结果。', 'Verify the outcome beyond a successful click.', {
    detail: 'URL · 页面标题 · 可见文字 · 字段值 · 酒店数量',
    proof: [proof('验收方法', '5 项独立断言'), proof('目标酒店', 'Casa Flora', '总价 €780 · 预算内')],
    caption: caption('操作返回成功之后，再从结果页检查任务条件。点击成功只是过程的一部分。', 'URL, title, text, field value and result count are checked separately.'),
  });
  const verified = (await call('tab_verify', { session_id: sessionId, checks: [
    { kind: 'url', value: fixture.url + '/results?destination=Lisbon&nights=3&travelers=2&budget=900&flexible=yes' },
    { kind: 'title', contains: '酒店筛选结果' },
    { kind: 'text', contains: '3 晚 · 2 人 · 免费取消 · 预算 € 900' },
    { kind: 'value', selector: '#destination', value: 'Lisbon' },
    { kind: 'count', selector: '[data-hotel="casa-flora"]', value: 1 },
  ] })).data;
  assert.equal(verified.passed, true, JSON.stringify(verified));
  report.checks.result_verification = verified;
  await present({ state: '5 项通过', detail: '✓ 正确 URL\n✓ 正确标题\n✓ 条件可见\n✓ 城市字段\n✓ 唯一匹配酒店',
    proof: [proof('验收结果', '5 / 5 通过'), proof('页面匹配', '1 家酒店', 'Casa Flora · Lisbon')],
  });
  await hold(14);

  const beforeChange = (await call('tab_snapshot', { session_id: sessionId })).data;
  await chapter('guard', '页面更新了，旧引用先停下来。', 'A changed target stops the next action.', {
    detail: '本地页面将替换“发起审批”按钮，外观相同，DOM 节点不同。',
    proof: [proof('即将制造的变化', '按钮被替换'), proof('已观察引用', ref(beforeChange, '发起审批'))],
    caption: caption('现在让真实页面换掉刚才观察到的按钮，检查 Tablaze 会怎样处理过期引用。', 'The fixture replaces the observed approval button with an identical-looking node.'),
  });
  await hold(7);
  await fixture.replaceApproval(); independent('fixture.replace_approval', { acknowledged: true, replacements: fixture.state().replacements });
  const stopped = (await call('tab_act', { session_id: sessionId, snapshot_id: beforeChange.snapshot_id, actions: [{ type: 'click', ref: ref(beforeChange, '发起审批') }] })).data;
  assert.equal(stopped.ok, false); assert.equal(stopped.completed, 0); assert.equal(stopped.failed.error.code, 'STALE_REFERENCE');
  const guardState = fixture.state(); assert.equal(guardState.popup_visits, 0); assert.equal(guardState.submission_attempts, 0); assert.equal(guardState.orders.length, 0);
  report.checks.changed_target = { refused_code: stopped.failed.error.code, completed: stopped.completed, popup_visits: guardState.popup_visits, submission_attempts: guardState.submission_attempts, orders: guardState.orders.length };
  independent('fixture.confirm_zero_writes', report.checks.changed_target);
  await capture(sessionId, '03-stopped.jpg');
  await present({ state: '旧引用已拒绝', title: '发现引用过期，没有继续点击。', detail: 'STALE_REFERENCE\ncompleted: 0\n重新观察后再继续',
    proof: [proof('旧引用操作', '0 个完成'), proof('独立服务器计数', '0 次审批提交', '0 个弹窗 · 0 个订单')],
    caption: caption('这次旧引用返回 STALE_REFERENCE。独立服务器计数确认：没有打开审批，也没有写入订单。', 'The stale call completed zero actions; independent server counters confirm no approval or order.'),
  });
  await hold(13);
  const fresh = (await call('tab_snapshot', { session_id: sessionId })).data;
  assert.notEqual(fresh.snapshot_id, beforeChange.snapshot_id);
  await present({ title: '重新观察，拿到新引用再继续。', state: '新快照已就绪', detail: 'tab_snapshot → 新 snapshot_id + 新元素引用',
    proof: [proof('恢复方式', '重新观察页面'), proof('下一步', '打开审批弹窗', '使用当前快照的按钮引用')],
    caption: caption('恢复步骤显式读取新快照，后续请求使用当前页面的新引用。', 'Recovery explicitly reads a fresh snapshot before sending the next action.'),
  });
  await hold(8);

  await chapter('popup', '跟随审批弹窗，把流程接下去。', 'Continue the workflow in its owned approval tab.', {
    detail: 'popup-policy: follow-single\n本次点击窗口内出现一个弹窗，返回其新快照。',
    proof: [proof('弹窗策略', 'follow-single'), proof('下一批动作', '4 步审批')],
    caption: caption('在显式启用的 follow-single 策略下，跟随这个审批弹窗，再使用弹窗自己的引用。', 'The explicitly enabled follow-single policy selects this approval popup and returns its observation.'),
  });
  const popup = (await call('tab_act', { session_id: sessionId, snapshot_id: fresh.snapshot_id, actions: [{ type: 'click', ref: ref(fresh, '发起审批') }] })).data;
  assert.equal(popup.ok, true, JSON.stringify(popup)); assert.equal(popup.replan_required, true);
  assert.ok(popup.popup_followed); assert.notEqual(popup.snapshot.tab_id, opened.tab_id); assert.equal(popup.snapshot.tabs.length, 2);
  assert.equal(fixture.state().popup_visits, 1);
  // The follow policy observes immediately; a local popup can still finish navigation just afterward.
  const approval = (await call('tab_snapshot', { session_id: sessionId })).data;
  assert.match(approval.title, /差旅审批/);
  await capture(sessionId, '04-popup.jpg');
  await present({ state: '审批标签页已接管', detail: '原筛选页保留 · 审批页成为当前标签页', proof: [proof('同一会话内', '2 个标签页'), proof('审批弹窗', '1 次打开', '当前 tab_id 已切换')] });
  await hold(10);
  const approved = await call('tab_act', { session_id: sessionId, snapshot_id: approval.snapshot_id, actions: [
    { type: 'fill', ref: ref(approval, '申请人'), value: 'Lin Chen' },
    { type: 'select', ref: ref(approval, '成本中心'), values: ['design'] },
    { type: 'check', ref: ref(approval, '我已确认行程与预算'), checked: true },
    { type: 'click', ref: ref(approval, '批准行程') },
  ] });
  assert.equal(approved.data.ok, true, JSON.stringify(approved.data)); assert.equal(approved.data.completed, 4);
  const receipt = (await call('tab_verify', { session_id: sessionId, checks: [{ kind: 'title', contains: '审批完成' }, { kind: 'text', contains: 'WF-001' }, { kind: 'text', contains: 'EUR 780' }] })).data;
  assert.equal(receipt.passed, true);
  assert.equal(fixture.state().submission_attempts, 1); assert.equal(fixture.state().orders.length, 1);
  report.checks.approval = { popup_followed: popup.popup_followed, owned_tabs: popup.snapshot.tabs.length, completed: approved.data.completed, tool_elapsed_ms: approved.event.elapsed_ms, server: fixture.state(), verification: receipt };
  independent('fixture.confirm_order', { submission_attempts: 1, orders: fixture.state().orders });
  await capture(sessionId, '05-approved.jpg');
  await present({ state: '审批完成', title: '四步审批，生成一份真实回执。', detail: '服务器已记录 WF-001\n申请人 Lin Chen · 设计团队 · EUR 780',
    proof: [proof('审批批次', '4 / 4 完成'), proof('独立服务器记录', '1 次提交 / 1 个订单')],
    caption: caption('回执页面通过三项检查；服务器也确认这次运行实际生成一个审批订单。', 'Three receipt checks pass; the server independently confirms one submission and one order.'),
  });
  await hold(13);

  await chapter('download', '拿到文件，还要核对文件内容。', 'Deliver the file and verify its actual bytes.', {
    detail: '下载行程 CSV → 等待文件完成 → 读取内容 → 核对 SHA-256',
    proof: [proof('交付物', '行程 CSV'), proof('验证方式', '真实字节比对')],
    caption: caption('点击下载之后，读取 Tablaze 保存的真实文件，确认内容和预期完全一致。', 'After the download completes, the recorder reads the saved file and compares its bytes.'),
  });
  const downloadSnapshot = (await call('tab_snapshot', { session_id: sessionId })).data;
  const clicked = (await call('tab_act', { session_id: sessionId, snapshot_id: downloadSnapshot.snapshot_id, actions: [{ type: 'click', ref: ref(downloadSnapshot, '下载行程 CSV') }] })).data;
  assert.equal(clicked.ok, true);
  const listedDownloads = (await call('tab_downloads', { session_id: sessionId })).data;
  assert.equal(listedDownloads.downloads.length, 1);
  const downloaded = (await call('tab_downloads', { session_id: sessionId, download_id: listedDownloads.downloads[0].id, timeout_ms: 5000 })).data.downloads[0];
  assert.equal(downloaded.status, 'completed'); assert.equal(downloaded.filename, 'wayfar-itinerary.csv');
  const bytes = await readFile(downloaded.path);
  const expectedCsv = 'approval_id,requester,cost_center,hotel,city,nights,travelers,amount_eur,free_cancellation\nWF-001,Lin Chen,design,Casa Flora,Lisbon,3,2,780,true\n';
  assert.equal(bytes.toString('utf8'), expectedCsv); assert.equal(fixture.state().downloads, 1);
  await copyFile(downloaded.path, join(output, 'wayfar-itinerary.csv'));
  report.checks.download = { filename: downloaded.filename, status: downloaded.status, bytes: bytes.length, sha256: sha256(bytes), expected_sha256: sha256(Buffer.from(expectedCsv)), contents_match: true, server_download_requests: 1, retained_file: 'wayfar-itinerary.csv' };
  independent('artifact.verify_bytes', report.checks.download);
  await present({ state: '文件已核对', title: '交付已完成，文件内容也匹配。', detail: 'wayfar-itinerary.csv\n' + bytes.toString('utf8').split('\n')[1],
    proof: [proof('实际下载文件', bytes.length + ' bytes', 'CSV 内容与预期一致'), proof('SHA-256 匹配', sha256(bytes).slice(0, 14) + '…', '完整哈希保留在报告中')],
  });
  await hold(16);

  const tabsBeforeClose = (await call('tab_tabs', { session_id: sessionId, action: 'list' })).data;
  assert.equal(tabsBeforeClose.tabs.length, 2);
  const closed = (await call('tab_close', { session_id: sessionId })).data; assert.equal(closed.ok, true);
  const final = (await call('tab_list', {})).data; assert.deepEqual(final.sessions, []); assert.equal(stderr, '');
  report.checks.cleanup = { closed_owned_tabs: 2, remaining_sessions: 0, stderr_empty: true };
  report.summary = { mcp_calls: report.events.filter(e => !e.not_mcp).length, successful_actions: 12, rejected_actions: 1, tool_elapsed_ms: Number(report.events.filter(e => !e.not_mcp).reduce((sum, e) => sum + e.elapsed_ms, 0).toFixed(3)), browser_assertions_passed: verified.checks.length + receipt.checks.length, server_orders: fixture.state().orders.length, downloaded_files: 1, remaining_sessions: 0 };
  await chapter('recap', '做完工作，留下可核查的结果。', 'The task is complete. The evidence stays with it.', {
    state: '全部验收通过', detail: '批量执行 · 结果验证 · 停止与恢复 · 弹窗审批 · 文件交付',
    proof: [proof('本次业务结果', '1 份审批 + 1 个文件'), proof('浏览器验收', report.summary.browser_assertions_passed + ' 项通过', '工具合计 ' + (report.summary.tool_elapsed_ms / 1000).toFixed(2) + ' 秒；不含讲解'), proof('会话清理', '0 个遗留', '2 个所属标签页已关闭')],
    caption: caption('本次演示完整保留请求、结果、截图与文件证据。网站可按章节回看，并下载完整记录。', 'The recording includes requests, results, screenshots and file evidence, with chapter navigation on the website.'),
  });
  await hold(12);
  await viewer.screenshot({ path: join(output, 'poster.png') });
  report.status = 'passed'; report.recording_duration_ms = elapsed(); report.video_timeline_seconds = videoTime();
  stdout('All demo assertions passed; saving the full video.');
  await context.close(); context = undefined;
  await video.saveAs(join(output, 'tablaze-demo.webm'));
  if (ffmpeg) {
    // Output frame-rate conversion retains timestamps; it does not speed up the recording.
    const original = join(output, 'tablaze-demo-original.webm');
    await rename(join(output, 'tablaze-demo.webm'), original);
    const args = ['-y', '-hide_banner', '-loglevel', 'error', '-i', original, '-an', '-c:v', 'libvpx', '-b:v', '0', '-crf', '18', '-r', '5', '-fps_mode', 'cfr', '-deadline', 'good', '-cpu-used', '4', join(output, 'tablaze-demo.webm')];
    await promisify(execFile)(ffmpeg, args, { timeout: 120000, maxBuffer: 1024 * 1024 });
    report.video_encoding = { codec: 'VP8', frames_per_second: 5, crf: 18, resolution_unchanged: true, timestamps_preserved: true, original_file: 'tablaze-demo-original.webm', original_sha256: sha256(await readFile(original)), encoder_sha256: sha256(await readFile(ffmpeg)), command_arguments: args.map(value => value === original ? 'INPUT.webm' : value === join(output, 'tablaze-demo.webm') ? 'OUTPUT.webm' : value) };
  }
  await rm(recording, { recursive: true, force: true });
  const metadata = await browser.newPage();
  await metadata.goto('http://127.0.0.1:' + server.address().port);
  const duration = await metadata.evaluate(() => new Promise((resolve, reject) => { const video = document.createElement('video'); video.preload = 'metadata'; video.onloadedmetadata = () => resolve(video.duration); video.onerror = () => reject(new Error('Could not read recorded video metadata')); video.src = '/video.webm'; document.body.append(video); }));
  await metadata.close(); assert.ok(Number.isFinite(duration) && duration > 0);
  for (const item of report.chapters) assert.ok(item.start_seconds < duration, 'Chapter outside video duration');
  const videoBytes = await readFile(join(output, 'tablaze-demo.webm'));
  report.video = { file: 'tablaze-demo.webm', sha256: sha256(videoBytes), size_bytes: videoBytes.length, duration_seconds: duration, width: 1440, height: 900, chapter_timing: 'Monotonic elapsed time since recorder page creation; first chapter starts at zero. Screen-capture frame scheduling may differ by a fraction of a second.' };
} catch (error) {
  report.status = 'failed'; report.error = { message: error.message, stack: error.stack }; process.exitCode = 1; stdout('Demo failed: ' + error.message);
} finally {
  await client?.close().catch(() => {}); await context?.close().catch(() => {}); await browser?.close().catch(() => {});
  await fixture?.close(); if (server) await new Promise(resolve => server.close(resolve));
  report.completed_at = new Date().toISOString();
  await writeFile(join(output, 'demo-report.json'), JSON.stringify(report, null, 2) + '\n');
  stdout(JSON.stringify({ status: report.status, mcp_calls: report.summary?.mcp_calls, video_seconds: report.video?.duration_seconds, output }));
}
