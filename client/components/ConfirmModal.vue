<template>
  <Modal
    v-model="isVisible"
    name="confirm"
    :anchor="actionLayout==='grouped' ? 'dialog' : 'top'"
    :labelledby="titleId"
    trap-focus
    :closeHandlerOverride="() => emitClose('cancel')"
    class="px-6 py-4"
    :class="{'!max-w-[500px]':actionLayout==='grouped'}"
  >
    <!-- Title -->
    <h2 v-if="title" :id="titleId" :class="actionLayout==='grouped' ? 'mb-4 text-lg font-semibold' : 'mb-6 text-xl'">{{ title }}</h2>
    <!-- Message -->
    <div class="mb-6" :class="{'text-sm':actionLayout==='grouped'}">{{ message }}</div>
    <!-- Buttons -->
    <SettingsActions>
      <template v-if="rejectButtonText" #start>
        <CustomButton type="button" :label="rejectButtonText" :variant="actionLayout === 'grouped' ? 'danger-text' : rejectButtonStyle" wrap-label @click="emitClose('reject')" />
      </template>
      <template #end>
        <CustomButton type="button" :label="cancelButtonText" :variant="actionLayout === 'grouped' ? 'secondary' : cancelButtonStyle" wrap-label @click="emitClose('cancel')" />
        <CustomButton v-focus type="button" :label="confirmButtonText" :variant="actionLayout === 'grouped' ? (confirmButtonStyle === 'danger' ? 'danger-primary' : 'cta') : confirmButtonStyle" data-primary="true" wrap-label :disabled="confirmDisabled" @click="emitClose('confirm')" />
      </template>
    </SettingsActions>
  </Modal>
</template>

<script setup>
import CustomButton from "./CustomButton.vue";
import SettingsActions from "./SettingsActions.vue";
import Modal from "./Modal.vue";
import { createUuid } from "../../shared/uuid.ts";

const props = defineProps({
  actionLayout: { type: String, default: "inline", validator: value => ["inline", "grouped"].includes(value) },
  title: { type: String, default: "Confirmation" },
  message: String,
  confirmButtonStyle: { type: String, default: "cta" },
  confirmButtonText: { type: String, default: "Confirm" },
  confirmDisabled: { type: Boolean, default: false },
  cancelButtonStyle: { type: String, default: "subtle" },
  cancelButtonText: { type: String, default: "Cancel" },
  rejectButtonStyle: { type: String, default: "danger" },
  rejectButtonText: { type: String },
});
const emit = defineEmits(["confirm", "reject", "cancel"]);
const isVisible = defineModel({ type: Boolean });
const titleId=`confirmation-${createUuid()}`;

function emitClose(closeEvent = "cancel") {
  isVisible.value = false;
  emit(closeEvent);
}
</script>
