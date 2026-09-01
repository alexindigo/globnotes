<template>
  <Modal v-model="isVisible" name="branding">
    <div class="p-4">
      <div class="mb-3 text-lg font-bold text-theme-text">Branding</div>

      <div class="mb-3">
        <label
          class="mb-1 block text-sm text-theme-text-muted"
          for="brand-name"
        >
          Name
        </label>
        <TextInput id="brand-name" v-model="name" placeholder="globnotes" />
      </div>

      <div class="mb-3">
        <label
          class="mb-1 block text-sm text-theme-text-muted"
          for="brand-accent"
        >
          Accent color
        </label>
        <div class="flex items-center gap-2">
          <input
            id="brand-accent"
            type="color"
            class="h-9 w-14 cursor-pointer rounded border border-theme-border"
            :class="{ 'opacity-40': accentCleared }"
            :value="accentInput"
            @input="touchAccent($event.target.value)"
          />
          <span class="text-sm text-theme-text-muted">{{
            accentCleared ? "theme default" : accentInput
          }}</span>
          <CustomButton
            v-if="!accentCleared"
            label="Clear"
            title="Fall back to the theme's own brand color"
            @click="clearAccent"
          />
          <CustomButton
            v-else
            :iconPath="tabClose"
            label=""
            title="Keep a custom accent"
            @click="touchAccent(brand.accent ?? '#38bdf8')"
          />
        </div>
      </div>

      <div
        v-for="slot in ['logo', 'icon']"
        :key="slot"
        class="flex items-center justify-between border-t border-theme-border py-2"
      >
        <div class="flex items-center gap-3">
          <img
            v-if="previewSrc(slot)"
            :src="previewSrc(slot)"
            class="h-8"
            alt=""
          />
          <div>
            <div class="capitalize text-theme-text">{{ slot }}</div>
            <div class="text-sm text-theme-text-muted">SVG only</div>
          </div>
        </div>
        <div class="flex items-center gap-2">
          <CustomButton
            v-if="picked[slot]"
            :iconPath="tabClose"
            label=""
            title="Discard the chosen file"
            @click="picked[slot] = null"
          />
          <CustomButton
            v-else-if="customPresent(slot)"
            :iconPath="tabTrash"
            label=""
            title="Remove the uploaded file"
            @click="removeRequested[slot] = true"
          />
          <CustomButton
            :iconPath="tabFileExport"
            :label="customPresent(slot) ? 'Replace' : 'Upload'"
            @click="fileInputs[slot]?.click()"
          />
          <input
            :ref="(el) => (fileInputs[slot] = el)"
            type="file"
            accept=".svg,image/svg+xml"
            class="hidden"
            @change="pick(slot, $event)"
          />
        </div>
      </div>

      <div class="mt-3 flex justify-between gap-2">
        <CustomButton
          label="Reset"
          style="danger"
          :disabled="!hasBranding"
          title="Clear name, accent, and uploaded logo/icon"
          @click="reset"
        />
        <div class="flex gap-2">
          <CustomButton label="Cancel" @click="isVisible = false" />
          <CustomButton
            label="Save"
            style="cta"
            :disabled="!dirty"
            @click="save"
          />
        </div>
      </div>
    </div>
  </Modal>
</template>

<script setup>
import { computed, reactive, ref, watch } from "vue";

import { useToast } from "primevue/usetoast";

import { postBrand } from "../api.js";
import { publish, TOPICS } from "../bus/index.js";
import { tabClose, tabFileExport, tabTrash } from "../icons.js";
import { useGlobalStore } from "../globalStore.js";
import { getToastOptions } from "../helpers.js";
import CustomButton from "./CustomButton.vue";
import Modal from "./Modal.vue";
import TextInput from "./TextInput.vue";

const isVisible = defineModel({ type: Boolean });

const globalStore = useGlobalStore();
const toast = useToast();

const name = ref("");
const accentInput = ref("#38bdf8");
const accentTouched = ref(false);
const accentCleared = ref(false);
const picked = reactive({ logo: null, icon: null });
const pickedUrls = reactive({ logo: null, icon: null });
// Hidden file inputs, opened by the Upload/Replace button clicks.
const fileInputs = reactive({ logo: null, icon: null });
const removeRequested = reactive({ logo: false, icon: false });
// Preview cache-buster: bumps after each successful save so re-rendered
// previews fetch the fresh files.
const reloadedAt = ref(0);

const brand = computed(() => globalStore.config.brand ?? {});
const brandFiles = computed(() => brand.value.files ?? []);

function customPresent(slot) {
  return brandFiles.value.includes(`${slot}.svg`);
}

function previewSrc(slot) {
  if (pickedUrls[slot]) return pickedUrls[slot];
  if (customPresent(slot) && !removeRequested[slot]) {
    return `/_/brand/${slot}.svg?v=${reloadedAt.value}`;
  }
  return null;
}

function pick(slot, event) {
  const file = event.target.files?.[0];
  if (file) {
    if (pickedUrls[slot]) URL.revokeObjectURL(pickedUrls[slot]);
    picked[slot] = file;
    pickedUrls[slot] = URL.createObjectURL(file);
    removeRequested[slot] = false;
  }
  event.target.value = "";
}

function touchAccent(value) {
  accentTouched.value = true;
  accentCleared.value = false;
  accentInput.value = value;
}

function clearAccent() {
  accentTouched.value = false;
  accentCleared.value = true;
}

watch(isVisible, (visible) => {
  if (!visible) return;
  name.value = brand.value.name ?? "";
  accentInput.value = brand.value.accent ?? "#38bdf8";
  accentTouched.value = false;
  accentCleared.value = false;
  for (const slot of ["logo", "icon"]) {
    if (pickedUrls[slot]) URL.revokeObjectURL(pickedUrls[slot]);
    picked[slot] = null;
    pickedUrls[slot] = null;
    removeRequested[slot] = false;
  }
});

const dirty = computed(() => {
  return (
    name.value !== (brand.value.name ?? "") ||
    accentTouched.value ||
    accentCleared.value ||
    picked.logo ||
    picked.icon ||
    removeRequested.logo ||
    removeRequested.icon
  );
});

const hasBranding = computed(() => {
  return Boolean(
    brand.value.name || brand.value.accent || brandFiles.value.length,
  );
});

function applyFresh(fresh) {
  globalStore.config = { ...globalStore.config, brand: fresh };
  reloadedAt.value = Date.now();
  publish(TOPICS.BRAND_CHANGE, fresh);
}

function toastSaveError(error) {
  const detail = error.response?.data?.detail;
  if (detail) {
    toast.add(getToastOptions(detail, "Branding Error", "error"));
  } else {
    console.error(error);
    toast.add(
      getToastOptions("Branding could not be saved.", "Error", "error"),
    );
  }
}

async function save() {
  const form = new FormData();
  if (name.value !== (brand.value.name ?? "")) {
    form.append("name", name.value);
  }
  if (accentCleared.value) {
    // Server deletes the stored key — themes fall back to their own brand.
    form.append("accent", "");
  } else if (accentTouched.value) {
    form.append("accent", accentInput.value);
  }
  if (picked.logo) form.append("logo", picked.logo);
  if (picked.icon) form.append("icon", picked.icon);
  if (removeRequested.logo) form.append("removeLogo", "true");
  if (removeRequested.icon) form.append("removeIcon", "true");

  try {
    const fresh = await postBrand(form);
    applyFresh(fresh);
    toast.add(getToastOptions("Branding updated.", "Success", "success"));
    isVisible.value = false;
  } catch (error) {
    toastSaveError(error);
  }
}

async function reset() {
  const form = new FormData();
  form.append("name", "");
  form.append("accent", "");
  form.append("removeLogo", "true");
  form.append("removeIcon", "true");
  try {
    const fresh = await postBrand(form);
    applyFresh(fresh);
    toast.add(getToastOptions("Branding reset.", "Success", "success"));
    isVisible.value = false;
  } catch (error) {
    toastSaveError(error);
  }
}
</script>
