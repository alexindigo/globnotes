<template><span class="driver-state" :class="`driver-state--${status}`">{{ label }}</span></template>
<script setup>
defineProps({status:String,label:String});
</script>
<style scoped>
.driver-state { white-space:nowrap; font-size:12px; border:1px solid rgb(var(--theme-border)); border-radius:.25rem; padding:.2rem .5rem; }
.driver-state--locked, .driver-state--failed { color:rgb(var(--theme-danger)); }
.driver-state--active { color:rgb(var(--theme-brand)); }
</style>
