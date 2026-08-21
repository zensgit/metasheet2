<!--
  S3a (comments shared FE kit extraction): this component's real implementation moved to
  shared/comments/components/MetaCommentComposer.vue (same template, script, scoped styles, class
  names, emits, testids). This file is a re-export shim, kept at the old path ONLY because three
  frozen specs (multitable-comment-composer, meta-comment-composer-i18n, meta-comment-composer-
  migration) import it from here.
-->
<script lang="ts">
import RealMetaCommentComposer from '../../shared/comments/components/MetaCommentComposer.vue'

export default RealMetaCommentComposer
</script>
