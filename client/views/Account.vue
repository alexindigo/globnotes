<!-- SPDX-License-Identifier: LGPL-3.0-only -->
<template>
  <main class="mx-auto flex w-full max-w-3xl flex-col items-center px-6 py-12">
    <RequiredPasswordForm v-if="controller.state.view?.passwordChangeRequired" :controller="controller" />
    <AccountSettings v-else :controller="controller" />
  </main>
</template>
<script setup>
import { inject, onBeforeUnmount, onMounted } from 'vue';
import { IDENTITY_APPLICATION } from '../identityApplication.js';
import RequiredPasswordForm from '../components/RequiredPasswordForm.vue';
import AccountSettings from '../components/settings/AccountSettings.vue';
const controller = inject(IDENTITY_APPLICATION).createAccountPage();
onMounted(controller.load);
onBeforeUnmount(controller.dispose);
</script>
