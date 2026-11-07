<template>
  <LoginForm :redirect="redirect" />
</template>

<script setup>
import LoginForm from "../components/LoginForm.vue";
defineProps({ redirect: String });
</script>
