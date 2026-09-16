import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const sourcePath='scripts/research-5m-microstructure-events.mjs';
let src=readFileSync(sourcePath,'utf8');
const oldTrade="function trade(e,hold,orientation,cost){const rows=raw.get(e.symbol),map=new Map(rows.map(r=>[r.time,r])),en=map.get(e.t+STEP),ex=map.get(e.t+(hold+1)*STEP);if(!en||!ex)return null;const gross=orientation*e.dir*(ex.mark/en.mark-1);return {...e,hold,orientation,entryTime:en.time,exitTime:ex.time,gross,net:gross-cost};}";
const newTrade="const tradeMaps=new Map([...raw].map(([symbol,rows])=>[symbol,new Map(rows.map(r=>[r.time,r]))]));\nfunction trade(e,hold,orientation,cost){const map=tradeMaps.get(e.symbol);if(!map)return null;const en=map.get(e.t+STEP),ex=map.get(e.t+(hold+1)*STEP);if(!en||!ex)return null;const gross=orientation*e.dir*(ex.mark/en.mark-1);return {...e,hold,orientation,entryTime:en.time,exitTime:ex.time,gross,net:gross-cost};}";
if(!src.includes(oldTrade))throw new Error('expected trade() implementation not found; refusing non-equivalent patch');
src=src.replace(oldTrade,newTrade);
const tmp='/tmp/research-5m-microstructure-events-fast-runtime.mjs';
writeFileSync(tmp,src);
await import(`${pathToFileURL(tmp).href}?run=${Date.now()}`);
