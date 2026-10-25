/* Pure list model shared by the four data views and future native views. */
(function(root,build){const api=build();if(typeof module==='object'&&module.exports)module.exports=api;else root.DatyDataManagement=api;
})(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';
  function search(rows,query,fields,predicate=()=>true){
    const terms=String(query||'').trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
    return rows.filter(row=>predicate(row)&&(!terms.length||terms.every(term=>fields.map(key=>String(row[key]??'')).join(' ').toLocaleLowerCase().includes(term))));
  }
  function paginate(rows,page=1,size=20){
    if(!Number.isSafeInteger(size)||size<1)throw TypeError('Invalid page size');
    const pages=Math.max(1,Math.ceil(rows.length/size)),selected=Math.min(pages,Math.max(1,Number.isSafeInteger(page)?page:1));
    return {items:rows.slice((selected-1)*size,selected*size),total:rows.length,page:selected,pages,size};
  }
  return Object.freeze({search,paginate});
});
