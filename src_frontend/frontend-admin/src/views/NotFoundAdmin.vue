<script setup lang="ts">
import { RouterLink } from "vue-router";
</script>

<template>
  <h1>404</h1>
  <p><RouterLink v-bind:to="{ name: 'Home' }">Return go to home.</RouterLink></p>
</template>
