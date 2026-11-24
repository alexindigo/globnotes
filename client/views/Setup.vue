<!-- SPDX-License-Identifier: LGPL-3.0-only -->
<template>
  <Modal :model-value="true" name="setup" anchor="viewport-center" trap-focus
    labelledby="identity-setup-title" :close-handler-override="keepOpen" class="!w-full !max-w-[760px] p-6">
    <IdentitySetupForm :controller="setup" />
  </Modal>
</template>
<script setup>
import { inject } from 'vue';
import IdentitySetupForm from '../components/IdentitySetupForm.vue';
import Modal from '../components/Modal.vue';
import { IDENTITY_APPLICATION } from '../identityApplication.js';
const { setup } = inject(IDENTITY_APPLICATION);
const keepOpen = () => {};
</script>
