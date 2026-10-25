'use strict';
const CHUNK=128*1024;
// Inject file IO/hash/base64. Native hosts stream into a temporary destination
// and publish to the user's destination only after the complete SHA256 matches.
class FilePort {
  constructor({client,sha256,encode64,decode64,uuid}) {Object.assign(this,{client,sha256,encode64,decode64,uuid});}
  async upload({id,source,mediaType='text/plain',resume=false,signal}) {
    const check=()=>{if(signal?.aborted)throw Error('TRANSFER_CANCELLED');};
    check();const bytes=source.size,sha=await source.sha256();
    let record=resume?await this.client.call('uploads.status',{id}):await this.client.call('uploads.begin',{
      operation_id:id,bytes,sha256:sha,media_type:mediaType});
    if(record.id!==id||record.bytes!==bytes||record.sha256!==sha)throw Error('UPLOAD_IDENTITY_MISMATCH');
    if(record.state==='ready')return record;
    if(record.state!=='uploading')throw Error('UPLOAD_NOT_WRITABLE');
    if(!Number.isSafeInteger(record.offset)||record.offset<0||record.offset>bytes||(record.offset%CHUNK&&record.offset!==bytes))throw Error('INVALID_RESUME_OFFSET');
    for(let offset=record.offset;offset<bytes;offset+=CHUNK) {
      check();const chunk=await source.read(offset,Math.min(CHUNK,bytes-offset));
      if(chunk.length!==Math.min(CHUNK,bytes-offset))throw Error('SOURCE_CHANGED');
      const result=await this.client.call('uploads.chunk',{upload_id:id,offset,sha256:await this.sha256(chunk),data:this.encode64(chunk)});
      if(result.id!==id||result.sha256!==sha||result.offset!==offset+chunk.length)throw Error('UPLOAD_ACK_MISMATCH');
    }
    check();record=await this.client.call('uploads.finish',{upload_id:id,sha256:sha});
    if(record.id!==id||record.bytes!==bytes||record.state!=='ready'||record.sha256!==sha)throw Error('UPLOAD_NOT_VERIFIED');
    return record;
  }
  async download({descriptor,sink,signal,resume=false}) {
    const id=descriptor.id,sha=descriptor.sha256;
    let offset=resume?await sink.resume({id,bytes:descriptor.bytes,sha256:sha}):0;
    if(!Number.isSafeInteger(offset)||offset<0||offset>descriptor.bytes||(offset%CHUNK&&offset!==descriptor.bytes))throw Error('INVALID_RESUME_OFFSET');
    try {
      while(offset<descriptor.bytes) {
        if(signal?.aborted)throw Error('TRANSFER_CANCELLED');
        const part=await this.client.call('downloads.chunk',{download_id:id,offset,sha256:sha}),raw=this.decode64(part.data);
        if(part.download_id!==id||part.file_sha256!==sha||part.offset!==offset||part.bytes!==raw.length||
           raw.length!==Math.min(CHUNK,descriptor.bytes-offset)||await this.sha256(raw)!==part.sha256||part.eof!==(offset+raw.length===descriptor.bytes))throw Error('DOWNLOAD_CHUNK_MISMATCH');
        await sink.write(offset,raw);offset+=raw.length;
      }
      if(signal?.aborted)throw Error('TRANSFER_CANCELLED');
      if(await sink.sha256()!==sha||await sink.size()!==descriptor.bytes)throw Error('DOWNLOAD_DIGEST_MISMATCH');
      await sink.commit({id,sha256:sha,bytes:descriptor.bytes});
      return {id,sha256:sha,bytes:descriptor.bytes,state:'saved'};
    } catch(error) {await sink.suspend?.();throw error;}
  }
}
module.exports={FilePort,CHUNK};
