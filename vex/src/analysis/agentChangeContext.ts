export interface AgentChangeContext {
	changedFiles: string[];
	additions: number;
	deletions: number;
	relevantDiff?: string;
	changedSymbols: string[];
	commitMessage?: string;
	testResults?: string;
}
