<!--
  S3a (comments shared FE kit extraction): this component's real implementation moved to
  shared/comments/components/MetaCommentsPanel.vue (same template, script, scoped styles, class
  names, emits, testids — see that file's header for the extraction history). This file is a
  re-export shim, kept at the old path ONLY because multitable-comments-panel.spec.ts's HI-1
  guard reads this exact file's own source text and imports it from this exact path — both must
  keep resolving to something real for that frozen spec to pass unmodified. Living callers
  (MetaCommentsDrawer.vue, MetaRecordInspector.vue) import the new home directly instead of
  going through this shim.
-->
<script lang="ts">
import RealMetaCommentsPanel from '../../shared/comments/components/MetaCommentsPanel.vue'

export default RealMetaCommentsPanel
</script>
