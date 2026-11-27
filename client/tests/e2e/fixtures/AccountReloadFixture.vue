<template>
  <PrimeToast :action-notice="session.state.reloadRequired" />
  <main :inert="!!session.state.reloadRequired">
    <p data-active-account>{{ config.principal?.login }}</p>
    <button type="button" @click="switchAccount">Switch account</button>
  </main>
</template>

<script setup>
// Exercise the prepared composition without activating the production cutover.
import { onMounted, onBeforeUnmount, ref } from "vue";
import PrimeToast from "../../../components/PrimeToast.vue";
import { createIdentityAppSession } from "../../../appSession.js";
import { createIdentityTokenStorage } from "../../../tokenStorage.js";
import { initTheme } from "../../../themes.js";

const tokens = createIdentityTokenStorage();
if (!tokens.getStoredToken()) tokens.storeToken("alice.fixture", true);
const config = ref({});
const session = createIdentityAppSession({ tokens, config: () => config.value,
  setConfig: value => { config.value = value; }, applyBrand() {}, stopRuntime() {},
  transport: { async getConfig() {
    const login = tokens.getStoredToken().split(".")[0];
    return { principal: { kind: "account", id: login, login }, sessionGeneration: login, capabilities: { canRead: true } };
  } },
});
async function switchAccount() { if (session.acceptToken("bob.fixture", true)) await session.refresh(); }
initTheme();
onMounted(session.load);
onBeforeUnmount(session.dispose);
</script>
