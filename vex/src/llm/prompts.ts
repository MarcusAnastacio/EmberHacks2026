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
		'You create educational quizzes from a structured LearningContext for developers learning how an application works.',
		modePrompts[mode],
		'Treat the compact context below as structured evidence, not as a request to quiz the learner about raw source text.',
		'The LearningContext may be incomplete because of file, source, symbol, and token budgets. Do not assume missing context or invent behavior that is not supported by the supplied context.',
		'Explain only observable code and Git artifacts. Do not invent or infer private agent chain-of-thought.',
		buildGeminiContext(context),
		'Create exactly 5 independent multiple-choice questions. Each question must have exactly 4 choices.',
		'Each answer must be the zero-based index of the correct choice in the choices array.',
		'Every question must test whether the developer understands how the application works, not whether they can locate text.',
		'Prioritize, in order: important implementation concepts; relationships between components; control flow; data flow; why important code exists; how functions/classes interact; what happens when inputs change; important implementation decisions; recently changed code; common misconceptions.',
		'Avoid trivia such as variable names, line numbers, or answers obtainable by simple text matching. Prefer causal and behavioral questions, such as why authenticateUser() calls a repository before creating a session, over naming questions.',
		'When supported by the context, include a concise relevant symbol/file reference. Add a hint only when it helps learning without revealing the answer.',
		'Return only valid JSON with this exact shape: {"title": string, "overview": string, "questions": [{"question": string, "choices": [string, string, string, string], "answer": number, "explanation": string, "concept": string, "hint": string, "reference": string}]}',
		'Use an empty string for optional hint or reference when the supplied context does not support one.',
	].filter(Boolean).join('\n\n');
}
