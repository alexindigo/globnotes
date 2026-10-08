<template>
  <Modal
    v-model="isVisible"
    name="confirm"
    :labelledby="titleId"
    trap-focus
    :closeHandlerOverride="() => emitClose('cancel')"
    class="px-6 py-4"
  >
    <!-- Title -->
    <div v-if="title" :id="titleId" class="mb-6 text-xl">{{ title }}</div>
    <!-- Message -->
    <div class="mb-6">{{ message }}</div>
    <!-- Buttons -->
    <div class="flex flex-wrap justify-end gap-2">
      <CustomButton
        :label="cancelButtonText"
        :variant="cancelButtonStyle"
        @click="emitClose('cancel')"
        class="mr-2"
      />
      <CustomButton
        v-if="rejectButtonText"
        :label="rejectButtonText"
        :variant="rejectButtonStyle"
        @click="emitClose('reject')"
        class="mr-2"
      />
      <CustomButton
        v-focus
        :label="confirmButtonText"
         :variant="confirmButtonStyle"
         :disabled="confirmDisabled"
        @click="emitClose('confirm')"
      />
    </div>
  </Modal>
</template>

<script setup>
import CustomButton from "./CustomButton.vue";
import Modal from "./Modal.vue";

const props = defineProps({
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
const titleId=`confirmation-${crypto.randomUUID()}`;

function emitClose(closeEvent = "cancel") {
  isVisible.value = false;
  emit(closeEvent);
}
</script>
