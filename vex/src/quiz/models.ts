export type QuizMode = 'guided' | 'architecture' | 'challenge';

export interface CodeReference {
	filePath: string;
	symbolName?: string;
	startLine?: number;
	endLine?: number;
}

export interface QuizQuestion {
	question: string;
	choices: string[];
	answer: number;
	explanation: string;
	concept: string;
	hint?: string;
	reference?: CodeReference;
}

export interface Quiz {
	title: string;
	overview: string;
	questions: QuizQuestion[];
}
