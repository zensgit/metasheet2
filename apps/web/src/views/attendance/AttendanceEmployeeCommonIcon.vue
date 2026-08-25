<!--
  Original filled (面性) pictograms for the employee 常用 tiles.
  Recreates the Feishu first-level language (color tile + white solid glyph)
  without copying Feishu trademark artwork.
-->
<template>
  <svg
    class="attendance-ew-icon"
    viewBox="0 0 24 24"
    fill="currentColor"
    aria-hidden="true"
    focusable="false"
  >
    <path v-if="name === 'clock-plus'" fill-rule="evenodd" d="M10.7 3.1A9 9 0 1 0 21 13.2 5 5 0 0 1 10.7 3.1ZM12 7.2c.5 0 .9.4.9.9v3.1l2 1.3a.9.9 0 1 1-1 1.5l-2.4-1.6a.9.9 0 0 1-.4-.8V8.1c0-.5.4-.9.9-.9ZM18.2 2.2c.4 0 .8.3.8.8v1.6h1.6a.8.8 0 1 1 0 1.6h-1.6v1.6a.8.8 0 1 1-1.6 0V6.2h-1.6a.8.8 0 1 1 0-1.6h1.6V3c0-.5.4-.8.8-.8Z" />
    <path v-else-if="name === 'calendar'" fill-rule="evenodd" d="M8 2.4c.5 0 .9.4.9.9V4h6.2V3.3c0-.5.4-.9.9-.9s.9.4.9.9V4H18a3 3 0 0 1 3 3v12a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3V7a3 3 0 0 1 3-3h1.1V3.3c0-.5.4-.9.9-.9ZM5 10.2h14V19a1.2 1.2 0 0 1-1.2 1.2H6.2A1.2 1.2 0 0 1 5 19v-8.8Zm2.4 2.2a.9.9 0 0 1 .9-.9h1.4a.9.9 0 0 1 .9.9v1.4a.9.9 0 0 1-.9.9H8.3a.9.9 0 0 1-.9-.9v-1.4Zm4.5-.9a.9.9 0 0 0-.9.9v1.4c0 .5.4.9.9.9h1.4a.9.9 0 0 0 .9-.9v-1.4a.9.9 0 0 0-.9-.9h-1.4Zm3.6.9c0-.5.4-.9.9-.9h1.4a.9.9 0 0 1 .9.9v1.4a.9.9 0 0 1-.9.9h-1.4a.9.9 0 0 1-.9-.9v-1.4Z" />
    <path v-else-if="name === 'moon'" d="M13.2 3.1a.9.9 0 0 0-1.1.6A8.2 8.2 0 0 1 4 14.8a.9.9 0 0 0-.4 1.6A9.8 9.8 0 0 0 12.2 21 9.8 9.8 0 0 0 21 8.4a.9.9 0 0 0-1.2-.8 6.6 6.6 0 0 1-6.6-4.5Z" />
    <path v-else-if="name === 'swap'" d="M4.2 8.2h10.7l-1.7-1.7a.9.9 0 1 1 1.3-1.3l3.3 3.3c.4.4.4 1 0 1.3l-3.3 3.3a.9.9 0 1 1-1.3-1.3l1.7-1.7H4.2a.9.9 0 1 1 0-1.8Zm15.6 7.6H9.1l1.7 1.7a.9.9 0 1 1-1.3 1.3l-3.3-3.3a.9.9 0 0 1 0-1.3l3.3-3.3a.9.9 0 1 1 1.3 1.3l-1.7 1.7h10.7a.9.9 0 1 1 0 1.8Z" />
    <path v-else-if="name === 'plus'" d="M12 4.2c.6 0 1 .4 1 1v5.8h5.8a1 1 0 1 1 0 2H13v5.8a1 1 0 1 1-2 0v-5.8H5.2a1 1 0 1 1 0-2H11V5.2c0-.6.4-1 1-1Z" />
    <path v-else-if="name === 'user'" d="M12 3.2a4.2 4.2 0 1 1 0 8.4 4.2 4.2 0 0 1 0-8.4ZM6.1 20.8A6 6 0 0 1 12 15.6a6 6 0 0 1 5.9 5.2.9.9 0 0 1-.9 1H7a.9.9 0 0 1-.9-1Z" />
    <path v-else-if="name === 'briefcase'" fill-rule="evenodd" d="M9 4.6A2.2 2.2 0 0 1 11.2 2.4h1.6A2.2 2.2 0 0 1 15 4.6V6h3.2A2.8 2.8 0 0 1 21 8.8v3.1h-7.1v-.3a.9.9 0 1 0-1.8 0v.3H3V8.8A2.8 2.8 0 0 1 5.8 6H9V4.6Zm0 1.4h6V4.6c0-.2-.2-.4-.4-.4h-1.6c-.2 0-.4.2-.4.4V6H9Zm-6 7.3h7.1v.4a.9.9 0 1 0 1.8 0v-.4H21v4.9A2.8 2.8 0 0 1 18.2 21H5.8A2.8 2.8 0 0 1 3 18.2v-4.9Z" />
    <path v-else-if="name === 'pin'" fill-rule="evenodd" d="M12 2.3a6.4 6.4 0 0 1 6.4 6.4c0 3.7-4.3 9.4-5.8 11.3a.8.8 0 0 1-1.2 0C9.9 18.1 5.6 12.4 5.6 8.7A6.4 6.4 0 0 1 12 2.3Zm0 4.2a2.3 2.3 0 1 0 0 4.6 2.3 2.3 0 0 0 0-4.6Z" />
  </svg>
</template>

<script setup lang="ts">
import type { CommonIconId } from './attendanceEmployeeWorkspaceCommonIcons'

defineProps<{
  name: CommonIconId
}>()
</script>
