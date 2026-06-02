<script setup lang="ts">
import { useAuth } from './composables/useAuth';
import NavBar from './components/NavBar.vue';

const { isAuthed } = useAuth();
</script>

<template>
  <div class="layout">
    <NavBar v-if="isAuthed" />
    <router-view />
  </div>
</template>
