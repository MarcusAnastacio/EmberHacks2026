import { CodeSymbol } from '../analysis/codeSymbol';
import { AgentChangeContext } from '../analysis/agentChangeContext';
import { RelevantContextItem } from '../analysis/workspaceContextAnalyzer';
import type { ContextSelectorOptions } from './contextSelector';
import { AgentSummary } from './agentSummary';
import { LearnerProfile } from '../learning/learningHistory';

export interface LearningContext {
	activeFilePath: string;
	programmingLanguage: string;
	relevantSourceCode: string;
	selectedCode?: string;
	relatedSymbols?: string[];
	codeSymbols?: CodeSymbol[];
	relevantContext?: RelevantContextItem[];
	contextBudget?: ContextSelectorOptions;
	agentChangeInformation?: string;
	agentChangeContext?: AgentChangeContext;
	agentSummary?: AgentSummary;
	learnerProfile?: LearnerProfile;
	projectDescription?: string;
}
