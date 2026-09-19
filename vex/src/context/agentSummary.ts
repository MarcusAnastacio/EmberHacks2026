export interface AgentSummary {
	task?: string;
	filesChanged?: string[];
	implementationChanges?: string[];
	importantDecisions?: string[];
	conceptsIntroduced?: string[];
	changeDependencies?: string[];
	assumptionsOrLimitations?: string[];
	testsPerformed?: string[];
}

export const maxAgentSummaryWords = 300;

/** Accepts an externally supplied observable summary without generating missing details. */
export function normalizeAgentSummary(summary: AgentSummary | undefined): AgentSummary | undefined {
	if (!summary) {
		return undefined;
	}

	let remainingWords = maxAgentSummaryWords;
	const normalized: AgentSummary = {};
	const addText = (key: keyof AgentSummary, value: string | undefined): void => {
		if (!value || remainingWords <= 0) {
			return;
		}
		const words = value.trim().split(/\s+/).filter(Boolean).slice(0, remainingWords);
		if (words.length) {
			normalized[key] = words.join(' ') as never;
			remainingWords -= words.length;
		}
	};
	const addList = (key: keyof AgentSummary, values: string[] | undefined): void => {
		if (!values || remainingWords <= 0) {
			return;
		}
		const result: string[] = [];
		for (const value of values) {
			if (remainingWords <= 0) {
				break;
			}
			const words = value.trim().split(/\s+/).filter(Boolean).slice(0, remainingWords);
			if (words.length) {
				result.push(words.join(' '));
				remainingWords -= words.length;
			}
		}
		if (result.length) {
			normalized[key] = result as never;
		}
	};

	addText('task', summary.task);
	addList('filesChanged', summary.filesChanged);
	addList('implementationChanges', summary.implementationChanges);
	addList('importantDecisions', summary.importantDecisions);
	addList('conceptsIntroduced', summary.conceptsIntroduced);
	addList('changeDependencies', summary.changeDependencies);
	addList('assumptionsOrLimitations', summary.assumptionsOrLimitations);
	addList('testsPerformed', summary.testsPerformed);

	return Object.keys(normalized).length ? normalized : undefined;
}

export function attachAgentSummary<T extends { agentSummary?: AgentSummary }>(context: T, summary: AgentSummary | undefined): T {
	const normalized = normalizeAgentSummary(summary);
	return normalized ? { ...context, agentSummary: normalized } : context;
}
