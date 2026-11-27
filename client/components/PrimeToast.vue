<template>
  <Toast v-if="!actionNotice" position="bottom-right" :pt="style" />
  <Toast group="sticky-action" position="bottom-right" :pt="style">
    <template #message="{ message }">
      <div class="flex flex-col items-start gap-2" data-sticky-toast>
        <p>{{ message.detail }}</p>
        <CustomButton class="self-end" type="button" :label="message.actionLabel" variant="secondary" @click="message.action" />
      </div>
    </template>
  </Toast>
</template>

<script setup>
import Toast from "primevue/toast";
import { useToast } from "primevue/usetoast";
import { onMounted, watch } from "vue";
import CustomButton from "./CustomButton.vue";

const props = defineProps({ actionNotice: Object });
const toast = useToast();
const group = "sticky-action";
function showAction(notice) {
  toast.removeGroup(group);
  if (notice) toast.add({ ...notice, group, severity: "info", closable: false });
}
onMounted(() => { if (props.actionNotice) showAction(props.actionNotice); });
watch(() => props.actionNotice, showAction);

const style = {
  message: "flex flex-col items-end ml-[20px]",
  container: ({ props }) => ({
    class: [
      "mt-2 px-3 py-2 rounded-lg max-w-96",
      "bg-theme-background dark:bg-theme-background-elevated border border-l-2 border-theme-border shadow-md",
      {
        "border-l-theme-success": props.message.severity == "success",
        "border-l-theme-danger": props.message.severity == "error",
      },
    ],
  }),
  icon: "invisible h-0 w-0",
  summary: "font-bold",
};
</script>
