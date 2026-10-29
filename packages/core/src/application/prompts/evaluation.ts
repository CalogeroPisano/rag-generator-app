/**
 * Test questions of the RAG chat: generated from the cards, then answered by
 * the chat and judged against the card they come from.
 */
import { Schema } from "effect"
import { AnswerVerdict } from "../../domain/card.ts"
import type { PromptRef } from "../../ports/outbound/models.ts"

export const TEST_QUESTIONS: PromptRef = { id: "test-questions", version: 1 }
export const ANSWER_JUDGE: PromptRef = { id: "answer-judge", version: 1 }

export const TestQuestionsOutput = Schema.Struct({
  questions: Schema.Array(
    Schema.Struct({
      question: Schema.String,
      expectedAnswer: Schema.String.annotate({ description: "One or two sentences, based only on the card." })
    })
  )
})
export type TestQuestionsOutput = typeof TestQuestionsOutput.Type

export const testQuestionsInstructions = (options: { readonly language: string; readonly count: number }) =>
  [
    "You write test questions for the documentation chatbot of a software application.",
    `From the functional card below, write ${options.count} different questions that an end user could ask and that`,
    "the card answers. Cover different aspects when the card has them: what the feature does, how to configure it,",
    "a parameter, a limit or validation rule, an error. Phrase them as a user would, without code identifiers the",
    "user would not see. For each question give the expected answer, based only on the card.",
    `Write questions and answers in ${options.language}.`,
    "Credentials are masked as [REDACTED:<rule>]: never guess or reproduce them.",
    "Answer with a single JSON object matching the requested schema, without any other text."
  ].join("\n")

export const renderTestQuestions = (input: { readonly card: string }): string => `Card:\n${input.card}`

export const AnswerJudgeOutput = Schema.Struct({
  verdict: AnswerVerdict.annotate({
    description:
      "correct: answers the question and agrees with the card; partial: incomplete or partly wrong; incorrect: wrong or contradicts the card; no_answer: the chatbot did not answer."
  }),
  note: Schema.String.annotate({ description: "One short sentence explaining the verdict." })
})
export type AnswerJudgeOutput = typeof AnswerJudgeOutput.Type

export const answerJudgeInstructions = [
  "You evaluate an answer of a documentation chatbot.",
  "You get the question, the functional card of the feature the question is about, possibly the expected answer,",
  "and the chatbot's answer. Judge the content against the card, not the wording or the language.",
  "An answer that adds correct details from other features is still correct.",
  "Write the note in English.",
  "Answer with a single JSON object matching the requested schema, without any other text."
].join("\n")

export const renderAnswerJudge = (input: {
  readonly question: string
  /** Rendered with `renderCardText`. */
  readonly card: string
  readonly expectedAnswer: string | null
  readonly answer: string
}): string =>
  [
    `Question: ${input.question}`,
    `Card:\n${input.card}`,
    ...(input.expectedAnswer === null ? [] : [`Expected answer: ${input.expectedAnswer}`]),
    `Chatbot answer:\n${input.answer}`
  ].join("\n\n")
