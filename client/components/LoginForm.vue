<!-- SPDX-License-Identifier: LGPL-3.0-only -->
<template><IdentityLoginForm :controller="controller" :dialog="dialog" /></template>
<script setup>
import { inject, onBeforeUnmount } from "vue";
import { IDENTITY_APPLICATION } from "../identityApplication.js";
import IdentityLoginForm from "./IdentityLoginForm.vue";
const props = defineProps({ redirect: String, onAuthenticated: Function, dialog: Boolean, isCurrent: Function });
const controller = inject(IDENTITY_APPLICATION).createLogin({
  redirect: () => props.redirect, authenticated: props.onAuthenticated, isCurrent: props.isCurrent,
});
onBeforeUnmount(controller.dispose);
</script>
