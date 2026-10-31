<template>
  <label class="attendance__field">
    <span>{{ label ? label + ' · ' : '' }}{{ tr('Effective date', '生效日期') }}</span>
    <input type="date" :value="modelValue" :disabled="disabled" :data-calc14-date="action" @input="$emit('update:modelValue', ($event.target as HTMLInputElement).value)" />
    <small class="attendance__field-hint">{{ tr('Historical dates require separate verification. Frozen results are not affected.', '历史日期需单独核验，已冻结结果不受影响。') }}</small>
  </label>
</template>

<script setup lang="ts">
defineProps<{ modelValue?: string; action: string; label?: string; disabled?: boolean; tr: (en: string, zh: string) => string }>()
defineEmits<{ 'update:modelValue': [value: string] }>()
</script>
