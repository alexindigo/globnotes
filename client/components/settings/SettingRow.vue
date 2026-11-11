<!-- SPDX-License-Identifier: LGPL-3.0-only -->
<template>
  <div class="setting-row settings-text" :class="{ 'setting-row-short': short || form, 'setting-row-form': form, 'setting-row-truncate-label': truncateLabel }">
    <div class="setting-row-copy">
      <div class="setting-row-label"><slot name="label" :id="labelId"><component :is="as==='value'?'span':'label'" :id="labelId" :for="as==='value'?undefined:controlId" :title="label">{{ label }}</component></slot><slot name="value" /></div>
      <p v-if="help || $slots.help" :id="helpId" class="settings-help"><span><slot name="help">{{ help }}</slot></span></p>
      <p v-if="pin" :id="pinId" role="note" class="settings-help"><span>{{ pin }}</span></p>
      <p v-if="error" :id="errorId" role="alert" class="settings-help text-theme-danger"><span>{{ error }}</span></p>
    </div>
    <div class="setting-row-control"><slot :id="controlId" :labelledby="labelId" :describedby="describedby()" :invalid="error ? true : undefined" /></div>
  </div>
</template>
<script setup>
import { computed, useSlots } from 'vue';
import { createUuid } from '../../../shared/uuid.ts';
const props = defineProps({ id:String, label:String, help:String, pin:String, error:String, short:Boolean, form:Boolean, truncateLabel:Boolean, as:{type:String,default:'control',validator:value=>['control','value'].includes(value)} });
const identity = `setting-${createUuid()}`;
const slots = useSlots();
const controlId = computed(() => props.id || identity), labelId = `${identity}-label`;
const helpId = `${identity}-help`, pinId = `${identity}-pin`, errorId = `${identity}-error`;
const describedby = () => [(props.help || slots.help) && helpId, props.pin && pinId, props.error && errorId].filter(Boolean).join(' ') || undefined;
</script>
<style scoped>
.setting-row { display:flex; flex-direction:column; gap:0.5rem; min-width:0; }
.setting-row-copy { min-width:0; }
.setting-row-label { display:flex; align-items:baseline; justify-content:space-between; gap:1rem; }
.setting-row-label > :first-child { min-width:0; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
p { margin-top:0.25rem; max-width:65ch; }
p > span { display:block; max-width:65ch; }
.setting-row-control { min-width:0; }
.setting-row-short { flex-direction:row; flex-wrap:wrap; align-items:center; column-gap:1rem; }
.setting-row-short .setting-row-copy { display:contents; }
.setting-row-short .setting-row-label { flex:1 1 min-content; min-width:0; max-width:100%; }
.setting-row-short.setting-row-truncate-label .setting-row-label { flex-basis:0; }
.setting-row-short .setting-row-control { display:flex; align-items:center; flex:0 1 auto; max-width:100%; margin-inline-start:auto; }
.setting-row-short .setting-row-copy > p { flex:1 0 100%; order:1; max-width:none; }
p:not([role="alert"]) { color:rgb(var(--theme-text-muted)); }
.setting-row-form .setting-row-control { flex-basis:24rem; width:24rem; justify-content:flex-end; }
</style>
