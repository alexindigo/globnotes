<!-- SPDX-License-Identifier: LGPL-3.0-only -->
<template>
  <Modal :model-value="open" name="identity" anchor="dialog" trap-focus :labelledby="titleId" :close-handler-override="cancel" class="identity-dialog settings-text" :class="wide ? '!max-w-[720px]' : '!max-w-[500px]'">
    <header class="flex items-center justify-between gap-4 border-b border-theme-border px-6 py-4"><h2 :id="titleId" class="settings-heading min-w-0 truncate font-semibold">{{ title }}</h2><CustomButton type="button" :icon-path="tabClose" title="Close" aria-label="Close" variant="text" text-tone="normal" @click="cancel" /></header>
    <div class="flex min-w-0 flex-col gap-6 p-6"><slot /></div>
  </Modal>
</template>
<script setup>
import { createUuid } from '../../shared/uuid.ts';
import Modal from './Modal.vue';
import CustomButton from './CustomButton.vue';
import { tabClose } from '../icons.js';
defineProps({ open:Boolean, title:String, cancel:Function, wide:Boolean });
const titleId = `identity-dialog-${createUuid()}`;
</script>
