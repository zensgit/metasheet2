// Browser-verification harness for the real employee overview below the first
// viewport. Only network IO is stubbed: layout, slots, scoped CSS, deep-link
// watchers, and disclosure state all come from AttendanceView itself.
import { createApp } from 'vue'
import '../src/styles/tokens.css'
import AttendanceView from '../src/views/AttendanceView.vue'

function readSection(): string {
  return new URLSearchParams(window.location.search).get('section') ?? ''
}

const nativeFetch = window.fetch.bind(window)

window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const rawUrl = typeof input === 'string' || input instanceof URL ? String(input) : input.url
  const url = new URL(rawUrl, window.location.origin)
  if (url.pathname === '/api/plugins') {
    return new Response(JSON.stringify([
      { name: 'plugin-attendance', status: 'active' },
    ]), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }
  if (url.pathname.startsWith('/api/')) {
    return new Response(JSON.stringify({
      ok: false,
      error: { code: 'VERIFICATION_NO_BACKEND', message: 'Verification harness has no backend.' },
    }), {
      status: 503,
      headers: { 'content-type': 'application/json' },
    })
  }
  return nativeFetch(input, init)
}

createApp(AttendanceView, {
  mode: 'overview',
  initialSectionId: readSection(),
}).mount('#app')
