'use strict';
const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const translations = $$('[data-zh]').map(element => ({element,en:element.innerHTML,zh:element.dataset.zh}));
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
let language = new URLSearchParams(location.search).get('lang') === 'zh' ? 'zh' : 'en';
let demoAvailable = false;
let benchmark, activePanel = 'install', replaying = false, completed = false;
const words = (en,zh) => language === 'zh' ? zh : en;
function renderDynamic() {
  $('#watch-demo').href=demoAvailable?'#demo':'#workflow';
  $('#watch-label').textContent=demoAvailable?words('Watch a real run','观看真实调用'):words('See the workflow','查看操作流程');
  $('#demo-city').textContent = completed ? 'Lisbon' : words('Choose a city','选择城市');
  $('#trace-status').textContent = replaying ? words('Running illustrative replay…','示意回放进行中…') : completed ? words('4 actions complete · outcome checked','4 个操作完成 · 结果已核对') : words('Ready to replay','准备回放');
  if(benchmark) renderBenchmark();
  else $('#benchmark-status').textContent = words('Measurement report not loaded','测量报告尚未加载');
}
function setLanguage(lang) {
  language=lang;
  translations.forEach(({element,en,zh}) => {element.innerHTML = lang === 'zh' ? zh : en;});
  document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';
  document.title = words('Tablaze — Browser actions. Less waiting.','Tablaze 闪页 — 浏览器操作，少一点等待。');
  $('meta[name=description]').content = words('A compact browser MCP with warm sessions, guarded references, action batches, and verifiable results.','精简的浏览器 MCP：保持会话、批量执行操作、校验元素引用，并核对实际结果。');
  $('#language').textContent = words('中文 ↗','EN ↗');
  $('#language').setAttribute('aria-label', words('切换为中文','Switch to English'));
  const url = new URL(location.href);
  lang === 'zh' ? url.searchParams.set('lang','zh') : url.searchParams.delete('lang');
  history.replaceState(null,'',url);
  $('#guide-download').href = lang === 'zh' ? 'CODEX.zh-CN.md' : 'CODEX.md';
  renderDynamic();
}
$('#language').addEventListener('click',()=>setLanguage(language === 'en' ? 'zh' : 'en'));
const pause = ms => new Promise(resolve => setTimeout(resolve,reducedMotion ? 0 : ms));
$('#replay').addEventListener('click', async () => {
  if(replaying) return;
  replaying=true;completed=false;
  $('#replay').disabled=true;
  $$('.trace-row').forEach(row=>{row.classList.remove('done','running');row.querySelector('i').textContent='—';});
  $$('.active').forEach(el=>el.classList.remove('active'));
  $('#demo-nights').textContent='1';
  $('#demo-result').hidden=true;
  $('#demo-flex').classList.remove('checked');
  $('#demo-flex i').textContent='';
  renderDynamic();
  for(let step=0;step<4;step++){
    const row=$('.trace-row[data-step="'+step+'"]');
    row.classList.add('running');row.querySelector('i').textContent='↗';
    await pause(420);
    if(step===0){$('#field-city').classList.add('active');$('#demo-city').textContent='Lisbon';}
    if(step===1){$('#field-city').classList.remove('active');$('#field-nights').classList.add('active');$('#demo-nights').textContent='3';}
    if(step===2){$('#field-nights').classList.remove('active');$('#demo-flex').classList.add('checked');$('#demo-flex i').textContent='✓';}
    if(step===3){$('#demo-search').classList.add('active');await pause(250);$('#demo-result').hidden=false;$('#demo-search').classList.remove('active');}
    row.classList.remove('running');row.classList.add('done');row.querySelector('i').textContent='✓';
    await pause(160);
  }
  completed=true;replaying=false;$('#replay').disabled=false;renderDynamic();
});
function selectPanel(panel, focus=false){
  activePanel=panel;
  $$('[data-panel]').forEach(button=>{
    const selected=button.dataset.panel===panel;
    button.setAttribute('aria-selected',String(selected));button.tabIndex=selected?0:-1;
    $('#panel-'+button.dataset.panel).hidden=!selected;
    if(selected&&focus)button.focus();
  });
}
$$('[data-panel]').forEach((button,index)=>{
  button.addEventListener('click',()=>selectPanel(button.dataset.panel));
  button.addEventListener('keydown',event=>{
    const tabs=$$('[data-panel]');let target;
    if(event.key==='ArrowRight') target=(index+1)%tabs.length;
    if(event.key==='ArrowLeft') target=(index-1+tabs.length)%tabs.length;
    if(event.key==='Home') target=0;
    if(event.key==='End') target=tabs.length-1;
    if(target!==undefined){event.preventDefault();selectPanel(tabs[target].dataset.panel,true);}
  });
});
let toastTimer;
function toast(text){
  $('#toast').textContent=text;$('#toast').classList.add('visible');
  clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('#toast').classList.remove('visible'),2400);
}
async function copy(text){
  try {
    if(!navigator.clipboard)throw new Error('Clipboard unavailable');
    await navigator.clipboard.writeText(text);
    toast(words('Copied to clipboard','已复制到剪贴板'));
  } catch {
    toast(words('Select the command and copy it manually.','请选中命令后手动复制。'));
  }
}
$$('[data-copy]').forEach(button=>button.addEventListener('click',()=>copy(button.dataset.copy)));
$('#copy-setup').addEventListener('click',()=>copy($('#code-'+activePanel).textContent));
function metric(selector,value){
  if(typeof value!=='number'||!Number.isFinite(value))return;
  const node=$(selector);node.textContent=value<1000?String(Math.round(value)):String((value/1000).toFixed(2));
  const unit=document.createElement('em');unit.textContent=value<1000?'ms':'s';node.append(unit);
}
function renderBenchmark(){
  const summary=benchmark.summary;
  if(!summary)return;
  const samples=summary.successful_samples_only;
  metric('#metric-cold',samples?.cold_open_ms?.median);
  metric('#metric-warm',samples?.warm_snapshot_ms?.median);
  metric('#metric-batch',samples?.four_action_batch_ms?.median);
  $('#metric-passed').textContent=summary.succeeded+'/'+summary.attempted;
  const info=[benchmark.environment?.platform,benchmark.environment?.arch].filter(Boolean).join(' / ');
  $('#benchmark-status').textContent=words('Measured locally · ','本机实测 · ')+info;
  $('#raw-data').hidden=false;
}
setLanguage(language);
fetch('benchmark.json').then(response=>{
  if(!response.ok)throw new Error('Measurement report unavailable');
  return response.json();
}).then(data=>{benchmark=data;renderBenchmark();}).catch(()=>{});
fetch('release.json').then(response=>response.ok?response.json():null).then(data=>{
  if(data?.package==='tablaze-0.1.0.tgz')$('#package-download').hidden=false;
  if(data?.source==='tablaze-0.1.0-source.zip')$('#source-download').hidden=false;
  if(data?.guides)$('#guide-download').hidden=false;
  demoAvailable=data?.demo===true;
  $('#demo').hidden=!demoAvailable;
  if(demoAvailable){const video=$('#real-demo-video');video.poster=video.dataset.poster;video.querySelector('source').src=video.querySelector('source').dataset.src;video.load();}
  renderDynamic();
}).catch(()=>{});
