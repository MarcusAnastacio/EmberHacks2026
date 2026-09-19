export type QuizMode = 'guided' | 'architecture' | 'challenge';

export interface QuizQuestion {
	question: string;
	choices: string[];
	answer: number;
	explanation: string;
	concept: string;
}

export interface Quiz {
	title: string;
	overview: string;
	questions: QuizQuestion[];
}

const modePrompts: Record<QuizMode, string> = {
	guided: 'Teach like a patient mentor. Start with fundamentals, trace the code from input to output, and use clear explanations.',
	architecture: 'Teach the design. Focus on responsibilities, data flow, dependencies, tradeoffs, and why the code is structured this way.',
	challenge: 'Teach by retrieval practice. Ask scenario-based questions that make the learner predict behavior, debug a mistake, or rebuild a small piece.',
};

const preferredModels = [
	'gemini-3.8-flash',
	'gemini-3.7-flash',
	'gemini-3.6-flash',
	'gemini-3.5-flash',
	'gemini-2.5-flash',
	'gemini-2.5-flash-lite',
	'gemini-2.5-pro',
];

const maxTransientAttempts = 3;
const transientRetryDelays = [1000, 2500, 5000];

export async function generateQuiz(apiKey: string, code: string, fileName: string, mode: QuizMode): Promise<Quiz> {
	const prompt = [
		'You create educational quizzes for developers learning code written by an AI agent.',
		modePrompts[mode],
		`Analyze the following source file (${fileName}). Do not assume behavior that is not supported by the code.`,
		'Create 5 multiple-choice questions that teach the learner how this code works.',
		'Each answer must be the zero-based index of the correct choice.',
		'Return only valid JSON with this exact shape: {"title": string, "overview": string, "questions": [{"question": string, "choices": string[], "answer": number, "explanation": string, "concept": string}]}',
		'Keep choices plausible, explanations specific, and questions independent.',
		`SOURCE CODE:\n${code}`,
	].join('\n\n');

	const response = await requestGemini(apiKey, prompt);
	return parseQuiz(response);
}

async function requestGemini(apiKey: string, prompt: string): Promise<string> {
	const body = JSON.stringify({
		contents: [{ parts: [{ text: prompt }] }],
		generationConfig: {
			temperature: 0.35,
			responseMimeType: 'application/json',
		},
	});

	const models = await listGenerateContentModels(apiKey);
	const orderedModels = [
		...preferredModels.filter(candidate => models.includes(candidate)),
		...models.filter(model => !preferredModels.includes(model)),
	];
	if (orderedModels.length === 0) {
		throw new Error('Gemini returned no models that support generateContent for this API key. Check the key project and API access.');
	}
	return requestWithModel(apiKey, body, orderedModels, 0);
}

async function listGenerateContentModels(apiKey: string): Promise<string[]> {
	try {
		const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`);
		const data = await response.text();
		if (!response.ok) {
			throw new Error(formatGeminiError(response.status, data, 'model discovery'));
		}
		const parsed = JSON.parse(data) as { models?: Array<{ name?: string; supportedGenerationMethods?: string[] }> };
		return parsed.models
			?.filter(model => model.supportedGenerationMethods?.includes('generateContent'))
			.map(model => model.name?.replace(/^models\//, ''))
			.filter((model): model is string => Boolean(model)) ?? [];
	} catch (error) {
		if (error instanceof Error && error.message.startsWith('Gemini ')) {
			throw error;
		}
		throw new Error(`Could not reach Gemini: ${error instanceof Error ? error.message : 'network request failed'}`);
	}
}

async function requestWithModel(apiKey: string, body: string, models: string[], modelIndex: number): Promise<string> {
	const model = models[modelIndex];
	let lastTransientError = '';
	for (let attempt = 0; attempt < maxTransientAttempts; attempt++) {
		try {
			return await requestOnce(apiKey, body, model);
		} catch (error) {
			if (!(error instanceof GeminiHttpError) || !isTransientStatus(error.status)) {
				throw error;
			}
			lastTransientError = error.message;
			if (attempt < maxTransientAttempts - 1) {
				await delay(transientRetryDelays[attempt]);
			}
		}
	}

	if (modelIndex < models.length - 1) {
		return requestWithModel(apiKey, body, models, modelIndex + 1);
	}
	throw new Error(`${lastTransientError} Tried ${maxTransientAttempts} times on ${models.length} available model(s).`);
}

async function requestOnce(apiKey: string, body: string, model: string): Promise<string> {
	try {
		const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body,
		});
		const data = await response.text();
		if (!response.ok) {
			throw new GeminiHttpError(response.status, formatGeminiError(response.status, data, model));
		}
		try {
			const parsed = JSON.parse(data) as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
			const text = parsed.candidates?.[0]?.content?.parts?.[0]?.text;
			if (!text) {
				throw new Error('Gemini returned an empty response.');
			}
			return text;
		} catch (error) {
			if (error instanceof Error && error.message === 'Gemini returned an empty response.') {
				throw error;
			}
			throw new Error('Gemini returned an unreadable response.');
		}
	} catch (error) {
		if (error instanceof Error && error.message.startsWith('Gemini ')) {
			throw error;
		}
		throw new Error(`Could not reach Gemini: ${error instanceof Error ? error.message : 'network request failed'}`);
	}
}

class GeminiHttpError extends Error {
	public constructor(public readonly status: number, message: string) {
		super(message);
		this.name = 'GeminiHttpError';
	}
}

function isTransientStatus(status: number): boolean {
	return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

function delay(milliseconds: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function formatGeminiError(statusCode: number | undefined, body: string, model: string): string {
	let providerMessage = '';
	try {
		const parsed = JSON.parse(body) as { error?: { message?: string } };
		providerMessage = parsed.error?.message ?? '';
	} catch {
		providerMessage = '';
	}
	const status = statusCode ?? 'unknown status';
	if (status === 404) {
		return `Gemini could not find ${model}. Check that the Generative Language API is enabled for the project that owns this key and that the key can access Gemini models.`;
	}
	if (status === 401 || status === 403) {
		return `Gemini rejected the API key (${status}). ${providerMessage || 'Check the key restrictions and enabled API.'}`;
	}
	if (status === 429) {
		return `Gemini quota or rate limit exceeded. ${providerMessage || 'Wait and try again, or check billing and quotas.'}`;
	}
	return `Gemini request failed (${status}). ${providerMessage || 'Check the API key, model access, and quota.'}`;
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
