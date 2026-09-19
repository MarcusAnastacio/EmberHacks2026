import { LearningContext } from '../context/learningContext';
import { generateText } from '../llm/geminiClient';
import { buildQuizPrompt } from '../llm/prompts';
import { CodeReference, Quiz, QuizMode } from './models';
import { CodeSymbol } from '../analysis/codeSymbol';

export async function generateQuiz(
	apiKey: string,
	learningContext: LearningContext,
	mode: QuizMode,
): Promise<Quiz> {
	const response = await generateText(apiKey, buildQuizPrompt(learningContext, mode));
	return parseQuiz(response, learningContext);
}

function parseQuiz(text: string, context: LearningContext): Quiz {
	const jsonText = text.replace(/^```json\s*/i, '').replace(/\s*```$/i, '').trim();
	const quiz = JSON.parse(jsonText) as Quiz;
	if (!quiz.title || !quiz.overview || !Array.isArray(quiz.questions) || quiz.questions.length !== 5) {
		throw new Error('Gemini returned a quiz that does not contain exactly 5 questions. Try generating it again.');
	}
	for (const question of quiz.questions) {
		if (!question.question || !Array.isArray(question.choices) || question.choices.length !== 4 || !question.explanation || !question.concept ||
			!['easy', 'medium', 'hard'].includes(question.difficulty) ||
			!Number.isInteger(question.answer) || question.answer < 0 || question.answer >= question.choices.length) {
			throw new Error('Gemini returned an invalid four-choice question. Try generating it again.');
		}
		question.reference = normalizeCodeReference(question.reference, context);
	}
	return quiz;
}

function normalizeCodeReference(value: unknown, context: LearningContext): CodeReference | undefined {
	if (!value || typeof value !== 'object') {
		return undefined;
	}
	const reference = value as Partial<CodeReference>;
	if (typeof reference.filePath !== 'string') {
		return undefined;
	}
	const referencedFilePath = reference.filePath;
	const files = new Set([
		context.activeFilePath,
		...(context.relevantContext ?? []).map(item => item.filePath),
		...(context.codeSymbols ?? []).map(symbol => symbol.filePath),
	]);
	const filePath = [...files].find(file => samePath(file, referencedFilePath));
	if (!filePath) {
		return undefined;
	}
	if (typeof reference.symbolName !== 'string' || !reference.symbolName.trim()) {
		return undefined;
	}
	const symbol = flattenSymbols([
		...(context.codeSymbols ?? []),
		...(context.relevantContext ?? []).flatMap(item => item.symbol ? [item.symbol] : []),
	]).find(candidate => samePath(candidate.filePath, filePath) && candidate.name === reference.symbolName);
	if (!symbol) {
		return undefined;
	}
	if (reference.startLine !== symbol.startLine || reference.endLine !== symbol.endLine) {
		return undefined;
	}
	return {
		filePath,
		symbolName: symbol.name,
		startLine: symbol.startLine,
		endLine: symbol.endLine,
	};
}

function flattenSymbols(symbols: CodeSymbol[]): CodeSymbol[] {
	return symbols.flatMap(symbol => [symbol, ...flattenSymbols(symbol.children ?? [])]);
}

function samePath(left: string, right: string): boolean {
	return left.replace(/\\/g, '/').toLowerCase() === right.replace(/\\/g, '/').toLowerCase();
}
