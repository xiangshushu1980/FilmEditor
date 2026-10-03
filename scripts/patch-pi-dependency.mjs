// Owner: Sean — SDK 0.86.0 shrinkwrap ignores root overrides; install the pinned compatible security patch.
import { cpSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const source=join(root,'node_modules/brace-expansion');
const target=join(root,'node_modules/@earendil-works/pi-coding-agent/node_modules/brace-expansion');
const read=path=>JSON.parse(readFileSync(path,'utf8'));
if(read(join(root,'node_modules/@earendil-works/pi-coding-agent/package.json')).version!=='0.86.0')
  throw new Error('Pi SDK version changed: review dependency patch before installing');
if(read(join(source,'package.json')).version!=='5.0.12')throw new Error('Expected pinned brace-expansion 5.0.12');
cpSync(source,target,{recursive:true,force:true});
// npm's installed inventory must describe the bytes actually installed, not the SDK's stale shrinkwrap.
const inventoryPath=join(root,'node_modules/.package-lock.json'),inventory=read(inventoryPath);
const patched=inventory.packages['node_modules/brace-expansion'];
if(!patched)throw new Error('Missing root brace-expansion inventory');
inventory.packages['node_modules/@earendil-works/pi-coding-agent/node_modules/brace-expansion']={...patched};
writeFileSync(inventoryPath,JSON.stringify(inventory,null,2)+'\n');
console.log('Owner: Sean — Pi SDK nested brace-expansion patched to 5.0.12');
