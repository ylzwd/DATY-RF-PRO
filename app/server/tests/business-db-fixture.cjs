'use strict';
const crypto=require('node:crypto');
const clone=value=>JSON.parse(JSON.stringify(value));
const response=(body,status=200)=>({status,ok:status>=200&&status<300,json:async()=>clone(body)});
function fixture(){
  const memory=new Map(),resources=new Map(),receipts=new Map(),requests=[];
  const state={epoch:'fixture-database-epoch-1',asOf:0,rejectNext:null,dropReply:false};
  const scope={baseUrl:'https://127.0.0.1:8802',accessRevision:1,principalId:'fixture-public-operator'};
  const envelope=()=>({protocol:'daty-business-db-v1',epoch:state.epoch,schema_version:1,instance_id:'fixture-database'});
  const storage={getItem:key=>memory.get(key)??null,setItem:(key,value)=>memory.set(key,value),removeItem:key=>memory.delete(key)};
  function put(kind,id,value,revision=1){resources.set(JSON.stringify([kind,id]),{kind,id,value:clone(value),revision,deleted:false});}
  function handle(url,options={}){
    const parsed=new URL(url),path=parsed.pathname;requests.push({url,options});
    if(path==='/api/database/status')return response({success:true,...envelope()});
    if(path==='/api/database/resources'){
      const project=parsed.searchParams.get('project_id');
      return response({success:true,...envelope(),resources:[...resources.values()].filter(item=>item.kind===parsed.searchParams.get('kind')&&(!project||item.value?.projectId===project)),next_cursor:null,as_of:state.asOf,project_id:project,since:parsed.searchParams.has('since')?Number(parsed.searchParams.get('since')):null});
    }
    if(path.startsWith('/api/database/resources/')){
      const [,kind,id]=path.match(/^\/api\/database\/resources\/([^/]+)\/(.+)$/),resource=resources.get(JSON.stringify([decodeURIComponent(kind),decodeURIComponent(id)]));
      return resource?response({success:true,...envelope(),resource}):response({success:false,...envelope(),code:'RESOURCE_NOT_FOUND'},404);
    }
    if(path.startsWith('/api/database/operations/')){
      const operation=receipts.get(decodeURIComponent(path.slice('/api/database/operations/'.length)));
      return operation?response({success:true,...envelope(),operation}):response({success:false,...envelope(),code:'OPERATION_NOT_FOUND'},404);
    }
    if(!['/api/database/write','/api/database/batch'].includes(path))throw Error('Fixture refuses all other network: '+url);
    if(state.rejectNext){const reject=state.rejectNext;state.rejectNext=null;return response({success:false,...envelope(),code:reject},409);}
    const body=JSON.parse(options.body),batch=path.endsWith('/batch'),writes=batch?body.writes:[body];
    if(body.epoch!==state.epoch)return response({success:false,...envelope(),code:'DATABASE_EPOCH_CHANGED'},409);
    if(writes.some(item=>(resources.get(JSON.stringify([item.kind,item.id]))?.revision||0)!==item.expected_revision))return response({success:false,...envelope(),code:'RESOURCE_REVISION_CONFLICT'},409);
    const committed=writes.map(item=>({kind:item.kind,id:item.id,revision:item.expected_revision+1,value:clone(item.value),deleted:item.deleted}));
    committed.forEach(item=>resources.set(JSON.stringify([item.kind,item.id]),clone(item)));state.asOf++;
    const fields=batch?{resources:committed}:{resource:committed[0]};
    receipts.set(body.operation_id,{operation_id:body.operation_id,status:'committed',...clone(fields)});
    if(state.dropReply){state.dropReply=false;return Promise.reject(Error('fixture commit reply lost'));}
    return response({success:true,...envelope(),operation_id:body.operation_id,...fields});
  }
  const ports={storage,readScope:()=>scope,schedule:setTimeout,cancel:clearTimeout,newOperationId:()=>crypto.randomUUID(),request:(...args)=>handle(...args)};
  return {memory,resources,receipts,requests,state,scope,storage,ports,handle,put,envelope};
}
module.exports={fixture,response,clone};
