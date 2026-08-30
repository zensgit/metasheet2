// V0.1 e-learning chrome string table — single source for
// ElearningLearnerView.vue, ElearningAdminView.vue, and the L3
// ElearningManualGradingView.vue / ElearningManualGradingAttempt.vue pair.
//
// EN + ZH both explicit (same convention as workbench-labels.ts and
// meta-core-labels.ts). Components read `useLocale().isZh` and call
// `elearningLabel(key, isZh)` for static strings, or the interpolation
// helpers below for strings with scores / ids / error codes.
//
// NOT translated (user/data values): course titles, question prompts,
// already-entered choice option texts, deadlines, ids, URLs, learner
// answers, and backend error codes. Error codes and HTTP statuses are
// interpolated raw. True/false option drafts are UI-owned defaults (not
// user data) and are localized when the question type is switched to
// true_false.

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
  | 'learner.examTimeRemaining'
  | 'learner.examExpired'
  | 'learner.submitExam'
  | 'learner.awaitingManual'
  | 'learner.contentItems'
  | 'learner.contentArticle'
  | 'learner.contentExternalLink'
  | 'learner.contentOpen'
  | 'learner.contentOpening'
  | 'learner.contentOpenLink'
  | 'learner.contentOpened'
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
  | 'admin.assessmentOpen'
  | 'admin.assessmentClose'
  | 'contentAdmin.title'
  | 'contentAdmin.subtitle'
  | 'contentAdmin.courseTitle'
  | 'contentAdmin.itemTitle'
  | 'contentAdmin.articleBody'
  | 'contentAdmin.externalUrl'
  | 'contentAdmin.addArticle'
  | 'contentAdmin.addLink'
  | 'contentAdmin.remove'
  | 'contentAdmin.moveUp'
  | 'contentAdmin.moveDown'
  | 'contentAdmin.optionalAssignee'
  | 'contentAdmin.publish'
  | 'contentAdmin.publishing'
  | 'contentAdmin.publishSuccess'
  // --- Assessment resource admin chrome ---
  | 'assessment.title'
  | 'assessment.subtitle'
  | 'assessment.loading'
  | 'assessment.refresh'
  | 'assessment.previousPage'
  | 'assessment.nextPage'
  | 'assessment.bankTitle'
  | 'assessment.createBank'
  | 'assessment.bankSelect'
  | 'assessment.noBanks'
  | 'assessment.importFile'
  | 'assessment.import'
  | 'assessment.questions'
  | 'assessment.noQuestions'
  | 'assessment.correctAnswers'
  | 'assessment.explanation'
  | 'assessment.paperTitle'
  | 'assessment.publishPaper'
  | 'assessment.examTitle'
  | 'assessment.duration'
  | 'assessment.shuffleQuestions'
  | 'assessment.shuffleOptions'
  | 'assessment.disclosure'
  | 'assessment.disclosureNoReview'
  | 'assessment.disclosureCorrectness'
  | 'assessment.disclosureWrongItems'
  | 'assessment.publishExam'
  | 'assessment.unbound'
  | 'assessment.startAnother'
  // --- L3 manual grading chrome ---
  | 'grading.title'
  | 'grading.subtitle'
  | 'grading.loadingQueue'
  | 'grading.refresh'
  | 'grading.previousPage'
  | 'grading.nextPage'
  | 'grading.queueEmpty'
  | 'grading.columnLearner'
  | 'grading.columnExam'
  | 'grading.columnCourse'
  | 'grading.columnSubmitted'
  | 'grading.columnProgress'
  | 'grading.openAttempt'
  | 'grading.detailLoading'
  | 'grading.backToQueue'
  | 'grading.learnerIdLabel'
  | 'grading.learnerAnswerLabel'
  | 'grading.scoreLabel'
  | 'grading.commentLabel'
  | 'grading.commentPlaceholder'
  | 'grading.submit'
  | 'grading.submitting'
  | 'grading.duplicateNotice'
  | 'grading.completeNotice'
  | 'grading.conflictRefreshNotice'
  | 'grading.error403'
  | 'grading.error404'
  | 'grading.error409'
  | 'grading.error503'
  | 'grading.scoreRequired'
  | 'grading.scoreInteger'
  | 'grading.clientIdUnavailable'
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
  | 'validation.bankTitleRequired'
  | 'validation.bankRequired'
  | 'validation.xlsxRequired'
  | 'validation.questionSelectionRequired'
  | 'validation.paperTitleRequired'
  | 'validation.examTitleRequired'
  | 'validation.durationInteger'
  | 'validation.contentItemRequired'
  | 'validation.contentItemTitleRequired'
  | 'validation.articleBodyRequired'
  | 'validation.externalUrlRequired'

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
  'learner.examTimeRemaining': { en: 'Time remaining', zh: '剩余时间' },
  'learner.examExpired': {
    en: 'The server has closed this timed attempt. Your answers are locked.',
    zh: '服务端已结束本次限时考试，答卷已锁定。',
  },
  'learner.submitExam': { en: 'Submit answers', zh: '提交答卷' },
  'learner.awaitingManual': {
    en: 'Submitted. Waiting for manual grading.',
    zh: '已提交，等待人工阅卷。',
  },
  'learner.contentItems': { en: 'Course content', zh: '课程内容' },
  'learner.contentArticle': { en: 'Article', zh: '文章' },
  'learner.contentExternalLink': { en: 'External link', zh: '外部链接' },
  'learner.contentOpen': { en: 'Open and mark complete', zh: '打开并记录完成' },
  'learner.contentOpening': { en: 'Opening...', zh: '正在打开…' },
  'learner.contentOpenLink': { en: 'Open external content', zh: '打开外部内容' },
  'learner.contentOpened': { en: 'Completion recorded.', zh: '已记录完成。' },

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
  'admin.assessmentOpen': { en: 'Manage assessment resources', zh: '管理题库与考试' },
  'admin.assessmentClose': { en: 'Close assessment resources', zh: '收起题库与考试' },

  'contentAdmin.title': { en: 'Article and link course', zh: '文章与链接课程' },
  'contentAdmin.subtitle': {
    en: 'Build an ordered course from server-sanitized articles and HTTPS links.',
    zh: '使用服务端净化的文章和 HTTPS 链接按顺序创建课程。',
  },
  'contentAdmin.courseTitle': { en: 'Content course title', zh: '内容课程标题' },
  'contentAdmin.itemTitle': { en: 'Item title', zh: '内容标题' },
  'contentAdmin.articleBody': { en: 'Article HTML', zh: '文章 HTML' },
  'contentAdmin.externalUrl': { en: 'HTTPS URL', zh: 'HTTPS 链接' },
  'contentAdmin.addArticle': { en: 'Add article', zh: '添加文章' },
  'contentAdmin.addLink': { en: 'Add external link', zh: '添加外部链接' },
  'contentAdmin.remove': { en: 'Remove', zh: '删除' },
  'contentAdmin.moveUp': { en: 'Move up', zh: '上移' },
  'contentAdmin.moveDown': { en: 'Move down', zh: '下移' },
  'contentAdmin.optionalAssignee': {
    en: 'Assignee (optional user ID)',
    zh: '指派对象（可选用户 ID）',
  },
  'contentAdmin.publish': { en: 'Publish content course', zh: '发布内容课程' },
  'contentAdmin.publishing': { en: 'Publishing content course...', zh: '正在发布内容课程…' },
  'contentAdmin.publishSuccess': { en: 'Content course published.', zh: '内容课程已发布。' },

  'assessment.title': { en: 'Assessment resources', zh: '题库与考试资源' },
  'assessment.subtitle': {
    en: 'Create a bank, import an XLSX question set, select immutable revisions, then publish a fixed paper and an independent exam template.',
    zh: '创建题库、导入 XLSX 题目、选择不可变题目版本，再发布固定试卷和独立考试模板。',
  },
  'assessment.loading': { en: 'Loading assessment resources...', zh: '正在加载题库与考试资源…' },
  'assessment.refresh': { en: 'Refresh', zh: '刷新' },
  'assessment.previousPage': { en: 'Previous', zh: '上一页' },
  'assessment.nextPage': { en: 'Next', zh: '下一页' },
  'assessment.bankTitle': { en: 'New bank title', zh: '新题库名称' },
  'assessment.createBank': { en: 'Create bank', zh: '创建题库' },
  'assessment.bankSelect': { en: 'Question bank', zh: '题库' },
  'assessment.noBanks': { en: 'No question banks yet.', zh: '暂无题库。' },
  'assessment.importFile': { en: 'Question workbook (.xlsx)', zh: '题目工作簿（.xlsx）' },
  'assessment.import': { en: 'Import questions', zh: '导入题目' },
  'assessment.questions': { en: 'Latest question revisions', zh: '最新题目版本' },
  'assessment.noQuestions': { en: 'No questions in this bank.', zh: '该题库暂无题目。' },
  'assessment.correctAnswers': { en: 'Correct answers', zh: '正确答案' },
  'assessment.explanation': { en: 'Explanation', zh: '解析' },
  'assessment.paperTitle': { en: 'Paper title', zh: '试卷名称' },
  'assessment.publishPaper': { en: 'Publish fixed paper', zh: '发布固定试卷' },
  'assessment.examTitle': { en: 'Exam title', zh: '考试名称' },
  'assessment.duration': { en: 'Duration in minutes (optional)', zh: '限时分钟数（可选）' },
  'assessment.shuffleQuestions': { en: 'Shuffle questions', zh: '题目乱序' },
  'assessment.shuffleOptions': { en: 'Shuffle options', zh: '选项乱序' },
  'assessment.disclosure': { en: 'Answer disclosure', zh: '答案披露策略' },
  'assessment.disclosureNoReview': { en: 'No review', zh: '不开放复盘' },
  'assessment.disclosureCorrectness': { en: 'Correctness after submission', zh: '交卷后显示正误' },
  'assessment.disclosureWrongItems': { en: 'Wrong items after submission', zh: '交卷后显示错题' },
  'assessment.publishExam': { en: 'Publish independent exam', zh: '发布独立考试' },
  'assessment.unbound': {
    en: 'This exam template is published but is not assigned to learners or bound to a course yet.',
    zh: '该考试模板已发布，但尚未指派给学员，也尚未绑定课程。',
  },
  'assessment.startAnother': { en: 'Create another paper', zh: '继续创建新试卷' },

  'grading.title': { en: 'Manual Grading', zh: '人工阅卷' },
  'grading.subtitle': {
    en: 'Grade the selected learner\'s short-answer questions. Objective questions, answer keys, explanations, rubrics, and raw snapshots are never shown here.',
    zh: '评阅所选学员答卷中的简答题。此处永不显示客观题、标准答案、解析、评分细则或原始快照。',
  },
  'grading.loadingQueue': { en: 'Loading the grading queue...', zh: '正在加载阅卷队列…' },
  'grading.refresh': { en: 'Refresh', zh: '刷新' },
  'grading.previousPage': { en: 'Previous', zh: '上一页' },
  'grading.nextPage': { en: 'Next', zh: '下一页' },
  'grading.queueEmpty': { en: 'No attempts are waiting for grading.', zh: '暂无待阅卷答卷。' },
  'grading.columnLearner': { en: 'Learner', zh: '学员' },
  'grading.columnExam': { en: 'Exam', zh: '考试' },
  'grading.columnCourse': { en: 'Course', zh: '课程' },
  'grading.columnSubmitted': { en: 'Submitted', zh: '提交时间' },
  'grading.columnProgress': { en: 'Graded', zh: '已评' },
  'grading.openAttempt': { en: 'Grade', zh: '评阅' },
  'grading.detailLoading': { en: 'Loading attempt...', zh: '正在加载答卷…' },
  'grading.backToQueue': { en: 'Back to queue', zh: '返回队列' },
  'grading.learnerIdLabel': { en: 'Learner ID', zh: '学员 ID' },
  'grading.learnerAnswerLabel': { en: 'Learner answer', zh: '学员作答' },
  'grading.scoreLabel': { en: 'Score', zh: '分值' },
  'grading.commentLabel': { en: 'Comment (optional)', zh: '评语（可选）' },
  'grading.commentPlaceholder': {
    en: 'Private note for this grade (optional)',
    zh: '本次评分的内部备注（可选）',
  },
  'grading.submit': { en: 'Submit grade', zh: '提交评分' },
  'grading.submitting': { en: 'Submitting...', zh: '正在提交…' },
  'grading.duplicateNotice': {
    en: 'This grade was already recorded; no changes were made.',
    zh: '该评分此前已记录，本次未产生变更。',
  },
  'grading.completeNotice': {
    en: 'All short-answer questions are graded. This attempt is finalized.',
    zh: '全部简答题已评阅完毕，该答卷已定稿。',
  },
  'grading.conflictRefreshNotice': {
    en: 'The attempt changed elsewhere. The queue was refreshed from the first page.',
    zh: '该答卷已在别处发生变化，待评分队列已从第一页重新刷新。',
  },
  'grading.error403': {
    en: 'You do not have access to grade this attempt.',
    zh: '您无权评阅该答卷。',
  },
  'grading.error404': {
    en: 'This attempt is unavailable or has already been graded.',
    zh: '该答卷不可用，或已被评阅完毕。',
  },
  'grading.error409': {
    en: 'The grading state changed elsewhere. Refresh and try again.',
    zh: '阅卷状态已在别处发生变化，请刷新后重试。',
  },
  'grading.error503': {
    en: 'Grading is temporarily unavailable. Please try again shortly.',
    zh: '阅卷功能暂不可用，请稍后重试。',
  },
  'grading.scoreRequired': { en: 'Please enter a score.', zh: '请输入分值。' },
  'grading.scoreInteger': { en: 'Score must be a whole number.', zh: '分值须为整数。' },
  'grading.clientIdUnavailable': {
    en: 'Your browser does not support the secure identifier required to submit a grade.',
    zh: '您的浏览器不支持提交评分所需的安全标识符。',
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
  'validation.bankTitleRequired': {
    en: 'Please enter a question-bank title.',
    zh: '请填写题库名称。',
  },
  'validation.bankRequired': {
    en: 'Please select a question bank.',
    zh: '请选择题库。',
  },
  'validation.xlsxRequired': {
    en: 'Please select an XLSX workbook.',
    zh: '请选择一个 XLSX 工作簿。',
  },
  'validation.questionSelectionRequired': {
    en: 'Select at least one question revision.',
    zh: '请至少选择一个题目版本。',
  },
  'validation.paperTitleRequired': {
    en: 'Please enter a paper title.',
    zh: '请填写试卷名称。',
  },
  'validation.examTitleRequired': {
    en: 'Please enter an exam title.',
    zh: '请填写考试名称。',
  },
  'validation.durationInteger': {
    en: 'Duration must be empty or a positive integer.',
    zh: '限时须留空或填写正整数。',
  },
  'validation.contentItemRequired': {
    en: 'Add at least one article or external link.',
    zh: '请至少添加一篇文章或一个外部链接。',
  },
  'validation.contentItemTitleRequired': {
    en: 'Enter a title for every content item.',
    zh: '请填写每项内容的标题。',
  },
  'validation.articleBodyRequired': {
    en: 'Enter article HTML.',
    zh: '请填写文章 HTML。',
  },
  'validation.externalUrlRequired': {
    en: 'Enter an HTTPS URL.',
    zh: '请填写 HTTPS 链接。',
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

export function elearningExamCountdown(remainingMs: number, isZh: boolean): string {
  const totalSeconds = Number.isFinite(remainingMs)
    ? Math.max(0, Math.ceil(remainingMs / 1000))
    : 0
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  const clock = [hours, minutes, seconds]
    .map((part) => String(part).padStart(2, '0'))
    .join(':')
  return `${elearningLabel('learner.examTimeRemaining', isZh)} ${clock}`
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

export function elearningAssessmentRevision(revision: number, isZh: boolean): string {
  return isZh ? `版本 ${revision}` : `Revision ${revision}`
}

export function elearningAssessmentImported(count: number, isZh: boolean): string {
  return isZh ? `已导入 ${count} 道题。` : `Imported ${count} questions.`
}

export function elearningAssessmentPage(
  page: number,
  total: number,
  pageSize: number,
  isZh: boolean,
): string {
  const pageCount = Math.max(1, Math.ceil(total / pageSize))
  return isZh ? `第 ${page} / ${pageCount} 页` : `Page ${page} of ${pageCount}`
}

export function elearningAssessmentPaperPublished(
  itemCount: number,
  totalPoints: number,
  isZh: boolean,
): string {
  return isZh
    ? `固定试卷已发布：${itemCount} 道题，共 ${totalPoints} 分。`
    : `Fixed paper published: ${itemCount} questions, ${totalPoints} points.`
}

export function elearningAssessmentExamPublished(totalPoints: number, isZh: boolean): string {
  return isZh
    ? `独立考试模板已发布，共 ${totalPoints} 分。`
    : `Independent exam template published with ${totalPoints} total points.`
}

// --- L3 manual grading interpolation helpers ---

export function elearningManualGradingQueuePageLabel(page: number, isZh: boolean): string {
  return isZh ? `第 ${page} 页` : `Page ${page}`
}

export function elearningManualGradingProgressLabel(
  gradedQuestions: number,
  manualQuestions: number,
): string {
  return `${gradedQuestions} / ${manualQuestions}`
}

export function elearningManualGradingScoreRangeError(maxScore: number, isZh: boolean): string {
  return isZh
    ? `请输入 0 到 ${maxScore} 之间的整数分值。`
    : `Enter a whole-number score from 0 to ${maxScore}.`
}

export function elearningManualGradingGradedLabel(
  score: number,
  maxScore: number,
  isZh: boolean,
): string {
  return isZh ? `已评分：${score} / ${maxScore}` : `Graded: ${score} / ${maxScore}`
}

// Status-keyed first: the 403 from rbacGuardAny and other non-JSON-shaped error
// bodies read back as the generic 'request_failed' code, which would otherwise
// degrade every closed state to the same message. Falls back to the generic
// elearningFailure(code, status, isZh) formatter for status codes with no
// grading-specific copy (400, 401, 500, network failures, ...).
export function elearningManualGradingErrorMessage(
  status: number,
  code: string,
  isZh: boolean,
): string {
  if (status === 403) return elearningLabel('grading.error403', isZh)
  if (status === 404) return elearningLabel('grading.error404', isZh)
  if (status === 409) return elearningLabel('grading.error409', isZh)
  if (status === 503) return elearningLabel('grading.error503', isZh)
  return elearningFailure(code, status, isZh)
}
