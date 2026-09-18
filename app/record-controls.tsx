"use client";
export function ArchivePagination({page,pages,onPage}:{page:number;pages:number;onPage:(n:number)=>void}) {
  if(pages<=1)return null;
  return <nav className="fr-record-pages" aria-label="归档分页"><button className="fr-button secondary" disabled={page===0} onClick={()=>onPage(page-1)}>上一页</button><span>{page+1} / {pages}</span><button className="fr-button secondary" disabled={page+1>=pages} onClick={()=>onPage(page+1)}>下一页</button></nav>;
}