<template>
  <div class="mx-auto max-w-lg py-12">
    <h1 class="mb-6 text-2xl">Vaults</h1>
    <ul class="flex flex-col gap-2">
      <li v-for="v in vaults" :key="v.slug">
        <RouterLink
          :to="'/' + v.slug"
          class="block rounded border border-theme-border px-4 py-3 hover:bg-theme-background-elevated"
        >
          {{ v.brand?.name || v.slug }}
        </RouterLink>
      </li>
    </ul>
    <fieldset class="mt-8 text-sm text-theme-text-muted">
      <legend class="mb-2">On open</legend>
      <label class="mr-4">
        <input type="radio" value="picker" v-model="mode" /> Picker
      </label>
      <label class="mr-4">
        <input type="radio" value="last" v-model="mode" /> Last used
      </label>
    </fieldset>
  </div>
</template>

<script setup>
import { onMounted, ref, watch } from "vue";
import { RouterLink, useRouter } from "vue-router";

import { getVaults } from "../api.js";
import { lastUsedSlug, pickerMode, setPickerMode } from "../vault.js";

const vaults = ref([]);
const mode = ref(pickerMode());
const router = useRouter();

watch(mode, (m) => setPickerMode(m));

onMounted(async () => {
  vaults.value = await getVaults();
  if (mode.value === "last" && lastUsedSlug()) {
    router.replace("/" + lastUsedSlug());
  } else if (vaults.value.length === 1) {
    router.replace("/" + vaults.value[0].slug);
  }
});
</script>
