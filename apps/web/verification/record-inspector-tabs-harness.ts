// Real component and application styles, synthetic props, no API client or feature flags.
import { createApp, h } from 'vue'
import 'element-plus/dist/index.css'
import '../src/styles/tokens.css'
import '../src/App.vue?vue&type=style&index=0&lang.css'
import { useLocale } from '../src/composables/useLocale'
import MetaRecordInspector from '../src/multitable/components/MetaRecordInspector.vue'

const params = new URLSearchParams(window.location.search)
useLocale().setLocale(params.get('locale') || 'en')
localStorage.setItem('metasheet2:record-inspector-width', params.get('width') || '360')

createApp({
  render: () => h('main', { style: 'position:relative;display:flex;justify-content:flex-end;height:100vh' }, [
    h(MetaRecordInspector, {
      visible: true,
      class: params.has('overlay') ? 'meta-record-drawer--overlay' : undefined,
      record: { id: 'synthetic-tabs-record', version: 1, data: { title: 'Synthetic record' } },
      fields: [{ id: 'title', name: 'Title', type: 'string', property: { primary: true } }],
      canEdit: true,
      canComment: false,
      canDelete: false,
    }),
  ]),
}).mount('#app')
