import { LearningContext } from '../context/learningContext';
import { generateText } from '../llm/geminiClient';
import { buildQuizPrompt } from '../llm/prompts';
import { Quiz, QuizMode } from './models';

export async function generateQuiz(
	apiKey: string,
	learningContext: LearningContext,
	mode: QuizMode,
): Promise<Quiz> {
	const response = await generateText(apiKey, buildQuizPrompt(learningContext, mode));
	return parseQuiz(response);
}

function parseQuiz(text: string): Quiz {
	const jsonText = text.replace(/^```json\s*/i, '').replace(/\s*```$/i, '').trim();
	const quiz = JSON.parse(jsonText) as Quiz;
	if (!quiz.title || !quiz.overview || !Array.isArray(quiz.questions) || quiz.questions.length === 0) {
		throw new Error('Gemini returned an incomplete quiz. Try generating it again.');
	}
	for (const question of quiz.questions) {
		if (!question.question || !Array.isArray(question.choices) || question.choices.length < 2 ||
			!Number.isInteger(question.answer) || question.answer < 0 || question.answer >= question.choices.length) {
			throw new Error('Gemini returned an invalid question. Try generating it again.');
		}
	}
	return quiz;
}
