import * as vscode from 'vscode';

export interface ActiveFileAnalysis {
	activeFilePath: string;
	programmingLanguage: string;
	relevantSourceCode: string;
	selectedCode?: string;
	relatedSymbols?: string[];
}

export async function analyzeActiveFile(editor: vscode.TextEditor): Promise<ActiveFileAnalysis> {
	const selectedCode = editor.document.getText(editor.selection).trim();
	const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
		'vscode.executeDocumentSymbolProvider',
		editor.document.uri,
	);
	const relatedSymbols = symbols?.map(symbol => symbol.name);

	return {
		activeFilePath: editor.document.uri.fsPath,
		programmingLanguage: editor.document.languageId,
		relevantSourceCode: (selectedCode || editor.document.getText()).slice(0, 50000),
		selectedCode: selectedCode || undefined,
		relatedSymbols: relatedSymbols?.length ? relatedSymbols : undefined,
	};
}
