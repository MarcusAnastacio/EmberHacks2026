import * as vscode from 'vscode';
import { analyzeActiveFile } from '../analysis/activeFileAnalyzer';
import { analyzeAgentChanges } from '../analysis/gitChangeAnalyzer';
import { WorkspaceContextAnalyzer } from '../analysis/workspaceContextAnalyzer';
import { LearningContext } from './learningContext';

export async function buildLearningContext(editor: vscode.TextEditor): Promise<LearningContext> {
	const analysis = await analyzeActiveFile(editor);
	const agentChangeContext = await analyzeAgentChanges(editor.document, analysis.codeSymbols);
	const configuration = vscode.workspace.getConfiguration('vex.context');
	const workspaceAnalysis = await new WorkspaceContextAnalyzer({
		maxDepth: configuration.get<number>('maxDepth', 1),
		maxFiles: configuration.get<number>('maxFiles', 6),
		maxSourceCharacters: configuration.get<number>('maxSourceCharactersPerFile', 4000),
		maxSymbols: configuration.get<number>('maxSymbols', 20),
	}).analyze(editor, analysis.codeSymbols);
	const workspaceFolder = vscode.workspace.getWorkspaceFolder(editor.document.uri);
	const maxRelatedFiles = configuration.get<number>('maxRelatedFiles', 3);
	const maxRelatedSourceCharacters = configuration.get<number>('maxRelatedSourceCharacters', 8000);
	const contextBudget = {
		maxSourceCharacters: configuration.get<number>('maxSourceCharacters', 24000),
		maxFiles: configuration.get<number>('maxContextFiles', 4),
		maxSymbols: configuration.get<number>('maxContextSymbols', 20),
		maxEstimatedTokens: configuration.get<number>('maxEstimatedTokens', 6000),
	};
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

	return {
		...analysis,
		relevantContext,
		contextBudget,
		agentChangeContext,
		projectDescription: workspaceFolder?.name,
	};
}
