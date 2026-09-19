import { LearningContext } from '../context/learningContext';
import { buildGeminiContext } from '../context/contextSelector';
import { QuizMode } from '../quiz/models';

const modePrompts: Record<QuizMode, string> = {
	guided: 'Teach like a patient mentor. Start with fundamentals, trace the code from input to output, and use clear explanations.',
	architecture: 'Teach the design. Focus on responsibilities, data flow, dependencies, tradeoffs, and why the code is structured this way.',
	challenge: 'Teach by retrieval practice. Ask scenario-based questions that make the learner predict behavior, debug a mistake, or rebuild a small piece.',
};

export function buildQuizPrompt(context: LearningContext, mode: QuizMode): string {
	return [
		'You create educational quizzes for developers learning code written by an AI agent.',
		modePrompts[mode],
		'Use only the compact context below as evidence. Do not assume it represents the entire workspace.',
		'Explain only observable code and Git artifacts. Do not invent or infer private agent chain-of-thought.',
		buildGeminiContext(context),
		'Create 5 multiple-choice questions that teach the learner how this code works.',
		'Each answer must be the zero-based index of the correct choice.',
		'Return only valid JSON with this exact shape: {"title": string, "overview": string, "questions": [{"question": string, "choices": string[], "answer": number, "explanation": string, "concept": string}]}',
		'Keep choices plausible, explanations specific, and questions independent.',
	].filter(Boolean).join('\n\n');
}
