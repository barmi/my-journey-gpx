import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { analyzeChunks, mergeAnalyses } from '../src/analysis.js';
const base=Date.parse('2026-11-06T08:00:00Z')/1000;
function straight(minutes,kmh=0,lat=37,lon=-6,start=base){
  return Array.from({length:minutes*4+1},(_,i)=>[lat,lon+i*15*kmh/3600/(111.32*Math.cos(lat*Math.PI/180)),start+i*15]);
}
test('a vehicle leg includes a short traffic stop',()=>{
  const a=straight(10,50),b=straight(1,0,a.at(-1)[0],a.at(-1)[1],a.at(-1)[2]),c=straight(10,50,b.at(-1)[0],b.at(-1)[1],b.at(-1)[2]);
  const r=analyzeChunks([[...a,...b.slice(1),...c.slice(1)]]);assert.ok(r.totals.drive.seconds>=1200);assert.equal(Object.values(r.totals).reduce((s,v)=>s+v.seconds,0),1260);
});
test('a stationary destination visit differs from an unlabelled rest stop',()=>{
  const p=straight(30),visit=analyzeChunks([p],{pois:[{name:'대성당',lat:37,lon:-6,radius:500}]});
  assert.equal(visit.totals.visit.seconds,1800);assert.equal(visit.totals.drive.seconds,0);
  const rest=analyzeChunks([p]);assert.equal(rest.totals.visit.seconds,0);assert.equal(rest.totals.stay.seconds,1800);
});
test('walking outside a destination is exploration, not a confirmed visit',()=>{
  const r=analyzeChunks([straight(15,4)]);assert.equal(r.totals.walk.seconds,900);assert.equal(r.totals.visit.seconds,0);
});
test('recording gaps and impossible jumps are excluded',()=>{
  const p=straight(5);p.push([37,-6,base+3600]);p.push([40,5,base+3601]);const r=analyzeChunks([p]);assert.equal(r.totals.unknown.seconds,3301);assert.equal(r.totals.drive.seconds,0);
});
test('manual corrections override inferred labels',()=>{
  const r=analyzeChunks([straight(10)],{overrides:[{start:new Date(base*1000).toISOString(),end:new Date((base+600)*1000).toISOString(),kind:'visit',label:'직접 확인한 관람'}]});
  assert.equal(r.totals.visit.seconds,600);assert.equal(r.episodes[0].label,'직접 확인한 관람');assert.equal(r.episodes[0].manual,true);
});
test('overlapping files do not double-count time',()=>{
  const a=analyzeChunks([straight(20,40)]),b=analyzeChunks([straight(20,40,37,-6,base+600)]);assert.equal(mergeAnalyses([a,b]).totals.drive.seconds,1800);
});
test('time between disjoint files is explicitly marked as unrecorded',()=>{
  const a=analyzeChunks([straight(10,40)]),b=analyzeChunks([straight(10,40,37,-6,base+1200)]);
  const merged=mergeAnalyses([a,b]);assert.equal(merged.totals.unknown.seconds,600);assert.equal(merged.totals.drive.seconds,1200);
});
test('bundled records conserve elapsed time and have finite non-negative measurements',()=>{
  const siteDir=process.env.JOURNEY_SITE_DIR||'dist';
  if(!fs.existsSync(`${siteDir}/data/index.json`))return;
  const index=JSON.parse(fs.readFileSync(`${siteDir}/data/index.json`));
  const sourceCount=fs.readdirSync('data/gpx',{recursive:true}).filter(name=>name.toLowerCase().endsWith('.gpx')).length;
  assert.equal(index.buildPolicy.sourceFiles,sourceCount);
  assert.ok(index.counts.files<=sourceCount);
  if(index.buildPolicy.recentLimit!==null)assert.ok(index.counts.files<=index.buildPolicy.recentLimit);
  assert.equal(index.counts.files,index.records.length);
  assert.equal(index.counts.empty,index.records.filter(r=>r.group==='empty').length);
  assert.equal(index.counts.duplicates,index.records.filter(r=>r.duplicateOf).length);
  const includedIds=new Set(index.records.map(r=>r.id));
  for(const r of index.records)if(r.duplicateOf)assert.ok(includedIds.has(r.duplicateOf));
  for(const record of index.records.filter(r=>r.group!=='empty'&&!r.duplicateOf)){
    const p=JSON.parse(fs.readFileSync(`${siteDir}/data/records/${record.id}.json`)),r=analyzeChunks(p.chunks);if(r.start===null)continue;
    assert.equal(Object.values(r.totals).reduce((s,v)=>s+v.seconds,0),r.end-r.start,record.name);
    for(const v of Object.values(r.totals)){assert.ok(Number.isFinite(v.seconds)&&v.seconds>=0);assert.ok(Number.isFinite(v.meters)&&v.meters>=0);}
  }
});
