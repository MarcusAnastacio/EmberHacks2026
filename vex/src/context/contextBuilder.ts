import * as vscode from 'vscode';
import { analyzeActiveFile, maxAnalyzedSourceCharacters } from '../analysis/activeFileAnalyzer';
import { analyzeAgentChanges } from '../analysis/gitChangeAnalyzer';
import { WorkspaceContextAnalyzer } from '../analysis/workspaceContextAnalyzer';
import { LearningContext } from './learningContext';
import { AgentSummary, normalizeAgentSummary } from './agentSummary';
import { LearnerProfile } from '../learning/learningHistory';
import { CacheStore, hashContent } from '../cache/cacheStore';
import { ActiveFileAnalysis } from '../analysis/activeFileAnalyzer';
import { WorkspaceContextAnalysis } from '../analysis/workspaceContextAnalyzer';

export async function buildLearningContext(editor: vscode.TextEditor, agentSummary?: AgentSummary, learnerProfile?: LearnerProfile, cache?: CacheStore): Promise<LearningContext> {
	// Hash only what analysis actually consumes (source is truncated the same way) plus the true length,
	// so hashing stays cheap on very large files while still invalidating on truncation-boundary changes.
	const fullSource = editor.document.getText();
	const sourceHash = hashContent(JSON.stringify({
		path: editor.document.uri.fsPath,
		language: editor.document.languageId,
		source: fullSource.slice(0, maxAnalyzedSourceCharacters),
		sourceLength: fullSource.length,
		selection: editor.document.getText(editor.selection).slice(0, maxAnalyzedSourceCharacters),
	}));
	const analysisKey = `analysis.${sourceHash}`;
	const cachedAnalysis = cache?.get<ActiveFileAnalysis>(analysisKey);
	const analysis = cachedAnalysis ?? await analyzeActiveFile(editor);
	if (cachedAnalysis) {
		console.info('[VEX cache] skipped active-file analysis; source hash unchanged.');
	} else {
		await cache?.set(analysisKey, analysis);
		console.info('[VEX cache] generated active-file analysis.');
	}
	const agentChangeContext = await analyzeAgentChanges(editor.document, analysis.codeSymbols);
	const configuration = vscode.workspace.getConfiguration('vex.context');
	const structureKey = `structure.${hashContent(JSON.stringify({ sourceHash, maxDepth: configuration.get<number>('maxDepth', 1), maxFiles: configuration.get<number>('maxFiles', 6), maxSymbols: configuration.get<number>('maxSymbols', 20) }))}`;
	const cachedWorkspaceAnalysis = cache?.get<WorkspaceContextAnalysis>(structureKey);
	const workspaceAnalysis = cachedWorkspaceAnalysis ?? await new WorkspaceContextAnalyzer({
		maxDepth: configuration.get<number>('maxDepth', 1),
		maxFiles: configuration.get<number>('maxFiles', 6),
		maxSourceCharacters: configuration.get<number>('maxSourceCharactersPerFile', 4000),
		maxSymbols: configuration.get<number>('maxSymbols', 20),
	}).analyze(editor, analysis.codeSymbols);
	if (cachedWorkspaceAnalysis) {
		console.info('[VEX cache] retrieved project structure; relevant inputs unchanged.');
	} else {
		await cache?.set(structureKey, workspaceAnalysis);
		console.info('[VEX cache] generated project structure.');
	}
	const workspaceFolder = vscode.workspace.getWorkspaceFolder(editor.document.uri);
	const normalizedAgentSummary = normalizeAgentSummary(agentSummary);
	const maxRelatedFiles = configuration.get<number>('maxRelatedFiles', 3);
	const maxRelatedSourceCharacters = configuration.get<number>('maxRelatedSourceCharacters', 8000);
	const contextBudget = {
		maxSourceCharacters: configuration.get<number>('maxSourceCharacters', 24000),
		maxFiles: configuration.get<number>('maxContextFiles', 4),
		maxSymbols: configuration.get<number>('maxContextSymbols', 20),
		maxEstimatedTokens: configuration.get<number>('maxEstimatedTokens', 6000),
	};
	const contextKey = `learning-context.${hashContent(JSON.stringify({ sourceHash, workspaceAnalysis, agentChangeContext, normalizedAgentSummary, learnerProfile, contextBudget, maxRelatedFiles, maxRelatedSourceCharacters }))}`;
	const cachedContext = cache?.get<LearningContext>(contextKey);
	if (cachedContext) {
		console.info('[VEX cache] retrieved generated learning context; relevant inputs unchanged.');
		return cachedContext;
	}
	let remainingCharacters = maxRelatedSourceCharacters;
	const relevantContext = workspaceAnalysis.items
		.filter(item => item.filePath !== editor.document.uri.fsPath)
		.slice(0, maxRelatedFiles + analysis.codeSymbols.length)
		.map(item => {
			if (!item.sourceCode) {
				return item;
			}
			const sourceCode = item.sourceCode.slice(0, Math.max(0, remainingCharacters));
			remainingCharacters -= sourceCode.length;
			return { ...item, sourceCode };
		})
		.filter(item => !item.sourceCode || item.sourceCode.length > 0);

	const learningContext: LearningContext = {
		...analysis,
		relevantContext,
		contextBudget,
		agentChangeContext,
		...(normalizedAgentSummary ? { agentSummary: normalizedAgentSummary } : {}),
		...(learnerProfile ? { learnerProfile } : {}),
		projectDescription: workspaceFolder?.name,
	};
	await cache?.set(contextKey, learningContext);
	console.info('[VEX cache] generated learning context.');
	return learningContext;
}
