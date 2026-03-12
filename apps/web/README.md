# Vue 3 + TypeScript + Vite

This template should help get you started developing with Vue 3 and TypeScript in Vite. The template uses Vue 3 `<script setup>` SFCs, check out the [script setup docs](https://v3.vuejs.org/api/sfc-script-setup.html#sfc-script-setup) to learn more.

Learn more about the recommended Project Setup and IDE Support in the [Vue Docs TypeScript Guide](https://vuejs.org/guide/typescript/overview.html#project-setup).

## Runtime API Base Resolution

Frontend API base resolution order:

1. `VITE_API_URL`
2. `VITE_API_BASE`
3. `window.location.origin`
4. `http://localhost:8900`

For on-prem same-origin Nginx deployments, you can usually leave both `VITE_API_URL` and `VITE_API_BASE` unset.
