import { describe, expect, it, vi } from 'vitest';
import { isReadonly } from 'vue';
import { createAttentionRegistry } from '../attention.js';

describe('waiting-decision registry', () => {
  it('publishes and retracts readonly items and opens only the owned layer without navigating', async () => {
    const registry=createAttentionRegistry(), layer=vi.fn(async()=>true);
    const item={id:'request:one',kind:'plugin-access-request',owner:'p',label:'P: network access',open:layer};
    const release=registry.publish(item);
    expect(registry.items.value.map(({id,kind,owner,label})=>({id,kind,owner,label}))).toEqual([{id:item.id,kind:item.kind,owner:item.owner,label:item.label}]);
    expect(isReadonly(registry.items)).toBe(true); expect(isReadonly(registry.items.value[0])).toBe(true);
    expect(await registry.open(item.id)).toBe(true); expect(layer).toHaveBeenCalledExactlyOnceWith();
    const stale=registry.items.value[0];
    const replacement=vi.fn(async()=>true); registry.publish({...item,label:'Updated decision',open:replacement}); release();
    expect(await stale.open()).toBe(false); expect(replacement).not.toHaveBeenCalled();
    expect(registry.items.value).toHaveLength(1); await registry.items.value[0].open(); expect(replacement).toHaveBeenCalledOnce();
    expect(registry.retract(item.id)).toBe(true); expect(registry.items.value).toEqual([]);
    expect(await registry.open(item.id)).toBe(false);
  });
});
