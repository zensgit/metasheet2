<template>
  <div class="plugin-missing">
    <h2>View not available</h2>
    <p>This plugin view is registered, but no matching frontend component was found.</p>
  </div>
</template>

<style scoped>
.plugin-missing {
  max-width: 560px;
  margin: 48px auto;
  padding: 24px;
  background: #fff;
  border-radius: 12px;
  border: 1px solid #e5e7eb;
  box-shadow: 0 10px 24px rgba(15, 23, 42, 0.06);
  color: #1f2933;
}

.plugin-missing h2 {
  margin-bottom: 8px;
  font-size: 20px;
  font-weight: 600;
}

.plugin-missing p {
  color: #6b7280;
}
</style>
