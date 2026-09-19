import { CodeSymbol } from '../analysis/codeSymbol';
import { RelevantContextItem } from '../analysis/workspaceContextAnalyzer';

export interface LearningContext {
	activeFilePath: string;
	programmingLanguage: string;
	relevantSourceCode: string;
	selectedCode?: string;
	relatedSymbols?: string[];
	codeSymbols?: CodeSymbol[];
	relevantContext?: RelevantContextItem[];
	agentChangeInformation?: string;
	projectDescription?: string;
}
