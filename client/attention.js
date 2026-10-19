// SPDX-License-Identifier: LGPL-3.0-only
import { readonly, shallowRef } from 'vue';

/** Waiting decisions, not destinations. Sources own layer-opening admission. */
export function createAttentionRegistry() {
  const entries=new Map(), projection=shallowRef([]);
  const items=readonly(projection);
  function refresh() { projection.value=[...entries.values()].map(entry=>readonly({...entry.item,open:()=>open(entry.item.id,entry)})); }
  function retract(id) { const removed=entries.delete(id); if(removed) refresh(); return removed; }
  function publish({id,kind,owner,label,open:openLayer}) {
    if(!id || !kind || !owner || !label || typeof openLayer!=='function') throw Error('Attention items require id, kind, owner, label and a layer opener');
    const entry={item:{id,kind,owner,label,open:openLayer}};
    entries.set(id,entry); refresh();
    return ()=>{if(entries.get(id)===entry) retract(id);};
  }
  function open(id,expected=entries.get(id)) {
    const entry=entries.get(id);
    return entry && entry===expected ? entry.item.open() : false;
  }
  return {items,publish,retract,open};
}
export const attention=createAttentionRegistry();
