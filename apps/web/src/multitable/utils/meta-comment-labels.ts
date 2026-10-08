// S3a (comments shared FE kit extraction): every export here moved verbatim to
// shared/comments/utils/meta-comment-labels.ts. This file re-exports the same names so every
// existing consumer (multitable views/composables importing `'../utils/meta-comment-labels'`,
// and this file's own frozen meta-comment-labels.spec.ts) keeps working unchanged.
export * from '../../shared/comments/utils/meta-comment-labels'
