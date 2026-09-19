export type QuizMode = 'guided' | 'architecture' | 'challenge';

export interface QuizQuestion {
	question: string;
	choices: string[];
	answer: number;
	explanation: string;
	concept: string;
	hint?: string;
	reference?: string;
}

export interface Quiz {
	title: string;
	overview: string;
	questions: QuizQuestion[];
}
