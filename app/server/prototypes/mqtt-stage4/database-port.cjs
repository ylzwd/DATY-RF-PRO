/* Inject into existing repositories: same response DTO, MQTT-only network.
 * Host owns existing confirmations, recovery storage and connection generations.
 */
'use strict';
const copy=x=>JSON.parse(JSON.stringify(x));
function route(url,verb) {
  const query={};
  for(const [key,value] of url.searchParams){if(Object.hasOwn(query,key))throw Error('DUPLICATE_QUERY');query[key]=value;}
  if(query.limit!==undefined){if(!/^\d{1,3}$/.test(query.limit))throw Error('INVALID_LIMIT');query.limit=Number(query.limit);}
  if(query.since!==undefined){if(!/^\d{1,16}$/.test(query.since)||!Number.isSafeInteger(Number(query.since)))throw Error('INVALID_SINCE');query.since=Number(query.since);}
  for(const key of ['from_ms','to_ms'])if(query[key]!==undefined){if(!/^\d{1,16}$/.test(query[key])||!Number.isSafeInteger(Number(query[key])))throw Error('INVALID_TIME');query[key]=Number(query[key]);}
  const p=url.pathname;
  const gets={
    '/api/database/activity':'database.activity.list',
    '/api/database/catalog':'database.catalog',
    '/api/database/status':'database.status','/api/database/resources':'database.resources.list',
    '/api/database/channels':'database.channels','/api/database/overview':'database.overview',
    '/api/database/draft':'database.draft.get','/api/database/business-snapshot':'database.business_snapshot',
    '/api/projects':'projects.list','/api/timeline':'timeline.list','/api/discovery/shure/status':'discovery.status',
    '/health':'state.health','/api/stats':'state.stats','/api/capabilities':'state.capabilities','/api/clock':'state.clock'};
  if(verb==='GET') {
    if(gets[p])return {method:gets[p],body:query};
    if(Object.keys(query).length)throw Error('INVALID_QUERY');
    let match=p.match(/^\/api\/database\/activity\/(operations|timeline|live)\/(\d{1,16})$/);
    if(match){if(!Number.isSafeInteger(Number(match[2])))throw Error('INVALID_ID');return {method:'database.activity.get',body:{source:match[1],id:Number(match[2])}};}
    match=p.match(/^\/api\/database\/resources\/([^/]+)\/([^/]+)$/);
    if(match)return {method:'database.resources.get',body:{kind:decodeURIComponent(match[1]),id:decodeURIComponent(match[2])}};
    match=p.match(/^\/api\/database\/operations\/([A-Za-z0-9_-]{16,80})$/);
    if(match)return {method:'database.operations.get',body:{operation_id:match[1]}};
    match=p.match(/^\/api\/mqtt-data\/operations\/([A-Za-z0-9_-]{16,80})$/);
    if(match)return {method:'operations.get',body:{operation_id:match[1]}};
    match=p.match(/^\/api\/projects\/([^/]+)$/);
    if(match)return {method:'projects.get',body:{id:decodeURIComponent(match[1])}};
  }
  const posts={'/api/database/write':'database.write','/api/database/batch':'database.batch',
    '/api/database/draft':'database.draft.save','/api/database/browser-import/preview':'database.import.preview',
    '/api/database/browser-import/commit':'database.import.commit','/api/projects':'projects.save',
    '/api/coordination-runs':'planning.run.create','/api/timeline/events':'timeline.append',
    '/api/discovery/shure/scan':'discovery.scan','/api/discovery/shure/cancel':'discovery.cancel'};
  if(verb==='POST'&&posts[p]&&!Object.keys(query).length)return {method:posts[p]};
  throw Error('ROUTE_OUTSIDE_M4');
}
function createRequestPort({client,baseUrl}) {
  const base=new URL(baseUrl);
  if(base.protocol!=='https:'||base.username||base.password||base.pathname!=='/'||base.search||base.hash)throw Error('INVALID_ORIGIN');
  return function request(input,options={}) {
    const address=new URL(input);
    if(address.origin!==base.origin||address.username||address.password||address.hash)throw Error('SERVER_CHANGED');
    const verb=options.method||'GET', mapped=route(address,verb);
    if(verb==='POST')mapped.body=JSON.parse(options.body);
    const write=verb==='POST'&&mapped.method!=='database.import.preview';
    if(write&&(!mapped.body?.operation_id||!mapped.body?.epoch))throw Error('OPERATION_AND_EPOCH_REQUIRED');
    if(options.signal?.aborted)return Promise.reject(Error('ABORTED_QUERY_ONLY'));
    return new Promise((resolve,reject)=>{
      let done=false;
      const finish=(error,result)=>{if(done)return;done=true;options.signal?.removeEventListener('abort',abort);error?reject(error):resolve(result);};
      const abort=()=>finish(Error('ABORTED_QUERY_ONLY'));
      options.signal?.addEventListener('abort',abort,{once:true});
      const pending=write?client.write(mapped.method,mapped.body):client.call(mapped.method,mapped.body);
      pending.then(result=>{
        if(!result||!Number.isInteger(result.status)||!result.body||typeof result.body!=='object')return finish(Error('INVALID_DATA_REPLY'));
        const value=copy(result.body);finish(null,{status:result.status,ok:result.status>=200&&result.status<300,
          json:async()=>copy(value),text:async()=>JSON.stringify(value)});
      },error=>{
        if(error.status&&error.status<500)finish(null,{status:error.status,ok:false,json:async()=>({success:false,code:error.code}),text:async()=>JSON.stringify({success:false,code:error.code})});
        else finish(error);
      });
    });
  };
}
module.exports={createRequestPort,route};
