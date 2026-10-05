#!/usr/bin/env node
// Owner: Sean — one-time installation; PI user directory is the runtime canonical source.
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {mkdirSync,readdirSync,readFileSync,writeFileSync,existsSync,lstatSync,symlinkSync,realpathSync} from 'node:fs';
import {createHash} from 'node:crypto';
const source=path.join(path.dirname(fileURLToPath(import.meta.url)),'skill-templates'),destination=path.join(os.homedir(),'.pi/agent/skills'),codex=path.join(os.homedir(),'.codex/skills');
const names=['film-production','film-script','film-shot-planning','film-feedback'];
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
function files(dir,prefix=''){return readdirSync(dir,{withFileTypes:true}).flatMap(entry=>entry.isDirectory()?files(path.join(dir,entry.name),path.join(prefix,entry.name)):[path.join(prefix,entry.name)]);}
// Validate every destination before writing so conflicting local customizations remain untouched.
for(const name of names){for(const file of files(path.join(source,name))){const dest=path.join(destination,name,file);if(existsSync(dest)&&sha(readFileSync(dest))!==sha(readFileSync(path.join(source,name,file))))throw new Error(`Existing PI skill differs: ${dest}; review instead of overwriting`);}const link=path.join(codex,name);if(existsSync(link)&&(!lstatSync(link).isSymbolicLink()||realpathSync(link)!==path.join(destination,name)))throw new Error(`Existing Codex resource is not the PI link: ${link}`);}
mkdirSync(destination,{recursive:true});mkdirSync(codex,{recursive:true});const installed=[];
for(const name of names){for(const file of files(path.join(source,name))){const dest=path.join(destination,name,file);mkdirSync(path.dirname(dest),{recursive:true});if(!existsSync(dest))writeFileSync(dest,readFileSync(path.join(source,name,file)),{flag:'wx'});}const link=path.join(codex,name);if(!existsSync(link))symlinkSync(path.join(destination,name),link,'dir');installed.push({name,canonicalPath:path.join(destination,name),codexLink:link});}
console.log(JSON.stringify({owner:'Sean',installed,note:'Templates are install seeds only. Future user-level changes belong to the PI canonical directories; never overwrite customizations automatically.'}));
