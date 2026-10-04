// Owner: Sean — distinct variants, immutable exact retries and actual workflow seeds.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {candidateSamplingInput} from './candidate-input.mjs';
import {graph} from './comfy.mjs';
const source=()=>({shotHash:'current',shot:{seed:42,prompt:'current narrative',durationSec:4},render:{width:1024,height:576}});
const noise=input=>graph(input,{images:[],voices:[]},'test')['10'].inputs.noise_seed;
test('same narrative gets distinct workflow noise while remaining selectable under its original hash',()=>{
  const input=source(),first=candidateSamplingInput(input,[]),second=candidateSamplingInput(input,[{input:first}],{random:()=>42});
  assert.equal(noise(first),42);assert.equal(noise(second),43);
  assert.equal(second.shotHash,first.shotHash);assert.deepEqual(second.shot,first.shot);assert.equal(input.samplingSeed,undefined);
  const third=candidateSamplingInput(input,[{input:first},{input:second}],{random:()=>42});assert.equal(noise(third),44);
});
test('exact retry preserves frozen input bytes and workflow seed, including legacy candidates',()=>{
  for(const frozen of [source(),candidateSamplingInput(source(),[{input:source()}],{random:()=>88})]) {
    const before=JSON.stringify(frozen),parent={input:frozen};
    const retried=candidateSamplingInput(source(),[parent],{retryExact:true,parent,random:()=>{throw new Error('must not sample');}});
    assert.equal(retried,frozen);assert.equal(JSON.stringify(retried),before);assert.equal(noise(retried),noise(frozen));
  }
});
test('edited input first uses its configured seed and variant collisions wrap within the accepted range',()=>{
  const input=source(),old={input:{...input,shotHash:'obsolete'}};
  assert.equal(noise(candidateSamplingInput(input,[old])),42);
  const max={input:{...input,samplingSeed:2**32-1}};
  assert.equal(noise(candidateSamplingInput(input,[max],{random:()=>2**32-1})),0);
});
