<script setup>
import SvgIcon from "@jamescoyle/vue-icon";
import { mdiAlertOutline, mdiFileMoveOutline } from "@mdi/js";
import CustomButton from "./CustomButton.vue";

const props = defineProps({
  visible: Boolean,
  refs: { type: Array, default: () => [] },
});

const emit = defineEmits(["update:visible", "confirm"]);

function confirm(strategy) {
  emit("confirm", strategy);
  emit("update:visible", false);
}

function close() {
  emit("update:visible", false);
}
</script>

<template>
  <teleport to="body">
    <div
      v-if="visible"
      class="fixed inset-0 z-50 flex items-center justify-center"
    >
      <div class="fixed inset-0 bg-black/30" @click="close" />
      <div
        class="relative z-10 mx-4 max-h-[80vh] w-full max-w-md overflow-y-auto rounded-lg border border-theme-border bg-theme-background p-6 shadow-lg"
      >
        <h2 class="mb-1 text-lg font-medium text-theme-text">
          Move note with attachments?
        </h2>
        <p class="mb-4 text-sm text-theme-text-muted">
          This note references {{ refs.length }} local
          file{{ refs.length === 1 ? "" : "s" }}:
        </p>

        <ul class="mb-4 max-h-40 space-y-1 overflow-y-auto rounded border border-theme-border bg-theme-background-elevated p-2 text-sm">
          <li
            v-for="ref in refs"
            :key="ref.url"
            class="flex items-center justify-between text-theme-text-muted"
          >
            <span class="truncate">{{ ref.url }}</span>
            <span class="ml-2 shrink-0 text-xs text-theme-text-very-muted">{{
              ref.kind
            }}</span>
          </li>
        </ul>

        <div class="space-y-2">
          <button
            class="flex w-full items-center rounded border border-theme-brand/20 px-3 py-2 text-left text-sm hover:bg-theme-background-elevated"
            @click="confirm('move')"
          >
            <SvgIcon
              type="mdi"
              :path="mdiFileMoveOutline"
              size="1em"
              class="mr-2 shrink-0 text-theme-brand"
            />
            <div>
              <div class="font-medium text-theme-text">Move files with the note</div>
              <div class="text-xs text-theme-text-muted">
                Physically move same-folder attachments into the new folder and
                update every link automatically.
              </div>
            </div>
          </button>

          <button
            class="flex w-full items-center rounded border border-theme-border px-3 py-2 text-left text-sm hover:bg-theme-background-elevated"
            @click="confirm('relink')"
          >
            <svg
              class="mr-2 h-4 w-4 shrink-0 text-theme-text-muted"
              viewBox="0 0 24 24"
            >
              <path
                fill="currentColor"
                d="M10.59 13.41c.41.39.41 1.03 0 1.42c-.39.39-1.03.39-1.42 0a5.003 5.003 0 0 1 0-7.07l3.54-3.54a5.003 5.003 0 0 1 7.07 0a5.003 5.003 0 0 1 0 7.07l-1.49 1.49c.01-.82-.12-1.64-.4-2.42l.47-.48a2.982 2.982 0 0 0 0-4.24a2.982 2.982 0 0 0-4.24 0l-3.53 3.53a2.982 2.982 0 0 0 0 4.24m2.82-4.24c.39-.39 1.03-.39 1.42 0a5.003 5.003 0 0 1 0 7.07l-3.54 3.54a5.003 5.003 0 0 1-7.07 0a5.003 5.003 0 0 1 0-7.07l1.49-1.49c-.01.82.12 1.64.4 2.43l-.47.47a2.982 2.982 0 0 0 0 4.24a2.982 2.982 0 0 0 4.24 0l3.53-3.53a2.982 2.982 0 0 0 0-4.24a.973.973 0 0 1 0-1.42"
              />
            </svg>
            <div>
              <div class="font-medium text-theme-text">Keep files, fix the links</div>
              <div class="text-xs text-theme-text-muted">
                Files stay in the old folder; links are rewritten to reach back
                using relative paths.
              </div>
            </div>
          </button>

          <button
            class="flex w-full items-center rounded border border-theme-border px-3 py-2 text-left text-sm hover:bg-theme-background-elevated"
            @click="confirm('none')"
          >
            <div class="ml-6">
              <div class="font-medium text-theme-text">Don't touch anything</div>
              <div class="text-xs text-theme-text-muted">
                Only the .md file moves; links stay as-is and may break.
              </div>
            </div>
          </button>
        </div>

        <div class="mt-4 rounded border border-theme-border bg-theme-background-elevated p-2 text-xs text-theme-text-very-muted">
          <SvgIcon
            type="mdi"
            :path="mdiAlertOutline"
            size="1em"
            class="mr-1 inline-block align-text-bottom"
          />
          These files may be referenced by other notes. After the move,
          you can find and fix referencing notes on the scan page.
        </div>

        <div class="mt-4 flex justify-end">
          <CustomButton label="Cancel" @click="close" />
        </div>
      </div>
    </div>
  </teleport>
</template>
