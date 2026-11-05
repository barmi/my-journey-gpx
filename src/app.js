import { analyzeChunks, mergeAnalyses, parseGPX, DEFAULTS, KINDS, POIS, distance } from './analysis.js';
import { MAP_CONFIG } from './map-config.js';

const $=s=>document.querySelector(s);
const escape=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const stored=key=>{try{return JSON.parse(localStorage.getItem(key));}catch{return null;}};
const persist=(key,value)=>{try{localStorage.setItem(key,JSON.stringify(value));}catch{}};
let settings={...DEFAULTS,...stored('journey-settings')};
let state={group:'spain',date:null,...stored('journey-selection')};
let index,analysis,selectedEpisode=null,renderToken=0;
const payloadCache=new Map(),analysisCache=new Map();
const layers=Object.fromEntries([...Object.keys(KINDS),'plan'].map(k=>[k,L.layerGroup()]));
const map=L.map('map',{zoomControl:false,preferCanvas:true,scrollWheelZoom:true}).setView([39.6,-3.7],6);
L.control.zoom({position:'bottomright'}).addTo(map);L.control.scale({imperial:false,position:'bottomleft'}).addTo(map);
let tileFailures=0;
L.tileLayer(MAP_CONFIG.url,{maxZoom:MAP_CONFIG.maxZoom,attribution:MAP_CONFIG.attribution,updateWhenIdle:true,keepBuffer:1})
 .on('tileerror',()=>{if(++tileFailures>2)$('#map-error').hidden=false;})
 .on('tileload',()=>{tileFailures=0;$('#map-error').hidden=true;}).addTo(map);
Object.values(layers).forEach(l=>l.addTo(map));
let fitBounds=null;
const km=m=>(m/1000).toLocaleString('ko-KR',{maximumFractionDigits:1});
function duration(s){const min=Math.round(s/60);return min>=60?`${Math.floor(min/60)}시간${min%60?` ${min%60}분`:''}`:`${min}분`;}
function clock(t,zone){return new Intl.DateTimeFormat('ko-KR',{timeZone:zone,hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(new Date(t*1000));}
function dateInZone(t,zone){const p=new Intl.DateTimeFormat('en-CA',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date(t*1000));const get=k=>p.find(p=>p.type===k).value;return `${get('year')}-${get('month')}-${get('day')}`;}
const zone=()=>selectedRecords()[0]?.timezone||index?.groups[state.group]?.zone||'UTC';
function toast(message){$('#toast').textContent=message;$('#toast').hidden=false;clearTimeout(toast.timer);toast.timer=setTimeout(()=>$('#toast').hidden=true,5000);}
function selectedRecords(){return index?.records.filter(r=>r.group===state.group&&r.date===state.date&&!r.duplicateOf&&r.group!=='empty')||[];}
function planForDay(){return state.group==='spain'?index.plan.days.find(d=>d.date===state.date):null;}
function daysInGroup(){
  const dates=new Set(index.records.filter(r=>r.group===state.group&&!r.duplicateOf&&r.group!=='empty').map(r=>r.date));
  if(state.group==='spain')index.plan.days.forEach(d=>dates.add(d.date));
  return [...dates].sort();
}
function remember(){persist('journey-selection',state);}
function hydrateControls(){
  const groups=Object.entries(index.groups).filter(([id])=>index.records.some(r=>r.group===id));
  if(!groups.some(([id])=>id===state.group))state.group=groups[0]?.[0]||'spain';
  $('#journey-select').innerHTML=groups.map(([id,g])=>`<option value="${id}">${escape(g.name)}</option>`).join('');
  $('#journey-select').value=state.group;
  const dates=daysInGroup();
  if(!dates.includes(state.date))state.date=index.records.filter(r=>r.group===state.group&&!r.duplicateOf).map(r=>r.date).sort().at(-1)||dates[0];
  $('#day-count').textContent=`${dates.length}일`;
  $('#day-list').innerHTML=dates.map(date=>{
    const rs=index.records.filter(r=>r.group===state.group&&r.date===date&&!r.duplicateOf),plan=state.group==='spain'?index.plan.days.find(d=>d.date===date):null;
    const label=plan?plan.route:rs.map(r=>r.name.replace(/\.gpx$/i,'')).join(', ');
    return `<button class="day ${date===state.date?'active':''}" data-date="${escape(date)}" aria-pressed="${date===state.date}"><span class="day-number">${date.slice(-2)}</span><span class="day-text"><strong>${escape(state.group==='spain'?label:date.slice(0,7))}</strong><small>${date.slice(5).replace('-','/')} · ${rs.length?`${rs.length}개 기록`:'계획'}</small></span><span class="dot"></span></button>`;
  }).join('');
  $('#day-list').querySelectorAll('[data-date]').forEach(button=>button.onclick=()=>{state.date=button.dataset.date;remember();hydrateControls();renderDay();});
  const latest=index.records.filter(r=>r.group!=='empty').map(r=>r.date).sort().at(-1);
  const policy=index.buildPolicy;
  const scope=policy?.recentLimit?`원본 ${policy.sourceFiles}개 중 최근 ${policy.recentLimit}개 배포 · `:'';
  $('#dataset-status').innerHTML=`${policy?.recentLimit?'최근 ':''}${index.counts.files}개 GPX · 최근 기록 <span class="record-date">${escape(latest)}</span><br>겹치는 파일 ${index.counts.duplicates}개는 합계에서 제외`;
  $('#quality-summary').textContent=`${scope}포함된 파일 ${index.counts.files}개 · 겹치는 파일 ${index.counts.duplicates}개 · 좌표가 없거나 읽을 수 없는 파일 ${index.counts.empty}개. 날짜 목록과 최근 파일 선택은 각 파일의 기록 시작 시각 기준입니다.`;
}
async function payload(record){
  if(!payloadCache.has(record.id))payloadCache.set(record.id,fetch(`./data/records/${record.id}.json`).then(r=>{if(!r.ok)throw new Error(`${record.name} 경로를 읽지 못했습니다.`);return r.json();}));
  return payloadCache.get(record.id);
}
async function analyze(record){
  const key=record.id+JSON.stringify(settings);
  if(!analysisCache.has(key))analysisCache.set(key,payload(record).then(p=>analyzeChunks(p.chunks,{settings,pois:record.group==='spain'?POIS:[],overrides:p.overrides})));
  return analysisCache.get(key);
}
async function renderDay(){
  const token=++renderToken,rs=selectedRecords(),plan=planForDay();selectedEpisode=null;
  $('#selected-date').textContent=state.date?`${state.date.replaceAll('-','.')} · ${index.groups[state.group]?.name||''}`:'';
  $('#selected-title').textContent=plan?.route||(rs.length>1?`하루의 기록 · 파일 ${rs.length}개`:rs[0]?.name.replace(/\.gpx$/i,''))||'기록 없음';
  $('#episode-list').innerHTML='<div class="empty">이동과 체류 시간을 분석하고 있습니다…</div>';
  try{
    const analyses=await Promise.all(rs.map(analyze));if(token!==renderToken)return;
    analysis=mergeAnalyses(analyses);
    drawMap(plan);drawMetrics(rs);drawTimeline();drawEpisodes();drawPlan(plan);
  }catch(error){if(token!==renderToken)return;$('#episode-list').innerHTML=`<div class="error-banner">${escape(error.message)}</div>`;toast(error.message);}
}
function drawMap(plan){
  Object.values(layers).forEach(l=>l.clearLayers());const bounds=[];
  for(const [i,e] of analysis.episodes.entries()){
    if(e.kind==='unknown'||!e.path.length)continue;
    const coords=e.path.map(p=>p.slice(0,2));bounds.push(...coords);
    const color=KINDS[e.kind].color;
    const line=L.polyline(coords,{color,weight:e.kind==='drive'?3.5:2.5,opacity:e.kind==='stay'?.45:.9}).addTo(layers[e.kind]);
    const html=`<strong>${escape(e.label)}</strong>${clock(e.start,zone())}–${clock(e.end,zone())}<br>${duration(e.seconds)} · ${km(e.meters)} km<br><span style="color:#7c868b">${KINDS[e.kind].label}${e.manual?' · 수동 보정':' · GPX 기반 추정'}</span>`;
    line.bindPopup(html).on('click',()=>selectEpisode(i,false));
    if((e.kind==='visit'||e.kind==='walk')&&e.seconds>=settings.minVisitMinutes*60){
      L.circle(e.center,{radius:e.radius,color,weight:1.4,fillColor:color,fillOpacity:.10,dashArray:e.kind==='walk'?'4 5':undefined}).bindPopup(html).on('click',()=>selectEpisode(i,false)).addTo(layers[e.kind]);
      L.circleMarker(e.center,{radius:4,color:'#fff',weight:2,fillColor:color,fillOpacity:1}).bindTooltip(`${escape(e.label)} · ${duration(e.seconds)}`,{className:'visit-label'}).addTo(layers[e.kind]);
    }else if(e.kind==='stay'&&e.seconds>=600){L.circleMarker(e.center,{radius:4,color:'#fff',weight:1.5,fillColor:color,fillOpacity:1}).bindPopup(html).addTo(layers.stay);}
  }
  if(plan?.stops.length){
    const coords=plan.stops.map(s=>[s.coord[1],s.coord[0]]);bounds.push(...coords);
    L.polyline(coords,{color:'#a1906c',weight:1.7,dashArray:'5 7',opacity:.7}).bindTooltip('계획 방문 순서 · 직선 연결').addTo(layers.plan);
    plan.stops.forEach((s,i)=>L.circleMarker([s.coord[1],s.coord[0]],{radius:4,color:'#9c8961',weight:1.5,fillColor:'#fffdf7',fillOpacity:1}).bindPopup(`<strong>${i+1}. ${escape(s.name)}</strong>계획 방문지 · 실제 관람 여부와 다를 수 있음`).addTo(layers.plan));
  }
  fitBounds=bounds.length?L.latLngBounds(bounds):null;
  if(fitBounds)map.fitBounds(fitBounds,{padding:[35,35],maxZoom:15,animate:false});
  map.invalidateSize();
}
function drawMetrics(rs){
  for(const kind of ['drive','visit','walk'])$(`#${kind}-time`).textContent=rs.length?duration(analysis.totals[kind].seconds):'—';
  $('#drive-distance').textContent=rs.length?`${km(analysis.totals.drive.meters)} km · 차량으로 추정한 구간`:'GPX 기록이 추가되면 표시됩니다';
  const visits=analysis.episodes.filter(e=>e.kind==='visit');
  $('#visit-count').textContent=visits.length?`${new Set(visits.map(e=>e.label)).size}개 관광 구역 · 이동 시간 제외`:'등록 관광지 주변의 비차량 시간';
  $('#other-time').textContent=rs.length?`기타 체류 ${duration(analysis.totals.stay.seconds)}`:'아직 기록이 없는 일정입니다';
}
function drawTimeline(){
  const target=$('#timeline'),start=analysis.start,end=analysis.end;
  $('#timezone-label').textContent=zone();
  if(start===null||end===null){target.innerHTML='<div class="empty">아직 GPX 기록이 없습니다. 계획 방문지를 지도에서 볼 수 있습니다.</div>';$('#record-range').textContent='';return;}
  const span=end-start;
  const ticks=window.innerWidth<600?4:7;
  let html='<div class="time-axis">';
  for(let i=0;i<ticks;i++){const t=start+span*i/(ticks-1);html+=`<span style="left:${i/(ticks-1)*100}%">${clock(t,zone())}${dateInZone(t,zone())!==state.date?' +1일':''}</span>`;}
  html+='</div><div class="timeline-track">';
  let previous=start;
  for(const [i,e] of analysis.episodes.entries()){
    if(e.start>previous)html+=`<span style="width:${(e.start-previous)/span*100}%;background:#f0f1ee" aria-label="다른 파일 사이의 미기록 시간"></span>`;
    html+=`<button class="time-segment ${e.kind}" style="width:${e.seconds/span*100}%;background:${KINDS[e.kind].color}" data-episode="${i}" aria-label="${escape(e.label)} ${clock(e.start,zone())}부터 ${duration(e.seconds)}" title="${escape(e.label)} · ${clock(e.start,zone())}–${clock(e.end,zone())} · ${duration(e.seconds)}"></button>`;previous=e.end;
  }
  target.innerHTML=html+'</div>';
  target.querySelectorAll('[data-episode]').forEach(b=>b.onclick=()=>selectEpisode(Number(b.dataset.episode)));
  $('#record-range').textContent=`기록 ${clock(start,zone())}–${clock(end,zone())}${dateInZone(end,zone())!==state.date?' (다음 날 종료)':''} · 기록 단절 ${duration(analysis.totals.unknown.seconds)}`;
}
function drawEpisodes(){
  const visible=analysis.episodes.map((e,i)=>({...e,index:i})).filter(e=>e.seconds>=60||e.kind==='visit');
  $('#episode-count').textContent=`${visible.length}개 구간`;
  $('#episode-list').innerHTML=visible.length?visible.map(e=>`<button class="episode" data-episode="${e.index}"><span class="episode-time">${clock(e.start,zone())}–${clock(e.end,zone())}</span><i class="swatch ${e.kind}"></i><span><span class="episode-name">${escape(e.label)}</span><span class="episode-meta">${KINDS[e.kind].label}${e.kind==='unknown'?'':` · ${km(e.meters)} km`}${e.manual?' · 보정됨':''}</span></span><span class="episode-duration">${duration(e.seconds)}</span></button>`).join(''):'<div class="empty">새 GPX를 추가하면 차량 이동과 관광지 체류가 여기에 표시됩니다.</div>';
  $('#episode-list').querySelectorAll('[data-episode]').forEach(b=>b.onclick=()=>selectEpisode(Number(b.dataset.episode)));
}
function selectEpisode(i,zoom=true){
  selectedEpisode=i;document.querySelectorAll('[data-episode]').forEach(el=>el.classList.toggle('active',Number(el.dataset.episode)===i));
  const e=analysis.episodes[i];if(!e)return;
  if(zoom&&e.path.length){map.fitBounds(L.latLngBounds(e.path.map(p=>p.slice(0,2))),{padding:[45,45],maxZoom:16,animate:!matchMedia('(prefers-reduced-motion:reduce)').matches});
    L.popup().setLatLng(e.center).setContent(`<strong>${escape(e.label)}</strong>${clock(e.start,zone())}–${clock(e.end,zone())} · ${duration(e.seconds)}`).openOn(map);
    const rect=$('#map').getBoundingClientRect();
    if(rect.bottom<100||rect.top>window.innerHeight)document.querySelector('.map-column').scrollIntoView({behavior:matchMedia('(prefers-reduced-motion:reduce)').matches?'auto':'smooth',block:'start'});
  }
}
function drawPlan(plan){
  $('#plan-detail').innerHTML=plan?`<p>${escape(plan.route)}</p>${plan.stops.map((s,i)=>`<div class="plan-stop"><span>${String(i+1).padStart(2,'0')}</span>${escape(s.name)}</div>`).join('')}<div class="plan-meta">${escape(plan.hotel)}<br>예정 이동 ${escape(plan.bus)}<br>${escape(plan.note)}<br><br>${escape(index.plan.source)}</div>`:'<p>이 날짜에 연결된 여행계획이 없습니다.</p><div class="plan-meta">관광지 이름이 없는 구간은 GPX의 이동 특성에 따라 도보·탐방 또는 기타 체류로 구분합니다.</div>';
}
$('#journey-select').onchange=()=>{state.group=$('#journey-select').value;state.date=null;remember();hydrateControls();renderDay();};
$('#fit-map').onclick=()=>{if(fitBounds)map.fitBounds(fitBounds,{padding:[35,35],maxZoom:15,animate:false});};
$('#map-toolbar').querySelectorAll('input').forEach(input=>input.onchange=()=>{const layer=layers[input.dataset.layer];if(input.checked)layer.addTo(map);else map.removeLayer(layer);});
$('#settings-button').onclick=()=>{$('#vehicle-speed').value=settings.vehicleKmh;$('#min-visit').value=settings.minVisitMinutes;$('#settings-dialog').showModal();};
$('#settings-close').onclick=()=>$('#settings-dialog').close();
$('#settings-default').onclick=()=>{$('#vehicle-speed').value=DEFAULTS.vehicleKmh;$('#min-visit').value=DEFAULTS.minVisitMinutes;};
$('#settings-form').onsubmit=e=>{e.preventDefault();settings={...settings,vehicleKmh:Number($('#vehicle-speed').value),minVisitMinutes:Number($('#min-visit').value)};persist('journey-settings',settings);$('#settings-dialog').close();renderDay();toast('분류 기준을 적용했습니다.');};
$('#import-button').onclick=()=>$('#file-input').click();
$('#file-input').onchange=async e=>{
  let count=0,last=null,failed=[];
  for(const file of e.target.files){
    try{
      const text=await file.text(),parsed=parseGPX(text),points=parsed.chunks.flat();
      const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text)))).map(b=>b.toString(16).padStart(2,'0')).join('');
      const id='local-'+hash.slice(0,16);
      if(index.records.some(r=>r.id===id||r.contentHash===hash)){continue;}
      const center=points[Math.floor(points.length/2)],current=POIS.some(p=>distance(center,[p.lat,p.lon])<900000);
      const group=current?'spain':'imported',timezone=current?'Europe/Madrid':'UTC';
      if(!index.groups.imported)index.groups.imported={name:'직접 추가한 기록',zone:'UTC'};
      const start=Math.min(...points.map(p=>p[2])),end=Math.max(...points.map(p=>p[2]));
      const record={id,name:file.name,group,timezone,date:dateInZone(start,timezone),start,end,pointCount:parsed.pointCount,duplicateOf:null};
      index.records.push(record);index.counts.files++;payloadCache.set(id,Promise.resolve({record,chunks:parsed.chunks,overrides:[]}));count++;last=record;
    }catch(error){failed.push(`${file.name}: ${error.message}`);}
  }
  if(last){state={group:last.group,date:last.date};hydrateControls();renderDay();}
  toast(`${count}개 기록을 이 화면에 추가했습니다.${failed.length?` ${failed.length}개 파일 읽기 실패.`:' 새로고침하면 다시 불러와 주세요.'}`);e.target.value='';
};
window.addEventListener('resize',()=>{map.invalidateSize();if(analysis)drawTimeline();});
async function refresh(){
  try{
    const response=await fetch('./data/index.json',{cache:'no-store'});if(!response.ok)throw new Error('여행 데이터가 없습니다. 먼저 빌드를 실행해 주세요.');
    const next=await response.json();if(index?.version===next.version)return;
    const initial=!index;index=next;payloadCache.clear();analysisCache.clear();hydrateControls();remember();await renderDay();
    if(!initial)toast('새 GPX 기록을 반영했습니다.');
  }catch(error){if(!index){$('#episode-list').innerHTML=`<div class="error-banner">${escape(error.message)}</div>`;$('#dataset-status').textContent='기록을 불러오지 못했습니다.';}}
}
await refresh();setInterval(()=>{if(!document.hidden)refresh();},20000);
