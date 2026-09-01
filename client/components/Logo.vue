<template>
  <div class="flex items-center">
    <!-- Full lockup slot. Two independent pieces: image (custom → tinted
         glob icon → bundled square) and wordmark (rendered whenever a
         brand name exists). The bundled logo.svg squeezes its wordmark
         internally; the CSS wordmark here never does — transform-based
         squeezes (scaleX) shrink glyphs but not the layout box, which
         breaks centering of the lockup. -->
    <span
      :class="{ 'hidden sm:flex': props.responsive }"
      class="flex max-w-full items-center gap-2.5"
    >
      <!-- image slot: custom upload → tinted glob icon → bundled square -->
      <img
        v-if="customLogo"
        :src="brandUrl(customLogo)"
        class="h-[46px] flex-shrink-0"
        alt=""
      />
      <span v-else-if="brandName" class="flex-shrink-0" v-html="iconSvgTinted"></span>
      <span v-else class="flex-shrink-0" v-html="logoSvgTinted"></span>
      <!-- wordmark slot: rendered whenever a brand name is set (upload or not);
           slate #9CAFBF like the bundled wordmark -->
      <span
        v-if="brandName"
        class="inline-block font-normal"
        :style="{
          fontFamily: 'Poppins, sans-serif',
          fontSize: '38px',
          lineHeight: '46px',
          color: '#9CAFBF',
          maxWidth: '100%',
        }"
        >{{ brandName }}</span
      >
    </span>
    <!-- Icon only slot (small screens): custom icon.svg → bundled SVG -->
    <span v-if="props.responsive" class="sm:hidden">
      <img v-if="customIcon" :src="brandUrl(customIcon)" class="h-9" alt="" />
      <span v-else v-html="iconSvgTinted"></span>
    </span>
  </div>
</template>

<script setup>
import { computed } from "vue";

import { brandVersion } from "../brand.js";
import iconSvg from "../assets/brand/icon.svg?raw";
import logoSvg from "../assets/brand/logo.svg?raw";
import { useGlobalStore } from "../globalStore.js";

const props = defineProps({
  responsive: {
    type: Boolean,
    default: false,
  },
});

const globalStore = useGlobalStore();
const pathPrefix =
  document.querySelector('meta[name="globnotes-prefix"]')?.content || "";

const brand = computed(() => globalStore.config.brand ?? {});
const brandFiles = computed(() => brand.value.files ?? []);
// Custom uploads keep their extension — find logo.* / icon.*.
const customLogo = computed(() =>
  brandFiles.value.find((f) => f.startsWith("logo.")),
);
const customIcon = computed(() =>
  brandFiles.value.find((f) => f.startsWith("icon.")),
);
const brandName = computed(() => brand.value.name ?? "");

// No custom logo: keep the bundled lockup but recolor its brand-blue
// square (#38BDF8) to the brand accent when one is set.
const BRAND_BLUE = "#38BDF8";
function tinted(svg) {
  const accent = brand.value.accent;
  return accent ? svg.replaceAll(BRAND_BLUE, accent) : svg;
}
const logoSvgTinted = computed(() => tinted(logoSvg));
const iconSvgTinted = computed(() => tinted(iconSvg));

function brandUrl(file) {
  // Cache-buster: a just-uploaded file must replace the old one on screen.
  return `${pathPrefix}/_/brand/${file}?v=${brandVersion.value}`;
}
</script>
