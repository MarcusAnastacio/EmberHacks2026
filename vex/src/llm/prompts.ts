import { LearningContext } from '../context/learningContext';
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
		`Analyze the following source file (${context.activeFilePath}). Do not assume behavior that is not supported by the code.`,
		`Programming language: ${context.programmingLanguage}`,
		context.relatedSymbols?.length ? `Related symbols: ${context.relatedSymbols.join(', ')}` : '',
		context.projectDescription ? `Project description: ${context.projectDescription}` : '',
		context.agentChangeInformation ? `Agent/change information: ${context.agentChangeInformation}` : '',
		'Create 5 multiple-choice questions that teach the learner how this code works.',
		'Each answer must be the zero-based index of the correct choice.',
		'Return only valid JSON with this exact shape: {"title": string, "overview": string, "questions": [{"question": string, "choices": string[], "answer": number, "explanation": string, "concept": string}]}',
		'Keep choices plausible, explanations specific, and questions independent.',
		`SOURCE CODE:\n${context.relevantSourceCode}`,
		context.selectedCode ? `SELECTED CODE:\n${context.selectedCode}` : '',
	].filter(Boolean).join('\n\n');
}
