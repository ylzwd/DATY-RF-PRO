'use strict';
// In-memory reviewed frontend bytes, not a deployment or asset allow-list.
const fs=require('node:fs'),crypto=require('node:crypto'),path=require('node:path');
const root=path.resolve(__dirname,'..');
const assets=['src/platform/database-client.js','src/platform/database-batch-client.js','src/platform/business-repository.js','src/app/business-database.js'];
function prepare(){
  const candidate=require('../scripts/c2-candidate.cjs').prepare();
  for(const name of fs.readdirSync(path.join(root,'patches')).filter(name=>/^udb-front-.*\.json$/.test(name)).sort()){
    const patch=JSON.parse(fs.readFileSync(path.join(root,'patches',name),'utf8')),raw=fs.readFileSync(path.join(root,patch.source));
    if(crypto.createHash('sha256').update(raw).digest('hex')!==patch.sourceSha256)throw Error('Original source SHA mismatch: '+name);
    let source=(candidate.files.get(patch.source)||raw).toString('utf8').replace(/\r\n/g,'\n');
    for(const change of patch.changes){if(source.split(change.before).length!==2)throw Error('Candidate anchor is not unique: '+name+'/'+change.id);source=source.replace(change.before,change.after);}
    candidate.files.set(patch.source,Buffer.from(source));
  }
  for(const asset of assets)candidate.files.set(asset,fs.readFileSync(path.join(root,asset)));
  return candidate;
}
module.exports={root,assets,prepare};
