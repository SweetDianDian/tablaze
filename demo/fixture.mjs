import http from 'node:http';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';

const escape = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const css = `*{box-sizing:border-box}body{margin:0;background:#f6f4ef;color:#282e2b;font:18px -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif}header{height:78px;border-bottom:1px solid #deded5;display:flex;align-items:center;justify-content:space-between;padding:0 64px;background:#fffdfa}.brand{font-weight:800;font-size:25px;letter-spacing:-1px}.brand b{color:#cf5937}.badge{font-size:14px;letter-spacing:1px;color:#6d756f}main{max-width:1152px;margin:0 auto;padding:38px 0}.eyebrow{font:12px ui-monospace,monospace;letter-spacing:2px;color:#7c857e}h1{font-size:36px;letter-spacing:-1px;line-height:1.25;margin:12px 0}h2{font-size:29px;margin:8px 0}p{color:#747d75;line-height:1.6;margin:8px 0}.layout{display:grid;grid-template-columns:1.6fr 1fr;gap:24px;margin-top:25px}.panel{background:#fffefa;border:1px solid #dfdfd6;border-radius:18px;padding:30px}.grid{display:grid;grid-template-columns:1fr 1fr;gap:18px}label{display:block;font-size:20px;color:#495249}input:not([type=checkbox]),select{display:block;width:100%;height:49px;border:1px solid #cfd3ca;border-radius:8px;background:#fff;color:#293a31;padding:10px 12px;font:22px -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;margin-top:9px}input[type=checkbox]{width:20px;height:20px;accent-color:#33715b;vertical-align:middle;margin:0 8px 0 0}.check{margin:24px 0}.button,button{display:inline-flex;align-items:center;justify-content:center;background:#c75837;color:white;border:0;border-radius:9px;padding:15px 24px;font:600 18px -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;text-decoration:none;cursor:pointer}button{width:100%}.muted{font-size:14px;color:#8d948c}.tag{display:inline-block;padding:7px 11px;border-radius:30px;background:#e5eee5;color:#416a52;font-size:14px;margin:6px 4px 6px 0}.orange{background:#fff0df;color:#a06a31}.metric{font-size:46px;color:#354f42;line-height:1.25;font-weight:650;margin:13px 0}.line{border-top:1px solid #e5e4dc;padding-top:16px;margin-top:16px;display:flex;justify-content:space-between;font-size:19px}.line span{color:#828b82}.progress{display:flex;gap:12px;margin:20px 0 0;color:#8a9088;font-size:14px}.progress b{color:#3e6b52}.hotel{display:grid;grid-template-columns:180px 1fr;gap:26px;align-items:center}.art{height:194px;border-radius:10px;background:linear-gradient(170deg,#cfdfc5 0 35%,#eadac2 36% 68%,#819a74 69%);position:relative;overflow:hidden}.art:before{content:"";position:absolute;width:96px;height:148px;left:40px;bottom:-5px;background:repeating-linear-gradient(90deg,transparent 0 14px,#706f53 14px 29px,transparent 29px 40px),#dfb078;border:14px solid #e9c595;border-top-width:22px;border-radius:4px}.art:after{content:"LISBON";position:absolute;top:14px;left:16px;font:10px ui-monospace;letter-spacing:3px;color:#506147}#change-note{font-size:14px;margin:15px 0 0;color:#947339}table{width:100%;border-collapse:collapse;font-size:19px;margin-top:17px}td{border-top:1px solid #e4e6dc;padding:13px 0}td:last-child{text-align:right;color:#485e4d;font-weight:600}.success{font-size:39px;color:#3c7657;margin-bottom:14px}.receipt{max-width:920px;margin:auto}.receipt .layout{grid-template-columns:1.4fr 1fr}.receipt h1{margin-top:0}footer{text-align:center;color:#969d94;font-size:12px;margin-top:20px}a:focus-visible,button:focus-visible,input:focus-visible,select:focus-visible{outline:3px solid #edaf61;outline-offset:4px}`;
function document(title, body, script = '') {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)}</title><style>${css}</style></head><body><header><div class="brand">way<b>far</b> / 差旅工作台</div><div class="badge">TABLAZE DEMO · 本地演示</div></header><main>${body}<footer>虚构差旅任务 · 无外部预订或付款</footer></main>${script ? `<script>${script}</script>` : ''}</body></html>`;
}
const searchPage = () => document('差旅计划 — Wayfar', `<div class="eyebrow">01 / PLAN THE TRIP</div><h1>下一站，里斯本。</h1><p>为两位同事安排 3 晚住宿，选择可免费取消的酒店。</p><div class="layout"><form class="panel" action="/results"><div class="grid"><label>目的地<input id="destination" name="destination" placeholder="输入城市" required autocomplete="off"></label><label>住宿晚数<select name="nights"><option value="1">1 晚</option><option value="3">3 晚</option><option value="5">5 晚</option></select></label><label>出行人数<select name="travelers"><option value="1">1 人</option><option value="2">2 人</option><option value="3">3 人</option></select></label><label>预算上限（EUR）<input name="budget" type="number" min="1" placeholder="输入金额" required></label></div><label class="check"><input type="checkbox" name="flexible" value="yes">免费取消</label><button>查找酒店</button></form><aside class="panel"><div class="eyebrow">YOUR BRIEF</div><h2>把计划变成行程</h2><p>Lisbon · 3 晚 · 2 人</p><div class="metric">€ 900<span class="muted"> / 上限</span></div><div class="line"><span>取消政策</span>免费取消</div><div class="line"><span>后续步骤</span>审批 → 导出行程</div><p class="muted" style="margin-top:25px">所有表单与结果均由真实浏览器操作。</p></aside></div>`);
function resultsPage(filters) {
  const match = filters.destination === 'Lisbon' && filters.nights === '3' && filters.travelers === '2' && filters.flexible === 'yes' && Number(filters.budget) >= 780;
  return document('酒店筛选结果 — Wayfar', `<div class="eyebrow">02 / MATCH YOUR CRITERIA</div><h1>里斯本，一处合适的落脚点。</h1><p id="applied-filters">${escape(filters.nights)} 晚 · ${escape(filters.travelers)} 人 · ${filters.flexible === 'yes' ? '免费取消' : '普通取消政策'} · 预算 € ${escape(filters.budget)}</p><div class="layout"><section class="panel" aria-label="酒店结果">${match ? `<article data-hotel="casa-flora"><div class="hotel"><div class="art" aria-hidden="true"></div><div><span class="tag">符合全部条件</span><h2>Casa Flora</h2><p>Lisbon · 双人套房 · 含早餐</p><span class="tag">免费取消</span><div class="metric">€ 780</div><p class="muted">3 晚总价 · 低于预算 € 120</p></div></div><div class="line"><span>结果可验收</span>城市、晚数、人数与政策</div><button id="approve" style="margin-top:22px">发起审批</button><p id="change-note">房型与价格已刷新。</p></article>` : '<h2>没有符合条件的酒店</h2>'}</section><aside class="panel"><div class="eyebrow">APPLIED FILTERS</div><label>目的地<input id="destination" value="${escape(filters.destination)}" readonly></label><table><tr><td>住宿晚数</td><td>${escape(filters.nights)} 晚</td></tr><tr><td>出行人数</td><td>${escape(filters.travelers)} 人</td></tr><tr><td>预算上限</td><td>€ ${escape(filters.budget)}</td></tr></table><div class="progress"><b>✓ 筛选</b><span>→ 审批 → 导出</span></div></aside></div>`, `const bind=()=>{const button=document.querySelector('#approve');if(button)button.onclick=()=>window.open('/approval','_blank')};bind();const stream=new EventSource('/events');stream.onmessage=async({data})=>{const event=JSON.parse(data);if(event.action==='replace'){const old=document.querySelector('#approve');old.replaceWith(old.cloneNode(true));bind();document.querySelector('#change-note').textContent='页面已更新：审批按钮由新节点替换。';await fetch('/ack?sequence='+event.sequence,{method:'POST'})}};`);
}
const approvalPage = () => document('差旅审批 — Wayfar', `<div class="eyebrow">03 / APPROVAL · NEW TAB</div><h1>审批这一趟差旅。</h1><p>原来的筛选页保留在另一个标签页。</p><div class="layout"><form class="panel" method="post" action="/submit"><div class="grid"><label>申请人<input name="requester" required autocomplete="off" placeholder="输入姓名"></label><label>成本中心<select name="cost_center"><option value="">请选择</option><option value="design">设计团队</option><option value="engineering">研发团队</option></select></label></div><label class="check"><input name="confirmed" type="checkbox" value="yes" required>我已确认行程与预算</label><button>批准行程</button><p class="muted" style="margin-top:18px">提交后生成审批回执与可下载的行程文件。</p></form><aside class="panel"><span class="tag">待审批</span><h2>Casa Flora</h2><p>Lisbon · 3 晚 · 2 人</p><div class="metric">€ 780</div><div class="line"><span>取消政策</span>免费取消</div><div class="line"><span>预算余额</span>€ 120</div></aside></div>`);
function receiptPage(order) {
  return document('审批完成 — Wayfar', `<div class="receipt"><div class="eyebrow">04 / READY TO GO</div><div class="layout"><section class="panel"><div class="success">✓</div><h1>审批通过，行程已就绪。</h1><p id="receipt-id">审批编号 ${escape(order.id)}</p><table><tr><td>申请人</td><td>${escape(order.requester)}</td></tr><tr><td>成本中心</td><td>设计团队</td></tr><tr><td>酒店</td><td>Casa Flora</td></tr><tr><td>行程</td><td>Lisbon · 3 晚 · 2 人</td></tr><tr><td>审批金额</td><td>EUR 780</td></tr></table></section><aside class="panel"><span class="tag">审批完成</span><h2>一份可交付的行程</h2><p>下载 CSV 文件，交给同事或导入后续工作流。</p><a class="button" href="/itinerary.csv" download style="margin-top:22px">下载行程 CSV</a><div class="line"><span>取消政策</span>免费取消</div><p class="muted" style="margin-top:20px">文件包含审批编号、城市、晚数、人数与金额。</p></aside></div></div>`);
}

/** One continuous, local-only workflow; the recorder never reaches into the controlled browser. */
export async function startDemoFixture() {
  const streams = new Set(), pending = new Map();
  const state = { searches: 0, popup_visits: 0, submission_attempts: 0, downloads: 0, replacements: 0, filters: null, orders: [] };
  let sequence = 0;
  const csv = () => {
    const order = state.orders.at(-1);
    if (!order) throw new Error('No approved order to export');
    return `approval_id,requester,cost_center,hotel,city,nights,travelers,amount_eur,free_cancellation\n${order.id},${order.requester},${order.cost_center},Casa Flora,Lisbon,3,2,780,true\n`;
  };
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, 'http://fixture.invalid');
    if (url.pathname === '/events') {
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' }); response.write(': ready\n\n'); streams.add(response);
      request.on('close', () => streams.delete(response)); return;
    }
    if (url.pathname === '/ack') { pending.get(Number(url.searchParams.get('sequence')))?.(); response.writeHead(204).end(); return; }
    let html;
    if (url.pathname === '/') html = searchPage();
    else if (url.pathname === '/results') { state.searches++; state.filters = Object.fromEntries(url.searchParams); html = resultsPage(state.filters); }
    else if (url.pathname === '/approval') { state.popup_visits++; html = approvalPage(); }
    else if (url.pathname === '/submit' && request.method === 'POST') {
      state.submission_attempts++;
      let body = ''; for await (const chunk of request) { body += chunk; if (body.length > 8192) { response.writeHead(413).end(); return; } }
      const values = Object.fromEntries(new URLSearchParams(body));
      if (values.requester !== 'Lin Chen' || values.cost_center !== 'design' || values.confirmed !== 'yes' || state.filters?.destination !== 'Lisbon' || state.filters.nights !== '3' || state.filters.travelers !== '2' || state.filters.flexible !== 'yes' || Number(state.filters.budget) < 780) { response.writeHead(400).end('Approval input does not satisfy the task'); return; }
      state.orders.push({ id: `WF-${String(state.orders.length + 1).padStart(3, '0')}`, requester: values.requester, cost_center: values.cost_center, amount_eur: 780, ...state.filters });
      response.writeHead(303, { location: '/receipt' }).end(); return;
    } else if (url.pathname === '/receipt' && state.orders.length) html = receiptPage(state.orders.at(-1));
    else if (url.pathname === '/itinerary.csv' && state.orders.length) {
      state.downloads++; response.writeHead(200, { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="wayfar-itinerary.csv"', 'cache-control': 'no-store' }).end(csv()); return;
    } else { response.writeHead(404).end('Not found'); return; }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(html);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    state: () => structuredClone(state),
    async replaceApproval() {
      const deadline = Date.now() + 3000;
      while (!streams.size) { if (Date.now() > deadline) throw new Error('Demo event stream unavailable'); await delay(10); }
      const id = ++sequence;
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error('DOM replacement not acknowledged')); }, 3000);
        pending.set(id, () => { clearTimeout(timer); pending.delete(id); state.replacements++; resolve(); });
        for (const stream of streams) stream.write(`data: ${JSON.stringify({ action: 'replace', sequence: id })}\n\n`);
      });
    },
    async close() { for (const stream of streams) stream.end(); server.closeAllConnections(); await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); },
  };
}
