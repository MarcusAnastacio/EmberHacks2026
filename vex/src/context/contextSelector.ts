import { LearningContext } from './learningContext';
import { CodeSymbol } from '../analysis/codeSymbol';

export interface ContextSelectorOptions {
	maxSourceCharacters?: number;
	maxFiles?: number;
	maxSymbols?: number;
	maxEstimatedTokens?: number;
}

export interface SelectedContextSummary {
	includedFiles: string[];
	includedSymbols: string[];
	estimatedTokens: number;
	sourceCharacters: number;
}

const defaultOptions: Required<ContextSelectorOptions> = {
	maxSourceCharacters: 24000,
	maxFiles: 4,
	maxSymbols: 20,
	maxEstimatedTokens: 6000,
};

export class ContextSelector {
	private readonly options: Required<ContextSelectorOptions>;

	public constructor(options: ContextSelectorOptions = {}) {
		this.options = { ...defaultOptions, ...options };
	}

	public select(context: LearningContext): string {
		const sections: string[] = [];
		const includedFiles = new Set<string>();
		const includedSymbols = new Set<string>();
		let sourceCharacters = 0;
		let estimatedTokens = 0;
		let fileCount = 0;
		let symbolCount = 0;
		const append = (content: string): boolean => {
			const addedTokens = estimateTokens(content);
			if (estimatedTokens + addedTokens > this.options.maxEstimatedTokens) {
				return false;
			}
			sections.push(content);
			estimatedTokens += addedTokens;
			return true;
		};

		const appendMetadata = (label: string, value: string): void => {
			append(`${label}\n${value}`);
		};
		const appendSource = (label: string, filePath: string, source: string, relevance: number): void => {
			if ((!includedFiles.has(filePath) && fileCount >= this.options.maxFiles) || sourceCharacters >= this.options.maxSourceCharacters || estimatedTokens >= this.options.maxEstimatedTokens) {
				return;
			}
			const remainingCharacters = this.options.maxSourceCharacters - sourceCharacters;
			const prefix = `${label} [relevance=${relevance}]\nFILE: ${filePath}\n`;
			const remainingTokens = Math.max(0, this.options.maxEstimatedTokens - estimatedTokens - estimateTokens(prefix));
			const allowedCharacters = Math.max(0, Math.min(remainingCharacters, remainingTokens * 4));
			if (allowedCharacters === 0) {
				return;
			}
			const truncated = source.slice(0, allowedCharacters);
			const content = `${label} [relevance=${relevance}]\nFILE: ${filePath}\n${truncated}${truncated.length < source.length ? '\n[truncated by context budget]' : ''}`;
			if (!append(content)) {
				return;
			}
			if (!includedFiles.has(filePath)) {
				includedFiles.add(filePath);
				fileCount++;
			}
			sourceCharacters += truncated.length;
		};
		const appendSymbol = (symbol: CodeSymbol, relevance: number, reason: string): void => {
			if (symbolCount >= this.options.maxSymbols) {
				return;
			}
			const key = `${symbol.filePath}:${symbol.name}:${symbol.startLine}`;
			if (includedSymbols.has(key)) {
				return;
			}
			const content = `${symbol.name} (${symbol.kind}) [relevance=${relevance}, reason=${reason}] ${symbol.filePath}:${symbol.startLine}-${symbol.endLine}`;
			if (!append(`SYMBOL\n${content}`)) {
				return;
			}
			includedSymbols.add(key);
			symbolCount++;
		};

		if (context.selectedCode) {
			appendSource('SELECTED CODE', context.activeFilePath, context.selectedCode, 110);
		}
		appendSource('ACTIVE FILE', context.activeFilePath, context.relevantSourceCode, 100);

		const localSymbols = flattenSymbols(context.codeSymbols ?? [])
			.slice(0, this.options.maxSymbols)
			.sort((left, right) => symbolRelevance(right) - symbolRelevance(left));
		for (const symbol of localSymbols) {
			appendSymbol(symbol, 40, 'active-file structure');
		}

		const relatedItems = [...(context.relevantContext ?? [])]
			.sort((left, right) => right.relevance - left.relevance)
			.slice(0, this.options.maxFiles + this.options.maxSymbols);
		for (const item of relatedItems) {
			if (item.kind === 'file' && item.sourceCode) {
				appendSource('RELATED FILE', item.filePath, item.sourceCode, item.relevance);
			} else if (item.symbol) {
				appendSymbol(item.symbol, item.relevance, item.reason);
			}
		}

		if (context.agentChangeInformation) {
			appendMetadata('AGENT CHANGES', context.agentChangeInformation);
		}
		if (context.agentChangeContext) {
			const changes = context.agentChangeContext;
			appendMetadata('CHANGE SUMMARY', JSON.stringify({
				changedFiles: changes.changedFiles,
				additions: changes.additions,
				deletions: changes.deletions,
				changedSymbols: changes.changedSymbols,
				commitMessage: changes.commitMessage,
				testResults: changes.testResults,
			}, null, 2));
			if (changes.relevantDiff) {
				appendSource('RELEVANT GIT DIFF', context.activeFilePath, changes.relevantDiff, 60);
			}
		}
		if (context.agentSummary) {
			appendMetadata('AGENT SUMMARY', formatAgentSummary(context.agentSummary));
		}
		if (context.learnerProfile) {
			appendMetadata('COMPACT LEARNER PROFILE', JSON.stringify(context.learnerProfile));
		}
		if (context.projectDescription) {
			appendMetadata('PROJECT', context.projectDescription);
		}
		if (context.programmingLanguage) {
			appendMetadata('LANGUAGE', context.programmingLanguage);
		}

		const summary: SelectedContextSummary = {
			includedFiles: [...includedFiles],
			includedSymbols: [...includedSymbols],
			estimatedTokens,
			sourceCharacters,
		};
		const metadata = [
			'CONTEXT SELECTION SUMMARY',
			`FILES INCLUDED (${summary.includedFiles.length}/${this.options.maxFiles}): ${summary.includedFiles.join(', ') || 'none'}`,
			`SYMBOLS INCLUDED (${summary.includedSymbols.length}/${this.options.maxSymbols}): ${summary.includedSymbols.join(', ') || 'none'}`,
			`SOURCE CHARACTERS: ${summary.sourceCharacters}/${this.options.maxSourceCharacters}`,
			`ESTIMATED TOKENS: ${summary.estimatedTokens}/${this.options.maxEstimatedTokens}`,
		].join('\n');
		const availableCharacters = this.options.maxEstimatedTokens * 4;
		const sectionText = sections.join('\n\n');
		const metadataAndSeparator = `${metadata}\n\n`;
		const output = `${metadataAndSeparator}${sectionText}`.slice(0, availableCharacters);
		console.info('[VEX context selector]', { ...summary, finalEstimatedTokens: estimateTokens(output), limits: this.options });
		return output;

	}
}

export function buildGeminiContext(context: LearningContext): string {
	return new ContextSelector(context.contextBudget).select(context);
}

function flattenSymbols(symbols: CodeSymbol[]): CodeSymbol[] {
	return symbols.flatMap(symbol => [symbol, ...flattenSymbols(symbol.children ?? [])]);
}

function symbolRelevance(symbol: CodeSymbol): number {
	return symbol.kind === 'function' || symbol.kind === 'class' || symbol.kind === 'method' ? 50 : 40;
}

function estimateTokens(value: string): number {
	return Math.ceil(value.length / 4);
}

function formatAgentSummary(summary: NonNullable<LearningContext['agentSummary']>): string {
	const sections: string[] = [];
	const add = (label: string, value: string | string[] | undefined): void => {
		if (!value || (Array.isArray(value) && value.length === 0)) {
			return;
		}
		sections.push(`${label}: ${Array.isArray(value) ? value.join('; ') : value}`);
	};
	add('Task/request', summary.task);
	add('Files changed', summary.filesChanged);
	add('Implementation changes', summary.implementationChanges);
	add('Important decisions', summary.importantDecisions);
	add('Concepts introduced', summary.conceptsIntroduced);
	add('Change dependencies', summary.changeDependencies);
	add('Assumptions or limitations', summary.assumptionsOrLimitations);
	add('Tests performed', summary.testsPerformed);
	return sections.join('\n');
}
