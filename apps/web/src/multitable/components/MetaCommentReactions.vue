<!--
  S3a (comments shared FE kit extraction): this component's real implementation moved to
  shared/comments/components/MetaCommentReactions.vue (same template, script, scoped styles,
  class names, testids). This file is a re-export shim, kept at the old path ONLY because
  multitable-comment-reactions.spec.ts imports it from here.
-->
<script lang="ts">
import RealMetaCommentReactions from '../../shared/comments/components/MetaCommentReactions.vue'

export default RealMetaCommentReactions
</script>
