// Owner: Sean — vary candidate sampling without changing the approved story input.
import {randomInt} from 'node:crypto';
export function candidateSamplingInput(input,previous,{retryExact=false,parent,random=()=>randomInt(2**32)}={}) {
  if(retryExact)return parent.input;
  const matching=previous.filter(c=>c.input.shotHash===input.shotHash);
  if(!matching.length)return {...input,samplingSeed:input.shot.seed,seedPolicy:'configured'};
  const used=new Set(matching.map(c=>c.input.samplingSeed??c.input.shot.seed));
  let seed=random();
  while(used.has(seed))seed=(seed+1)%2**32;
  return {...input,samplingSeed:seed,seedPolicy:'variation'};
}
