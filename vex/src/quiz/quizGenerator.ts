import { LearningContext } from '../context/learningContext';
import { generateText } from '../llm/geminiClient';
import { buildQuizPrompt } from '../llm/prompts';
import { CodeReference, Quiz, QuizMode } from './models';
import { CodeSymbol } from '../analysis/codeSymbol';
import { CacheStore, hashContent } from '../cache/cacheStore';
import { buildGeminiContext } from '../context/contextSelector';

export interface QuizGenerationOptions {
	cache?: CacheStore;
	bypassCache?: boolean;
	questionCount?: number;
}

export async function generateQuiz(
	apiKey: string,
	learningContext: LearningContext,
	mode: QuizMode,
	options: QuizGenerationOptions = {},
): Promise<Quiz> {
	const questionCount = options.questionCount ?? 5;
	const contextHash = hashContent(buildGeminiContext(learningContext));
	const profileHash = hashContent(JSON.stringify(learningContext.learnerProfile ?? {}));
	const cacheKey = `quiz.${hashContent(JSON.stringify({ contextHash, mode, difficulty: learningContext.learnerProfile?.approximateDifficulty ?? 'medium', profileHash, questionCount }))}`;
	if (!options.bypassCache) {
		const cachedQuiz = options.cache?.get<Quiz>(cacheKey);
		if (cachedQuiz) {
			console.info('[VEX cache] retrieved quiz; relevant context unchanged.');
			console.info('[VEX Gemini] request retrieved from cache; skipped because no relevant changes occurred.');
			return cachedQuiz;
		}
	}
	const response = await generateText(apiKey, buildQuizPrompt(learningContext, mode));
	const quiz = parseQuiz(response, learningContext);
	await options.cache?.set(cacheKey, quiz);
	console.info(options.bypassCache ? '[VEX Gemini] request generated; quiz cache bypassed.' : '[VEX Gemini] request generated; no matching quiz cache entry.');
	return quiz;
}

function parseQuiz(text: string, context: LearningContext): Quiz {
	const jsonText = text.replace(/^```json\s*/i, '').replace(/\s*```$/i, '').trim();
	let quiz: Quiz;
	try {
		quiz = JSON.parse(jsonText) as Quiz;
	} catch {
		throw new Error('Gemini returned malformed JSON instead of a quiz. Try generating it again.');
	}
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
