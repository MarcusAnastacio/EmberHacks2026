import * as vscode from 'vscode';
import { CodeSymbol } from './codeSymbol';

export interface ActiveFileAnalysis {
	activeFilePath: string;
	programmingLanguage: string;
	relevantSourceCode: string;
	selectedCode?: string;
	relatedSymbols?: string[];
	codeSymbols: CodeSymbol[];
}

export async function analyzeActiveFile(editor: vscode.TextEditor): Promise<ActiveFileAnalysis> {
	const selectedCode = editor.document.getText(editor.selection).trim();
	const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[] | vscode.SymbolInformation[]>(
		'vscode.executeDocumentSymbolProvider',
		editor.document.uri,
	);
	const codeSymbols = [
		...(symbols ?? []).flatMap(symbol => toCodeSymbols(symbol, editor.document.uri.fsPath)),
		...findImportExportSymbols(editor.document),
	];
	const relatedSymbols = codeSymbols.map(symbol => symbol.name);
	console.info('[VEX analyzer]', {
		filePath: editor.document.uri.fsPath,
		language: editor.document.languageId,
		symbolCount: codeSymbols.length,
		symbols: codeSymbols,
	});

	return {
		activeFilePath: editor.document.uri.fsPath,
		programmingLanguage: editor.document.languageId,
		relevantSourceCode: (selectedCode || editor.document.getText()).slice(0, 50000),
		selectedCode: selectedCode || undefined,
		relatedSymbols: relatedSymbols?.length ? relatedSymbols : undefined,
		codeSymbols,
	};
}

function toCodeSymbols(
	symbol: vscode.DocumentSymbol | vscode.SymbolInformation,
	filePath: string,
): CodeSymbol {
	const range = 'range' in symbol ? symbol.range : symbol.location.range;
	const children = 'children' in symbol ? symbol.children.map(child => toCodeSymbols(child, filePath)) : undefined;
	return {
		name: symbol.name,
		kind: symbolKindName(symbol.kind),
		filePath,
		startLine: range.start.line + 1,
		endLine: range.end.line + 1,
		children: children?.length ? children : undefined,
	};
}

function symbolKindName(kind: vscode.SymbolKind): string {
	return Object.keys(vscode.SymbolKind).find(key => vscode.SymbolKind[key as keyof typeof vscode.SymbolKind] === kind) ?? 'unknown';
}

function findImportExportSymbols(document: vscode.TextDocument): CodeSymbol[] {
	const symbols: CodeSymbol[] = [];
	for (let line = 0; line < document.lineCount; line++) {
		const text = document.lineAt(line).text;
		const importMatch = text.match(/^\s*(?:import|from\s+\S+\s+import)\b(.*)$/);
		const exportMatch = text.match(/^\s*export\b(?:\s+default)?\s+(.*)$/);
		if (importMatch) {
			symbols.push(createLineSymbol(importMatch[1].trim() || 'import', 'import', document, line));
		}
		if (exportMatch) {
			symbols.push(createLineSymbol(exportMatch[1].trim() || 'export', 'export', document, line));
		}
	}
	return symbols;
}

function createLineSymbol(name: string, kind: string, document: vscode.TextDocument, line: number): CodeSymbol {
	return {
		name: name.slice(0, 120),
		kind,
		filePath: document.uri.fsPath,
		startLine: line + 1,
		endLine: line + 1,
	};
}
