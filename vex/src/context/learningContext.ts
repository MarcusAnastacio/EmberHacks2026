import { CodeSymbol } from '../analysis/codeSymbol';

export interface LearningContext {
	activeFilePath: string;
	programmingLanguage: string;
	relevantSourceCode: string;
	selectedCode?: string;
	relatedSymbols?: string[];
	codeSymbols?: CodeSymbol[];
	agentChangeInformation?: string;
	projectDescription?: string;
}
