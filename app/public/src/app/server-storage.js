/* Data history retired. Settings/devices still use their transactional adapter. */
(function(g){
  'use strict';let ready=false;
  const retired=()=>Promise.reject(Object.assign(Error('该数据历史功能已停用'),{code:'DATA_FEATURE_RETIRED'}));
  async function bootstrap(){
    if(g.DatyFreshStart?.error)throw Error(g.DatyFreshStart.error);
    if(g.DatyFreshStart&&g.DatyFreshStart.epoch!==g.DatyDatabaseConnection.snapshot().status?.epoch)throw Error('数据库已变化，请刷新页面');
    g.DatyBusinessDatabaseFactory.mount(g);await g.DatyBusinessDatabase.hydrate();ready=true;
  }
  g.DatyServerStorage=Object.freeze({VERSION:'daty-server-storage-retired-v1',bootstrap,
    refresh:retired,createArchive:retired,resumeArchive:retired,clearArchiveFiles:retired,archiveText:retired,archiveBrowserCache:retired,businessSnapshot:retired,
    saveDraft:async()=>false,isCacheArchived:()=>false,get legacyArchived(){return true;},get ready(){return ready;}});
})(globalThis);
