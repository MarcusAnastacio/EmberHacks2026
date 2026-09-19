import * as vscode from 'vscode';
import { analyzeActiveFile } from '../analysis/activeFileAnalyzer';
import { LearningContext } from './learningContext';

export async function buildLearningContext(editor: vscode.TextEditor): Promise<LearningContext> {
	const analysis = await analyzeActiveFile(editor);
	const workspaceFolder = vscode.workspace.getWorkspaceFolder(editor.document.uri);

	return {
		...analysis,
		projectDescription: workspaceFolder?.name,
	};
}
