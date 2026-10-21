import { describe, expect, it } from 'vitest'

import {
  ElearningPracticeError,
  hashElearningPracticeRequest,
  isElearningPracticeAnswerCorrect,
  normalizePracticeMode,
  normalizePracticeSelectedOptionIds,
  orderElearningPracticeQuestions,
  parseElearningPracticeStoredQuestion,
  publicElearningPracticeQuestion,
} from '../../src/services/elearning-question-practice'

const SESSION = '11111111-1111-4111-8111-111111111111'

function question(position = 1) {
  return parseElearningPracticeStoredQuestion({
    position,
    questionRevisionId: `22222222-2222-4222-8222-${String(position).padStart(12, '0')}`,
    questionId: `33333333-3333-4333-8333-${String(position).padStart(12, '0')}`,
    questionType: position === 2 ? 'multiple_choice' : 'single_choice',
    prompt: `Question ${position}`,
    options: [
      { id: 'a', text: 'A' },
      { id: 'b', text: 'B' },
    ],
    points: position,
    answerKey: { correct: position === 2 ? ['b', 'a'] : ['a'] },
    explanation: 'secret explanation',
  })
}

function expectCode(action: () => unknown, code: string): void {
  try {
    action()
    throw new Error('expected practice error')
  } catch (error) {
    expect(error).toBeInstanceOf(ElearningPracticeError)
    expect((error as ElearningPracticeError).code).toBe(code)
    expect((error as Error).message).toBe(code)
  }
}

describe('e-learning question practice policy', () => {
  it('returns a closed learner question without answer keys or explanations', () => {
    const result = publicElearningPracticeQuestion(question())
    expect(result).toEqual({
      questionId: '33333333-3333-4333-8333-000000000001',
      questionRevisionId: '22222222-2222-4222-8222-000000000001',
      questionType: 'single_choice',
      prompt: 'Question 1',
      options: [{ id: 'a', text: 'A' }, { id: 'b', text: 'B' }],
      points: 1,
      position: 1,
    })
    expect(JSON.stringify(result)).not.toMatch(/answer|explanation|correct/)
  })

  it('supports objective questions only and rejects stored drift values-free', () => {
    for (const questionType of ['single_choice', 'multiple_choice', 'true_false']) {
      expect(parseElearningPracticeStoredQuestion({
        ...question(),
        questionType,
        answerKey: { correct: ['a'] },
      }).questionType).toBe(questionType)
    }
    expectCode(() => parseElearningPracticeStoredQuestion({
      ...question(),
      questionType: 'short_answer',
      prompt: 'secret stored value',
    }), 'unavailable')
  })

  it('uses a deterministic session seed for random order', () => {
    const questions = [question(1), question(2), question(3), question(4)]
    const first = orderElearningPracticeQuestions(questions, 'random', SESSION)
    const replay = orderElearningPracticeQuestions(questions, 'random', SESSION)
    expect(replay.map((item) => item.questionRevisionId))
      .toEqual(first.map((item) => item.questionRevisionId))
    expect(first.map((item) => item.position)).toEqual([1, 2, 3, 4])
  })

  it('projects wrong-book questions without changing paper order', () => {
    const questions = [question(1), question(2), question(3)]
    const selected = orderElearningPracticeQuestions(
      questions,
      'wrong_book',
      SESSION,
      new Set([questions[2]!.questionRevisionId, questions[0]!.questionRevisionId]),
    )
    expect(selected.map((item) => item.questionRevisionId)).toEqual([
      questions[0]!.questionRevisionId,
      questions[2]!.questionRevisionId,
    ])
    expect(selected.map((item) => item.position)).toEqual([1, 2])
  })

  it('canonicalizes selected options and grades without disclosing the key', () => {
    const multiple = question(2)
    const selected = normalizePracticeSelectedOptionIds(multiple, ['b', 'a'])
    expect(selected).toEqual(['a', 'b'])
    expect(isElearningPracticeAnswerCorrect(multiple, selected)).toBe(true)
    expect(isElearningPracticeAnswerCorrect(multiple, ['a'])).toBe(false)
  })

  it('rejects duplicate, unknown, and multi-select single-choice answers', () => {
    const single = question(1)
    for (const selected of [['a', 'a'], ['unknown'], ['a', 'b'], 'a']) {
      expectCode(() => normalizePracticeSelectedOptionIds(single, selected), 'invalid_input')
    }
  })

  it('hashes logical commands deterministically and distinguishes changed payloads', () => {
    const first = hashElearningPracticeRequest('answer', {
      sessionId: SESSION,
      selectedOptionIds: ['a', 'b'],
    })
    const reorderedKeys = hashElearningPracticeRequest('answer', {
      selectedOptionIds: ['a', 'b'],
      sessionId: SESSION,
    })
    const changed = hashElearningPracticeRequest('answer', {
      selectedOptionIds: ['a'],
      sessionId: SESSION,
    })
    expect(reorderedKeys).toBe(first)
    expect(changed).not.toBe(first)
    expect(first).toMatch(/^[0-9a-f]{64}$/)
  })

  it('accepts only the closed practice mode set', () => {
    expect(normalizePracticeMode('sequential')).toBe('sequential')
    expect(normalizePracticeMode('random')).toBe('random')
    expect(normalizePracticeMode('wrong_book')).toBe('wrong_book')
    expectCode(() => normalizePracticeMode('exam'), 'invalid_input')
  })
})
