/* Direct HTTPS database connection. Source identifies the actual network peer,
 * never an authenticated operator. No device commands or automatic write replay. */
(function(root){
  'use strict';
  function mount(global){
    if(global.DatyDatabaseConnection)return global.DatyDatabaseConnection;
    let origin=null,platform=null,source=null,revision=0,status=null,flight=null,disposed=false;
    const listeners=new Set();
    function target(){return global.DatyPlatformFactory.normalizeBridgeUrl(global.planningProjectApiBase());}
    function emit(){for(const fn of [...listeners])try{fn();}catch(error){global.console?.error(error);}}
    function synchronize(){
      const next=target();
      if(origin!==next||platform!==global.DatyPlatform){origin=next;platform=global.DatyPlatform;source=null;status=null;revision++;emit();}
    }
    function snapshot(){synchronize();return {origin,revision,source:source?{...source}:null,status:status?{...status}:null};}
    function assertConnected(){synchronize();if(disposed||!source)throw Error('服务器数据库尚未连接');}
    async function request(url,options){
      assertConnected();const destination=new URL(url);
      if(destination.origin!==origin||destination.username||destination.password)throw Error('数据库请求目标与当前服务器不一致');
      return platform.request(url,options);
    }
    async function connect(){
      synchronize();if(disposed)throw Error('页面已关闭');
      if(flight?.origin===origin&&flight.platform===platform)return flight.promise;
      const captured={origin,platform,revision};
      captured.promise=(async()=>{
        const response=await captured.platform.request(captured.origin+'/api/database/status',{cache:'no-store',signal:AbortSignal.timeout(10000)});
        const value=await response.json();synchronize();
        if(disposed||captured.origin!==origin||captured.platform!==platform||captured.revision!==revision)throw Error('服务器连接已变化');
        if(!response.ok||value.success!==true||value.protocol!=='daty-business-db-v1'||value.control_protocol!=='daty-direct-control-v1'
          ||value.storage_source?.kind!=='network-peer'||value.storage_source.authenticated!==false||typeof value.storage_source.id!=='string')throw Error(value.error||'服务器尚未提供数据库持久保存');
        if(source?.id!==value.storage_source.id||status?.epoch!==value.epoch){revision++;source={...value.storage_source};status=value;emit();}else status=value;
        return snapshot();
      })().finally(()=>{if(flight===captured)flight=null;});flight=captured;return captured.promise;
    }
    const api=Object.freeze({VERSION:'daty-database-connection-v1',snapshot,assertConnected,connect,request,
      subscribe(fn){listeners.add(fn);return()=>listeners.delete(fn);}});
    global.DatyDatabaseConnection=api;
    global.addEventListener?.('pagehide',()=>{disposed=true;source=null;revision++;emit();listeners.clear();},{once:true});
    return api;
  }
  root.DatyDatabaseConnectionFactory=Object.freeze({mount});
})(globalThis);
