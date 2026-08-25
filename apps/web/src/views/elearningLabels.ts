// V0.1 e-learning chrome string table — single source for
// ElearningLearnerView.vue and ElearningAdminView.vue.
//
// EN + ZH both explicit (same convention as workbench-labels.ts and
// meta-core-labels.ts). Components read `useLocale().isZh` and call
// `elearningLabel(key, isZh)` for static strings, or the interpolation
// helpers below for strings with scores / ids / error codes.
//
// NOT translated (user/data values): course titles, question prompts,
// already-entered choice option texts, deadlines, ids, URLs, and backend
// error codes. Error codes and HTTP statuses are interpolated raw.
// True/false option drafts are UI-owned defaults (not user data) and are
// localized when the question type is switched to true_false.

import type { ElearningLearnerVideoStatus } from '../services/elearning'

export type ElearningLabelKey =
  // --- Learner chrome ---
  | 'learner.title'
  | 'learner.subtitle'
  | 'learner.loading'
  | 'learner.empty'
  | 'learner.access'
  | 'learner.required'
  | 'learner.selfStudy'
  | 'learner.deadline'
  | 'learner.deadlineNone'
  | 'learner.videoProgress'
  | 'learner.courseCompletion'
  | 'learner.startWatch'
  | 'learner.startExam'
  | 'learner.continueExam'
  | 'learner.videoUnsupported'
  | 'learner.submitExam'
  // --- Admin chrome ---
  | 'admin.title'
  | 'admin.subtitle'
  | 'admin.videoFile'
  | 'admin.courseTitle'
  | 'admin.questions'
  | 'admin.questionType'
  | 'admin.questionTypeSingle'
  | 'admin.questionTypeMultiple'
  | 'admin.questionTypeTrueFalse'
  | 'admin.points'
  | 'admin.removeQuestion'
  | 'admin.prompt'
  | 'admin.optionsLegend'
  | 'admin.removeOption'
  | 'admin.addOption'
  | 'admin.addQuestion'
  | 'admin.trueOption'
  | 'admin.falseOption'
  | 'admin.passScore'
  | 'admin.maxAttempts'
  | 'admin.targetUser'
  | 'admin.deadline'
  | 'admin.publishing'
  | 'admin.publish'
  | 'admin.uploading'
  | 'admin.publishingCourse'
  | 'admin.assigning'
  | 'admin.retrying'
  | 'admin.retry'
  | 'admin.assignSuccess'
  // --- Shared statuses ---
  | 'status.completed'
  | 'status.incomplete'
  | 'status.passed'
  | 'status.failed'
  | 'video.inProgress'
  | 'video.notStarted'
  // --- Admin validation ---
  | 'validation.mp4Required'
  | 'validation.titleRequired'
  | 'validation.passScoreInteger'
  | 'validation.maxAttemptsInteger'
  | 'validation.targetRequired'
  | 'validation.questionRequired'
  | 'validation.promptRequired'
  | 'validation.pointsInteger'
  | 'validation.trueFalseOptions'
  | 'validation.choiceOptions'
  | 'validation.optionsRequired'
  | 'validation.correctRequired'
  | 'validation.singleCorrect'
  | 'validation.passScoreTooHigh'

const ELEARNING_LABELS: Record<ElearningLabelKey, { en: string; zh: string }> = {
  'learner.title': { en: 'Learning Center', zh: '学习中心' },
  'learner.subtitle': {
    en: 'Learn required or visible self-study courses. Exams open only after the server confirms the video is complete.',
    zh: '学习必修或可见自学课程。考试仅在服务端确认视频完成后开放。',
  },
  'learner.loading': { en: 'Loading courses...', zh: '正在加载课程…' },
  'learner.empty': { en: 'No available courses.', zh: '暂无可学习课程。' },
  'learner.access': { en: 'Learning type', zh: '学习类型' },
  'learner.required': { en: 'Required', zh: '必修' },
  'learner.selfStudy': { en: 'Self-study', zh: '自学' },
  'learner.deadline': { en: 'Deadline', zh: '截止日期' },
  'learner.deadlineNone': { en: 'None', zh: '无' },
  'learner.videoProgress': { en: 'Video progress', zh: '视频进度' },
  'learner.courseCompletion': { en: 'Course completion', zh: '课程完成' },
  'learner.startWatch': { en: 'Start learning', zh: '开始学习' },
  'learner.startExam': { en: 'Start exam', zh: '开始考试' },
  'learner.continueExam': { en: 'Continue exam', zh: '继续考试' },
  'learner.videoUnsupported': {
    en: 'Your browser does not support video playback.',
    zh: '您的浏览器不支持视频播放。',
  },
  'learner.submitExam': { en: 'Submit answers', zh: '提交答卷' },

  'admin.title': { en: 'Cloud Classroom Admin', zh: '云课堂管理' },
  'admin.subtitle': {
    en: 'Upload an MP4, write objective questions, then publish and assign directly to one learner.',
    zh: '上传一段 MP4、编写客观题后发布并直接指派给一名学员。',
  },
  'admin.videoFile': { en: 'Course video (MP4)', zh: '课程视频（MP4）' },
  'admin.courseTitle': { en: 'Course title', zh: '课程标题' },
  'admin.questions': { en: 'Objective questions', zh: '客观题' },
  'admin.questionType': { en: 'Question type', zh: '题型' },
  'admin.questionTypeSingle': { en: 'Single choice', zh: '单选' },
  'admin.questionTypeMultiple': { en: 'Multiple choice', zh: '多选' },
  'admin.questionTypeTrueFalse': { en: 'True / false', zh: '判断' },
  'admin.points': { en: 'Points', zh: '分值' },
  'admin.removeQuestion': { en: 'Remove question', zh: '删除本题' },
  'admin.prompt': { en: 'Prompt', zh: '题干' },
  'admin.optionsLegend': { en: 'Options and correct answers', zh: '选项与正确答案' },
  'admin.removeOption': { en: 'Remove option', zh: '删除选项' },
  'admin.addOption': { en: 'Add option', zh: '添加选项' },
  'admin.addQuestion': { en: 'Add question', zh: '添加题目' },
  'admin.trueOption': { en: 'True', zh: '正确' },
  'admin.falseOption': { en: 'False', zh: '错误' },
  'admin.passScore': { en: 'Passing score', zh: '及格分' },
  'admin.maxAttempts': { en: 'Maximum attempts', zh: '最大尝试次数' },
  'admin.targetUser': { en: 'Assignee (user ID)', zh: '指派对象（用户 ID）' },
  'admin.deadline': { en: 'Deadline (optional)', zh: '截止日期（可选）' },
  'admin.publishing': { en: 'Publishing...', zh: '正在发布…' },
  'admin.publish': { en: 'Publish and assign', zh: '发布并指派' },
  'admin.uploading': { en: 'Uploading video...', zh: '正在上传视频…' },
  'admin.publishingCourse': { en: 'Publishing course...', zh: '正在发布课程…' },
  'admin.assigning': { en: 'Assigning learner...', zh: '正在指派学员…' },
  'admin.retrying': { en: 'Retrying assignment...', zh: '正在重试指派…' },
  'admin.retry': { en: 'Retry assignment', zh: '重试指派' },
  'admin.assignSuccess': {
    en: 'The course was published and assigned.',
    zh: '课程已发布并完成指派。',
  },

  'status.completed': { en: 'Completed', zh: '已完成' },
  'status.incomplete': { en: 'Incomplete', zh: '未完成' },
  'status.passed': { en: 'Passed', zh: '通过' },
  'status.failed': { en: 'Failed', zh: '未通过' },
  'video.inProgress': { en: 'In progress', zh: '学习中' },
  'video.notStarted': { en: 'Not started', zh: '未开始' },

  'validation.mp4Required': {
    en: 'Please select an MP4 file.',
    zh: '请选择一个 MP4 文件。',
  },
  'validation.titleRequired': {
    en: 'Please enter a course title.',
    zh: '请填写课程标题。',
  },
  'validation.passScoreInteger': {
    en: 'Passing score must be a non-negative integer.',
    zh: '及格分须为非负整数。',
  },
  'validation.maxAttemptsInteger': {
    en: 'Maximum attempts must be a positive integer.',
    zh: '最大尝试次数须为正整数。',
  },
  'validation.targetRequired': {
    en: 'Please enter an assignee.',
    zh: '请填写指派对象。',
  },
  'validation.questionRequired': {
    en: 'At least one objective question is required.',
    zh: '至少需要一道客观题。',
  },
  'validation.promptRequired': {
    en: 'Please enter the prompt.',
    zh: '请填写题干。',
  },
  'validation.pointsInteger': {
    en: 'Points must be a positive integer.',
    zh: '分值须为正整数。',
  },
  'validation.trueFalseOptions': {
    en: 'True/false questions must have exactly two options.',
    zh: '判断题必须恰好两个选项。',
  },
  'validation.choiceOptions': {
    en: 'Choice questions need at least two options.',
    zh: '选择题至少需要两个选项。',
  },
  'validation.optionsRequired': {
    en: 'Please fill in every option.',
    zh: '请填写全部选项。',
  },
  'validation.correctRequired': {
    en: 'Please select the correct answer.',
    zh: '请选择正确答案。',
  },
  'validation.singleCorrect': {
    en: 'Single-choice and true/false questions can have only one correct answer.',
    zh: '单选和判断题只能有一个正确答案。',
  },
  'validation.passScoreTooHigh': {
    en: 'Passing score cannot exceed the total score.',
    zh: '及格分不能大于总分。',
  },
}

export function elearningLabel(key: ElearningLabelKey, isZh: boolean): string {
  const entry = ELEARNING_LABELS[key]
  return isZh ? entry.zh : entry.en
}

// --- Interpolation helpers (not keys) ---

export function elearningVideoStatusLabel(
  status: ElearningLearnerVideoStatus,
  isZh: boolean,
): string {
  switch (status) {
    case 'completed':
      return elearningLabel('status.completed', isZh)
    case 'in_progress':
      return elearningLabel('video.inProgress', isZh)
    case 'not_started':
      return elearningLabel('video.notStarted', isZh)
  }
}

// durationMs is already server-validated >= 1; in-progress stays 0..99 until status=completed.
export function elearningWatchProgressPercent(effectiveMs: number, durationMs: number): number {
  if (!Number.isFinite(effectiveMs) || !Number.isFinite(durationMs) || durationMs < 1) return 0
  if (effectiveMs <= 0) return 0
  return Math.min(99, Math.max(0, Math.floor((effectiveMs / durationMs) * 100)))
}

export function elearningLearnerVideoProgressLabel(
  status: ElearningLearnerVideoStatus,
  effectiveMs: number,
  durationMs: number,
  isZh: boolean,
): string {
  if (status === 'in_progress') {
    return `${elearningLabel('video.inProgress', isZh)} ${elearningWatchProgressPercent(effectiveMs, durationMs)}%`
  }
  return elearningVideoStatusLabel(status, isZh)
}

export type ElearningTrueFalseOption = { id: 'true' | 'false'; text: string }

export function elearningTrueFalseOptions(isZh: boolean): ElearningTrueFalseOption[] {
  return [
    { id: 'true', text: elearningLabel('admin.trueOption', isZh) },
    { id: 'false', text: elearningLabel('admin.falseOption', isZh) },
  ]
}

export function elearningFailure(code: string, status: number, isZh: boolean): string {
  return isZh ? `失败：${code}（${status}）` : `Failed: ${code} (${status})`
}

export function elearningQuestionPoints(points: number, isZh: boolean): string {
  return isZh ? `分值 ${points}` : `${points} points`
}

export function elearningLatestAttempt(
  autoScore: number | null,
  totalScore: number | null,
  passed: boolean | null,
  isZh: boolean,
): string {
  const outcome = passed
    ? elearningLabel('status.passed', isZh)
    : elearningLabel('status.failed', isZh)
  return isZh
    ? `最近成绩：${autoScore ?? ''} / ${totalScore ?? ''} · ${outcome}`
    : `Latest score: ${autoScore ?? ''} / ${totalScore ?? ''} · ${outcome}`
}

export function elearningExamScore(
  autoScore: number,
  totalScore: number,
  passed: boolean,
  isZh: boolean,
): string {
  const outcome = passed
    ? elearningLabel('status.passed', isZh)
    : elearningLabel('status.failed', isZh)
  return isZh
    ? `得分 ${autoScore} / ${totalScore} · ${outcome}`
    : `Score ${autoScore} / ${totalScore} · ${outcome}`
}

export function elearningExamAnswerProgress(
  answered: number,
  total: number,
  isZh: boolean,
): string {
  return isZh ? `已答 ${answered} / ${total}` : `Answered ${answered} of ${total}`
}

export function elearningCorrectOptionAria(optionId: string, isZh: boolean): string {
  return isZh ? `正确答案 ${optionId}` : `Correct answer ${optionId}`
}

export function elearningOptionAria(index: number, isZh: boolean): string {
  return isZh ? `选项 ${index}` : `Option ${index}`
}

export function elearningAssignIncomplete(errorText: string, isZh: boolean): string {
  return isZh
    ? `课程已发布，指派未完成。${errorText} 可重试指派，无需重新发布。`
    : `The course was published, but assignment did not complete. ${errorText} You can retry assignment without publishing again.`
}

export function elearningSelectedFile(fileName: string, isZh: boolean): string {
  return isZh ? `已选择：${fileName}` : `Selected: ${fileName}`
}
