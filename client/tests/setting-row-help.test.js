import { afterEach, expect, it } from 'vitest';
import { enableAutoUnmount, mount } from '@vue/test-utils';
import SettingRow from '../components/settings/SettingRow.vue';
enableAutoUnmount(afterEach);
it.each([false,true])('updates description IDs when a help slot changes (initial %s)', async initial => {
  const wrapper=mount({components:{SettingRow},data:()=>({show:initial}),template:'<SettingRow label="Name" pin="Pinned" error="Invalid"><template v-if="show" #help>Current help</template><template #default="{id,describedby}"><input :id="id" :aria-describedby="describedby"></template></SettingRow>'});
  const check=shown=>{
    const descriptions=wrapper.get('input').attributes('aria-describedby').split(' ');
    const paragraphs=wrapper.findAll('p');
    expect(descriptions).toEqual(paragraphs.map(p=>p.attributes('id')));
    expect(paragraphs.map(p=>p.text())).toEqual(shown?['Current help','Pinned','Invalid']:['Pinned','Invalid']);
  };
  check(initial);await wrapper.setData({show:!initial});check(!initial);await wrapper.setData({show:initial});check(initial);
});
