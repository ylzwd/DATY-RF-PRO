'use strict';
const {FilePort:BasePort,CHUNK}=require('../mqtt-stage5/file-port.cjs');
class FilePort extends BasePort {
  async upload(options){
    try{return await super.upload(options);}
    catch(error){
      // Only an export recipe may reuse consumed temporary bytes, to query its
      // SAME durable operation. Server exports.create compares the full intent
      // before returning an existing receipt; a missing operation cannot run
      // from a closed upload. No new upload or alternate operation is created.
      if(!options.allowConsumed||error.message!=='UPLOAD_NOT_WRITABLE')throw error;
      if(options.signal?.aborted)throw Error('TRANSFER_CANCELLED');
      const record=await this.client.call('uploads.status',{id:options.id});
      if(record.state!=='closed'||record.id!==options.id||record.bytes!==options.source.size||
          record.sha256!==await options.source.sha256())throw error;
      return record;
    }
  }
}
module.exports={FilePort,CHUNK};
