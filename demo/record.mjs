import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { startFixture } from '../tests/fixture.mjs';

const root=dirname(dirname(fileURLToPath(import.meta.url)));
const output=resolve(root,process.env.TABLAZE_DEMO_OUTPUT||'demo/output');
const channel=process.env.TABLAZE_BROWSER_CHANNEL||undefined;
const quick=process.env.TABLAZE_DEMO_QUICK==='1';
await mkdir(output,{recursive:true});
const recording=join(output,'recording');
await mkdir(recording,{recursive:true});
const sourceFiles=['dist/browser.js','dist/snapshot.js','dist/server.js','dist/cli.js','demo/record.mjs','demo/viewer.html','tests/fixture.mjs','package-lock.json'];
const sourceHashes=Object.fromEntries(await Promise.all(sourceFiles.map(async name=>[name,createHash('sha256').update(await readFile(join(root,name))).digest('hex')])));
const report={schema_version:1,started_at:new Date().toISOString(),status:'running',source_sha256:sourceHashes,
 environment:{node:process.version,platform:process.platform,arch:process.arch,browser_channel:channel||'managed-chromium'},
 method:{client:'Real MCP TypeScript SDK client over stdio. No Codex/model inference.',display:'Normal-speed recording of a presentation that renders actual MCP responses and tab_capture images. It is not a continuous video feed from the controlled tab.',fixture:'Bundled localhost hotel form and DOM replacement lab. No external service, booking or payment.',pauses:'Explicit presentation holds provide reading time; excluded from each tool elapsed_ms. No timeline acceleration.',quick_mode:quick},events:[],presentation_holds:[],checks:{}};
const started=performance.now();
let fixture,server,browser,context,viewer,client,video;
const stdout=message=>process.stdout.write(message+'\n');
const elapsed=()=>Number((performance.now()-started).toFixed(3));
const present=state=>viewer.evaluate(state=>window.present(state),state);
async function hold(seconds){
 const ms=quick?100:seconds*1000;
 report.presentation_holds.push({at_ms:elapsed(),duration_ms:ms});
 await present({hold:quick?'QUICK VALIDATION / 快速校验':'PRESENTATION PAUSE · '+seconds+'s / 讲解停留'});
 await delay(ms);
 await present({hold:'NORMAL-SPEED RECORDING / 正常速度录制'});
}
async function call(name,args){
 const begin=performance.now();
 const response=await client.callTool({name,arguments:args});
 const data=response.structuredContent;
 assert.ok(data,'Expected structured result from '+name);
 const event={at_ms:elapsed(),name,arguments:args,result:data,is_error:response.isError===true,elapsed_ms:Number((performance.now()-begin).toFixed(3))};
 report.events.push(event);await present({events:report.events,state:event.is_error?'REJECTED':'RESPONSE RECEIVED'});
 return {data,response,event};
}
async function capture(sessionId,filename){
 const {response,event}=await call('tab_capture',{session_id:sessionId});
 const block=response.content.find(item=>item.type==='image');
 assert.ok(block,'A real screenshot must accompany capture');
 await writeFile(join(output,filename),Buffer.from(block.data,'base64'));
 event.image_file=filename;
 await present({image:'data:'+block.mimeType+';base64,'+block.data,capture:'tab_capture · '+(elapsed()/1000).toFixed(1)+'s',location:'LOCALHOST / '+(new URL(event.result.url).pathname)});
}
const byName=(snapshot,name)=>{
 const item=snapshot.elements.find(element=>element.name===name);
 assert.ok(item,'Missing observed control '+name);
 return item.ref;
};
try{
 fixture=await startFixture();
 const html=await readFile(join(root,'demo/viewer.html'));
 server=http.createServer((request,response)=>response.writeHead(200,{'content-type':'text/html; charset=utf-8'}).end(html));
 server.listen(0,'127.0.0.1');await once(server,'listening');
 browser=await chromium.launch({headless:true,channel});
 report.environment.browser_version=browser.version();
 context=await browser.newContext({viewport:{width:1440,height:900},recordVideo:{dir:recording,size:{width:1440,height:900}}});
 viewer=await context.newPage();video=viewer.video();
 await viewer.goto('http://127.0.0.1:'+server.address().port);
 const args=['dist/cli.js',...(channel?['--channel',channel]:[])];
 client=new Client({name:'tablaze-demo-recorder',version:'0.1.0'});
 const transport=new StdioClientTransport({command:process.execPath,args,cwd:root,stderr:'pipe'});
 let stderr='';transport.stderr?.on('data',chunk=>{stderr+=chunk});
 await client.connect(transport);
 const listed=await client.listTools();assert.equal(listed.tools.length,8);
 report.checks.handshake={server:client.getServerVersion(),tools:listed.tools.map(tool=>tool.name)};
 await present({state:'8 TOOLS CONNECTED'});
 stdout('Connected to the real stdio server; recording presentation.');
 await hold(6);

 const opened=(await call('tab_open',{url:fixture.url+'/'})).data;
 assert.equal(opened.ok,true);
 await capture(opened.session_id,'01-observe.jpg');
 const names=['Destination','Nights','Free cancellation','Search stays'];
 await present({chapter:'01 / OBSERVE',title:'Start from what the browser actually shows.',subtitle:'Read a snapshot and its element references. / 读取快照与元素引用。',
 detail:'tab_open → snapshot\n\n'+opened.elements.filter(el=>names.includes(el.name)).map(({ref,role,name})=>ref+'  '+role+'  '+JSON.stringify(name)).join('\n')+'\n\nsnapshot_id: …'+opened.snapshot_id.slice(-12),
 caption:{en:'The image is a real tab_capture result from the newly opened isolated session.',zh:'右侧是隔离会话中 tab_capture 返回的真实截图。'}});
 await hold(6);

 const actions=[{type:'fill',ref:byName(opened,'Destination'),value:'Lisbon'},{type:'select',ref:byName(opened,'Nights'),values:['3']},{type:'check',ref:byName(opened,'Free cancellation'),checked:true},{type:'click',ref:byName(opened,'Search stays')}];
 await present({chapter:'02 / ACT',title:'Four actions. One tool request.',subtitle:'Fill → select → check → click. / 一次发送四步顺序操作。',
 detail:'tab_act\n\n'+actions.map(action=>JSON.stringify(action)).join('\n\n'),state:'NEXT REQUEST',
 caption:{en:'A single batch submits four ordered actions. The original snapshot supplies every ref.',zh:'一个批次提交四个有序操作，引用均来自刚才的快照。'}});
 await hold(3);
 const acted=(await call('tab_act',{session_id:opened.session_id,snapshot_id:opened.snapshot_id,actions})).data;
 assert.equal(acted.ok,true);assert.equal(acted.completed,4);
 const checks=[{kind:'url',value:fixture.url+'/results?destination=Lisbon&nights=3&flexible=yes'},{kind:'title',contains:'Hotel results'},{kind:'text',contains:'3 nights · Free cancellation'},{kind:'value',selector:'#destination',value:'Lisbon'},{kind:'count',selector:'[data-hotel="casa-flora"]',value:1}];
 const verified=(await call('tab_verify',{session_id:opened.session_id,checks})).data;
 assert.equal(verified.passed,true);
 report.checks.hotel={completed:acted.completed,verification:verified};
 await capture(opened.session_id,'02-verified.jpg');
 await present({chapter:'03 / VERIFY',title:'Verify the result beyond the click.',subtitle:'URL, title, text, field and result count. / 独立检查五项结果。',
 detail:'tab_verify\npassed: '+verified.passed+'\n\n'+verified.checks.map(check=>(check.pass?'✓  ':'✗  ')+check.kind).join('\n\n'),
 caption:{en:'All five assertions passed against the resulting page. The snapshot shows the applied filters.',zh:'结果页的五项断言全部通过；截图展示实际应用的筛选条件。'}});
 await hold(9);

 const token='recorded-demo';
 const lab=(await call('tab_open',{url:fixture.url+'/lab?token='+token})).data;
 await capture(lab.session_id,'03-before-replacement.jpg');
 await present({chapter:'04 / CHANGED TARGET',title:'What if the page changes after observation?',subtitle:'Replace a real DOM node in the fixture. / 让测试页替换已观察的节点。',
 detail:JSON.stringify({observed_ref:byName(lab,'Target action'),snapshot_id:lab.snapshot_id,next:'Fixture replaces this node before the click.'},null,2),
 caption:{en:'The local fixture will replace the target with an identical-looking new node.',zh:'本地测试页接下来会把目标替换成外观相同的新节点。'}});
 await hold(6);
 await fixture.mutate(token,'replace');
 report.events.push({at_ms:elapsed(),name:'fixture.replace',arguments:{target:'#target'},result:{acknowledged:true},is_error:false,elapsed_ms:0,not_mcp:true});
 const refused=(await call('tab_act',{session_id:lab.session_id,snapshot_id:lab.snapshot_id,actions:[{type:'click',ref:byName(lab,'Target action')}]})).data;
 assert.equal(refused.ok,false);assert.equal(refused.completed,0);assert.equal(refused.failed.error.code,'STALE_REFERENCE');
 const unchanged=(await call('tab_verify',{session_id:lab.session_id,checks:[{kind:'text',contains:'Target count: 0'}]})).data;
 assert.equal(unchanged.passed,true);
 report.checks.changed_target={refused_code:refused.failed.error.code,completed:refused.completed,unchanged:unchanged.passed};
 await capture(lab.session_id,'04-refused.jpg');
 await present({title:'The stale target is rejected.',subtitle:'No target click was completed. / 没有完成对目标的点击。',
 detail:JSON.stringify({ok:refused.ok,completed:refused.completed,error:refused.failed.error,independent_check:'Target count: 0'},null,2),
 caption:{en:'The rejected reference produced STALE_REFERENCE. A separate check confirms the counter stayed at zero.',zh:'旧引用被拒绝并返回 STALE_REFERENCE；独立验收确认计数仍为零。'}});
 await hold(8);

 const fresh=(await call('tab_snapshot',{session_id:lab.session_id})).data;
 const recovered=(await call('tab_act',{session_id:lab.session_id,snapshot_id:fresh.snapshot_id,actions:[{type:'click',ref:byName(fresh,'Target action')}]})).data;
 assert.equal(recovered.ok,true);
 const recovery=(await call('tab_verify',{session_id:lab.session_id,checks:[{kind:'text',contains:'Target count: 1'}]})).data;
 assert.equal(recovery.passed,true);report.checks.recovery={completed:recovered.completed,passed:recovery.passed};
 await capture(lab.session_id,'05-recovered.jpg');
 await present({chapter:'05 / RE-OBSERVE',title:'Observe again. Then continue.',subtitle:'Fresh revision, fresh target reference. / 用新快照和新引用恢复。',
 detail:JSON.stringify({tools:['tab_snapshot','tab_act','tab_verify'],completed:recovered.completed,passed:recovery.passed,independent_check:'Target count: 1'},null,2),
 caption:{en:'A fresh observation identifies the replacement node. The new click passes and the counter becomes one.',zh:'重新观察后选中新节点，点击完成，计数变为一。'}});
 await hold(8);

 await call('tab_close',{session_id:opened.session_id});await call('tab_close',{session_id:lab.session_id});
 const final=(await call('tab_list',{})).data;assert.deepEqual(final.sessions,[]);
 assert.equal(stderr,'');
 report.checks.cleanup={remaining_sessions:final.sessions.length,stderr_empty:true};
 await present({chapter:'06 / CLOSE',title:'Clean up. Keep the evidence.',subtitle:'Two sessions closed. Zero left open. / 两个会话已关闭，没有遗留。',
 detail:JSON.stringify({tool:'tab_list',sessions:final.sessions,evidence:'demo-report.json + actual browser images',scope:'Local fixture / no model inference'},null,2),
 caption:{en:'This run used actual SDK calls and screenshots. Validation and input are not atomic; completed effects cannot be rolled back.',zh:'本片保留真实调用与截图。检查与输入不是原子操作，已发生的副作用不能回滚。'}});
 await hold(8);
 report.status='passed';report.recording_duration_ms=elapsed();stdout('All demo assertions passed; finishing the video.');
 await context.close();context=undefined;
 await video.saveAs(join(output,'tablaze-demo.webm'));
 await rm(recording,{recursive:true,force:true});
 report.video={file:'tablaze-demo.webm',sha256:createHash('sha256').update(await readFile(join(output,'tablaze-demo.webm'))).digest('hex')};
} catch(error){
 report.status='failed';report.error={message:error.message,stack:error.stack};process.exitCode=1;stdout('Demo failed: '+error.message);
} finally{
 await client?.close().catch(()=>{});
 await context?.close().catch(()=>{});
 await browser?.close().catch(()=>{});
 await fixture?.close();
 if(server)await new Promise(resolve=>server.close(resolve));
 report.completed_at=new Date().toISOString();
 await writeFile(join(output,'demo-report.json'),JSON.stringify(report,null,2)+'\n');
 stdout(JSON.stringify({status:report.status,events:report.events.length,duration_ms:report.recording_duration_ms,output}));
}
