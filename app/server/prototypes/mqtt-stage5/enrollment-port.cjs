'use strict';
// Inject into ORIGINAL DatyAutoPair.create({request:...}). The HTTPS URL stays
// the private-key namespace and signed server identity; no HTTP request occurs.
function enrollmentPort({client,origin}) {
  const server=new URL(origin);
  if(server.protocol!=='https:'||server.port!=='8802'||server.pathname!=='/'||server.search||server.hash||server.username||server.password)throw Error('Invalid identity origin');
  return async function request(url,options={}) {
    const parsed=new URL(url), methods={'/api/receivers/challenge':'receivers.challenge','/api/receivers/enroll':'receivers.enroll'};
    if(parsed.origin!==server.origin||parsed.search||parsed.hash||parsed.username||parsed.password||!methods[parsed.pathname]||options.method!=='POST')throw Error('Enrollment route rejected');
    if(client.mode!=='enrollment')throw Error('Enrollment transport required');
    if(new URL(client.url).hostname!==server.hostname)throw Error('Enrollment server changed');
    if(options.signal?.aborted)throw Error('Enrollment cancelled');
    const abort=()=>client.stop();options.signal?.addEventListener('abort',abort,{once:true});
    try {
      if(parsed.pathname==='/api/receivers/challenge')await client.start();
      if(options.signal?.aborted)throw Error('Enrollment cancelled');
      const result=await client.call(methods[parsed.pathname],JSON.parse(options.body));
      if(options.signal?.aborted)throw Error('Enrollment cancelled');
      // Deliberately no durable or promise cache of the returned secret.
      return {ok:true,status:200,text:async()=>JSON.stringify(result)};
    } finally {options.signal?.removeEventListener('abort',abort);}
  };
}
module.exports={enrollmentPort};
