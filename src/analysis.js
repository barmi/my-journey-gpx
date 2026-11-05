export const DEFAULTS = { vehicleKmh: 12, minVisitMinutes: 8, maxGapSeconds: 180 };
export const KINDS = {
  drive: { label: '차량 이동', color: '#ce6038' },
  visit: { label: '관광지 체류', color: '#128879' },
  walk: { label: '도보·탐방', color: '#6578b7' },
  stay: { label: '기타 체류', color: '#9297a3' },
  unknown: { label: '기록 단절', color: '#cbd0d8' },
};
export const POIS = [
  ['성가족성당',41.4036,2.1744,450],['구엘공원',41.4145,2.1527,650],
  ['카사 밀라',41.3954,2.1628,350],['람블라스·고딕 지구',41.3808,2.17,900],
  ['그라나다 역사 지구',37.179,-3.591,1250],['론다 구시가지',36.7415,-5.1668,850],
  ['세비야 역사 지구',37.3825,-5.992,1600],['리스본 구시가지',38.714,-9.1394,1100],
  ['벨렝 지구',38.696,-9.209,850],['파티마 성지',39.6305,-8.673,850],
  ['톨레도 구시가지',39.8571,-4.0238,1000],['마드리드 중심부',40.416,-3.700,1300],
  ['사라고사 구시가지',41.6565,-.879,850],['몬세라트 수도원',41.5931,1.8354,800],
].map(([name,lat,lon,radius])=>({name,lat,lon,radius}));
export function distance(a,b) {
  const rad=Math.PI/180,dl=(b[0]-a[0])*rad,dn=(b[1]-a[1])*rad;
  return 6371008.8*2*Math.asin(Math.min(1,Math.sqrt(Math.sin(dl/2)**2+Math.cos(a[0]*rad)*Math.cos(b[0]*rad)*Math.sin(dn/2)**2)));
}
const median = xs => { if(!xs.length)return 0;const s=[...xs].sort((a,b)=>a-b);return s[Math.floor(s.length/2)]; };
function nearestPoi(point,pois) {
  let match=null,best=Infinity;
  for(const p of pois){const d=distance(point,[p.lat,p.lon]);if(d<=p.radius&&d/p.radius<best){match=p;best=d/p.radius;}}
  return match;
}
function runs(rows) {
  const out=[];
  for(const r of rows){const last=out.at(-1);if(last&&last.kind===r.kind&&last.zone===r.zone&&Math.abs(last.end-r.start)<1){last.end=r.end;last.rows.push(r);}else out.push({kind:r.kind,zone:r.zone,start:r.start,end:r.end,rows:[r]});}
  return out;
}
function simplify(points,tolerance=12) {
  if(points.length<3)return points;
  // Iterative radial simplification keeps time-order without recursion on long tracks.
  const out=[points[0]];for(let i=1;i<points.length-1;i++){if(distance(out.at(-1),points[i])>=tolerance)out.push(points[i]);}
  out.push(points.at(-1));return out;
}
export function analyzeChunks(chunks,options={}) {
  const settings={...DEFAULTS,...options.settings},pois=options.pois||[];
  let intervals=[];
  for(const chunk of chunks){
    for(let i=1;i<chunk.length;i++){
      const a=chunk[i-1],b=chunk[i],seconds=b[2]-a[2];if(seconds<=0)continue;
      const meters=distance(a,b),speed=meters/seconds*3.6;
      intervals.push({start:a[2],end:b[2],a,b,meters,seconds,speed,kind:seconds>settings.maxGapSeconds||speed>350?'unknown':'stay',zone:null});
    }
  }
  intervals.sort((a,b)=>a.start-b.start||b.end-a.end);
  // Overlapping segments must not double-count either movement or elapsed time.
  const rows=[];let lastEnd=-Infinity;
  for(const v of intervals){
    if(v.end<=lastEnd)continue;
    if(lastEnd!==-Infinity&&v.start>lastEnd)rows.push({start:lastEnd,end:v.start,seconds:v.start-lastEnd,meters:0,kind:'unknown',zone:null,a:rows.at(-1).b,b:v.a,speed:0});
    if(v.start<lastEnd){const fraction=(v.end-lastEnd)/(v.end-v.start);v.meters*=fraction;v.start=lastEnd;v.seconds=v.end-lastEnd;}
    rows.push(v);lastEnd=v.end;
  }
  for(let i=0;i<rows.length;i++){
    const row=rows[i];if(row.kind==='unknown')continue;
    const window=[];
    for(let j=Math.max(0,i-4);j<=Math.min(rows.length-1,i+4);j++){
      const candidate=rows[j];if(candidate.kind!=='unknown'&&Math.abs(candidate.start-row.start)<=90)window.push(candidate.speed);
    }
    const smooth=median(window);
    if(smooth>=settings.vehicleKmh)row.kind='drive';
    row.zone=nearestPoi(row.a,pois)?.name||null;
    row.smooth=smooth;
  }
  // Bridge short traffic-light pauses, while preserving long destination stops.
  let grouped=runs(rows);
  for(let i=1;i<grouped.length-1;i++){
    const g=grouped[i];
    if(g.kind==='stay'&&g.end-g.start<=120&&grouped[i-1].kind==='drive'&&grouped[i+1].kind==='drive')g.rows.forEach(r=>r.kind='drive');
  }
  // Non-vehicle time near a known destination becomes a visit only after sustained presence.
  for(const g of runs(rows)){
    if(g.kind!=='stay'||g.end-g.start<settings.minVisitMinutes*60)continue;
    if(g.zone){g.rows.forEach(r=>r.kind='visit');continue;}
    const path=g.rows.map(r=>r.a),lat=median(path.map(p=>p[0])),lon=median(path.map(p=>p[1]));
    const extent=Math.max(...path.map(p=>distance(p,[lat,lon])));
    // Sustained walking identifies a potential exploration area; stationary stops remain other stays.
    const moving=g.rows.filter(r=>r.speed>=1.2&&r.speed<settings.vehicleKmh).reduce((s,r)=>s+r.seconds,0);
    const walked=g.rows.filter(r=>r.speed<settings.vehicleKmh).reduce((s,r)=>s+r.meters,0);
    if(moving>=240&&walked>=250&&extent<=2000)g.rows.forEach(r=>r.kind='walk');
  }
  for(const row of rows){
    const override=(options.overrides||[]).find(v=>row.start>=Date.parse(v.start)/1000&&row.end<=Date.parse(v.end)/1000&&KINDS[v.kind]);
    if(override){row.kind=override.kind;row.zone=override.label||row.zone;row.manual=true;}
    if(row.kind==='drive'||row.kind==='unknown')row.zone=null;
  }
  grouped=runs(rows);
  // Merge stationary fragments into the adjacent named visit if they share its zone.
  for(let i=0;i<grouped.length;i++){
    const g=grouped[i];if(g.kind!=='stay'||g.end-g.start>120||!g.zone)continue;
    if([grouped[i-1],grouped[i+1]].some(v=>v?.kind==='visit'&&v.zone===g.zone))g.rows.forEach(r=>r.kind='visit');
  }
  const episodes=runs(rows).map((g,i)=>{
    const path=g.rows.flatMap((r,j)=>j?[r.b]:[r.a,r.b]);
    const center=[median(path.map(p=>p[0])),median(path.map(p=>p[1]))];
    const radius=Math.max(90,Math.min(2000,Math.max(...path.map(p=>distance(p,center)))));
    return {id:i,kind:g.kind,label:g.zone||KINDS[g.kind].label,start:g.start,end:g.end,seconds:g.end-g.start,
      meters:g.kind==='unknown'?0:g.rows.reduce((s,r)=>s+r.meters,0),path:g.kind==='unknown'?[]:simplify(path),center,radius,
      manual:g.rows.some(r=>r.manual),zone:g.zone};
  });
  const totals=Object.fromEntries(Object.keys(KINDS).map(k=>[k,{seconds:0,meters:0}]));
  for(const e of episodes){totals[e.kind].seconds+=e.seconds;totals[e.kind].meters+=e.meters;}
  return {episodes,totals,start:rows[0]?.start??null,end:rows.at(-1)?.end??null};
}

export function mergeAnalyses(analyses){
  // Disjoint files are common. Clip partial overlaps so totals reflect a union of time ranges.
  const source=analyses.flatMap(a=>a.episodes).sort((a,b)=>a.start-b.start||b.end-a.end),episodes=[];
  let end=-Infinity;
  for(const e of source){
    if(e.end<=end)continue;
    if(end!==-Infinity&&e.start>end)episodes.push({kind:'unknown',label:'파일 사이 기록 단절',start:end,end:e.start,seconds:e.start-end,meters:0,path:[],center:[],radius:0});
    const copy={...e};if(copy.start<end){const fraction=(copy.end-end)/copy.seconds;copy.start=end;copy.seconds=copy.end-end;copy.meters*=fraction;}episodes.push(copy);end=copy.end;
  }
  const totals=Object.fromEntries(Object.keys(KINDS).map(k=>[k,{seconds:0,meters:0}]));
  episodes.forEach(e=>{totals[e.kind].seconds+=e.seconds;totals[e.kind].meters+=e.meters;});
  return {episodes,totals,start:episodes[0]?.start??null,end:episodes.at(-1)?.end??null};
}

export function parseGPX(text){
  const xml=new DOMParser().parseFromString(text,'application/xml');if(xml.querySelector('parsererror'))throw new Error('올바른 GPX XML이 아닙니다.');
  const parents=[...xml.getElementsByTagNameNS('*','trkseg'),...xml.getElementsByTagNameNS('*','rte')];
  const segments=parents.length?parents:[xml.documentElement];
  const chunks=[];let pointCount=0;
  for(const segment of segments){
    const pts=[...segment.getElementsByTagNameNS('*','trkpt'),...segment.getElementsByTagNameNS('*','rtept')];const bins=new Map();
    for(const p of pts){pointCount++;const t=Date.parse(p.getElementsByTagNameNS('*','time')[0]?.textContent)/1000;const lat=Number(p.getAttribute('lat')),lon=Number(p.getAttribute('lon'));if(!Number.isFinite(t)||!Number.isFinite(lat+lon))continue;const key=Math.floor(t/15);if(!bins.has(key))bins.set(key,[]);bins.get(key).push([lat,lon,t]);}
    const sampled=[...bins.entries()].sort((a,b)=>a[0]-b[0]).map(([,ps])=>[median(ps.map(p=>p[0])),median(ps.map(p=>p[1])),median(ps.map(p=>p[2]))]);
    if(sampled.length>1)chunks.push(sampled);
  }
  if(!chunks.length)throw new Error('시각이 있는 GPX 경로가 없습니다.');
  return {chunks,pointCount};
}
