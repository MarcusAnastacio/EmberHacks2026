export interface LearningContext {
	activeFilePath: string;
	programmingLanguage: string;
	relevantSourceCode: string;
	selectedCode?: string;
	relatedSymbols?: string[];
	agentChangeInformation?: string;
	projectDescription?: string;
}
