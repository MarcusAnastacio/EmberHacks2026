import * as path from 'node:path';
import * as vscode from 'vscode';
import { CodeSymbol } from './codeSymbol';

export interface WorkspaceContextAnalyzerOptions {
	maxDepth?: number;
	maxFiles?: number;
	maxSourceCharacters?: number;
	maxSymbols?: number;
}

export interface RelevantContextItem {
	kind: 'file' | 'symbol';
	name: string;
	filePath: string;
	relevance: number;
	reason: 'active-file' | 'direct-dependency' | 'direct-importer' | 'referenced-symbol' | 'symbol-definition' | 'related-file' | 'other';
	symbol?: CodeSymbol;
	sourceCode?: string;
}

export interface WorkspaceContextAnalysis {
	items: RelevantContextItem[];
	files: RelevantContextItem[];
	symbols: RelevantContextItem[];
}

const defaultOptions: Required<WorkspaceContextAnalyzerOptions> = {
	maxDepth: 1,
	maxFiles: 6,
	maxSourceCharacters: 12000,
	maxSymbols: 20,
};

export class WorkspaceContextAnalyzer {
	public constructor(private readonly options: WorkspaceContextAnalyzerOptions = {}) {}

	public async analyze(editor: vscode.TextEditor, activeSymbols: CodeSymbol[]): Promise<WorkspaceContextAnalysis> {
		const settings = { ...defaultOptions, ...this.options };
		const activeDocument = editor.document;
		const items: RelevantContextItem[] = [{
			kind: 'file',
			name: path.basename(activeDocument.uri.fsPath),
			filePath: activeDocument.uri.fsPath,
			relevance: 100,
			reason: 'active-file',
		}];
		const importPaths = findImportPaths(activeDocument);
		const dependencyFiles = await this.resolveImports(activeDocument, importPaths, settings);
		for (const dependency of dependencyFiles) {
			items.push(await this.fileItem(
				dependency.uri,
				dependency.depth === 1 ? 50 : 20,
				dependency.depth === 1 ? 'direct-dependency' : 'related-file',
				settings.maxSourceCharacters,
			));
		}

		const importerUris = await this.findDirectImporters(activeDocument, settings.maxFiles);
		for (const uri of importerUris) {
			if (!items.some(item => item.filePath === uri.fsPath)) {
				items.push(await this.fileItem(uri, 20, 'direct-importer', settings.maxSourceCharacters));
			}
		}

		const symbolItems = await this.findReferencedSymbols(editor, activeSymbols, settings.maxSymbols);
		items.push(...symbolItems);
		const files = items.filter(item => item.kind === 'file').sort(sortByRelevance);
		const symbols = items.filter(item => item.kind === 'symbol').sort(sortByRelevance);
		const result = { items: [...files, ...symbols], files, symbols };
		console.info('[VEX workspace analyzer]', {
			activeFile: activeDocument.uri.fsPath,
			maxDepth: settings.maxDepth,
			files: files.map(item => ({ path: item.filePath, relevance: item.relevance, reason: item.reason })),
			symbols: symbols.map(item => ({ name: item.name, path: item.filePath, relevance: item.relevance, reason: item.reason })),
		});
		return result;
	}

	private async resolveImports(
		document: vscode.TextDocument,
		importPaths: string[],
		settings: Required<WorkspaceContextAnalyzerOptions>,
	): Promise<Array<{ uri: vscode.Uri; depth: number }>> {
		const discovered = new Map<string, { uri: vscode.Uri; depth: number }>();
		let frontier: Array<{ document: vscode.TextDocument; depth: number; imports: string[] }> = [{ document, depth: 0, imports: importPaths }];
		while (frontier.length && discovered.size < settings.maxFiles && frontier[0].depth < settings.maxDepth) {
			const nextFrontier: Array<{ document: vscode.TextDocument; depth: number; imports: string[] }> = [];
			for (const current of frontier) {
				for (const importPath of current.imports) {
					if (!importPath.startsWith('.') || discovered.size >= settings.maxFiles) {
						continue;
					}
					const uri = await this.resolveImport(current.document, importPath);
					if (!uri || uri.fsPath === document.uri.fsPath || discovered.has(uri.fsPath)) {
						continue;
					}
					const depth = current.depth + 1;
					discovered.set(uri.fsPath, { uri, depth });
					if (depth < settings.maxDepth) {
						const relatedDocument = await vscode.workspace.openTextDocument(uri);
						nextFrontier.push({ document: relatedDocument, depth, imports: findImportPaths(relatedDocument) });
					}
				}
			}
			frontier = nextFrontier;
		}
		return [...discovered.values()];
	}

	private async resolveImport(document: vscode.TextDocument, importPath: string): Promise<vscode.Uri | undefined> {
		const basePath = path.resolve(path.dirname(document.uri.fsPath), importPath);
		const candidates = [basePath, ...['.ts', '.tsx', '.js', '.jsx', '.py'].map(extension => `${basePath}${extension}`), ...['index.ts', 'index.js', '__init__.py'].map(index => path.join(basePath, index))];
		for (const candidate of candidates) {
			const uri = vscode.Uri.file(candidate);
			try {
				await vscode.workspace.fs.stat(uri);
				return uri;
			} catch {
				// Try the next conventional extension.
			}
		}
		return undefined;
	}

	private async findDirectImporters(activeDocument: vscode.TextDocument, maxFiles: number): Promise<vscode.Uri[]> {
		const files = await vscode.workspace.findFiles('**/*.{ts,tsx,js,jsx,py}', '**/{node_modules,dist,out,.vscode-test}/**', Math.max(maxFiles * 8, 24));
		const importers: vscode.Uri[] = [];
		for (const uri of files) {
			if (uri.fsPath === activeDocument.uri.fsPath) {
				continue;
			}
			const document = await vscode.workspace.openTextDocument(uri);
			if (findImportPaths(document).some(importPath => resolvesToFile(document, importPath, activeDocument.uri.fsPath))) {
				importers.push(uri);
			}
			if (importers.length >= maxFiles) {
				break;
			}
		}
		return importers;
	}

	private async findReferencedSymbols(editor: vscode.TextEditor, symbols: CodeSymbol[], maxSymbols: number): Promise<RelevantContextItem[]> {
		const result: RelevantContextItem[] = [];
		const topLevelSymbols = symbols.filter(symbol => symbol.filePath === editor.document.uri.fsPath).slice(0, Math.min(maxSymbols, 8));
		for (const symbol of topLevelSymbols) {
			const position = new vscode.Position(symbol.startLine - 1, 0);
			const definitions = await vscode.commands.executeCommand<Array<vscode.Location | vscode.LocationLink>>(
				'vscode.executeDefinitionProvider', editor.document.uri, position,
			);
			const references = await vscode.commands.executeCommand<vscode.Location[]>(
				'vscode.executeReferenceProvider', editor.document.uri, position,
			);
			for (const definition of definitions ?? []) {
				const location = 'targetUri' in definition ? { uri: definition.targetUri, range: definition.targetRange } : definition;
				if (location.uri.fsPath === editor.document.uri.fsPath && location.range.start.line === position.line) {
					continue;
				}
				result.push({ kind: 'symbol', name: symbol.name, filePath: location.uri.fsPath, relevance: 40, reason: 'symbol-definition', symbol });
			}
			if ((references?.length ?? 0) > 1) {
				result.push({ kind: 'symbol', name: symbol.name, filePath: editor.document.uri.fsPath, relevance: 40, reason: 'referenced-symbol', symbol });
			}
		}
		return deduplicateItems(result);
	}

	private async fileItem(uri: vscode.Uri, relevance: number, reason: RelevantContextItem['reason'], maxSourceCharacters: number): Promise<RelevantContextItem> {
		const document = await vscode.workspace.openTextDocument(uri);
		return {
			kind: 'file',
			name: path.basename(uri.fsPath),
			filePath: uri.fsPath,
			relevance,
			reason,
			sourceCode: document.getText().slice(0, maxSourceCharacters),
		};
	}
}

function findImportPaths(document: vscode.TextDocument): string[] {
	const imports: string[] = [];
	for (let line = 0; line < document.lineCount; line++) {
		const text = document.lineAt(line).text;
		const matches = [...text.matchAll(/(?:from\s+|import\s*\(?\s*|require\(\s*["'])(["']?)(\.\.?\/[^"'\s,)]+)\1/g)];
		imports.push(...matches.map(match => match[2]));
	}
	return [...new Set(imports)];
}

function resolvesToFile(document: vscode.TextDocument, importPath: string, targetPath: string): boolean {
	const basePath = path.resolve(path.dirname(document.uri.fsPath), importPath);
	return [basePath, ...['.ts', '.tsx', '.js', '.jsx', '.py'].map(extension => `${basePath}${extension}`), ...['index.ts', 'index.js', '__init__.py'].map(index => path.join(basePath, index))].some(candidate => path.normalize(candidate) === path.normalize(targetPath));
}

function deduplicateItems(items: RelevantContextItem[]): RelevantContextItem[] {
	return [...new Map(items.map(item => [`${item.kind}:${item.name}:${item.filePath}:${item.reason}`, item])).values()];
}

function sortByRelevance(left: RelevantContextItem, right: RelevantContextItem): number {
	return right.relevance - left.relevance || left.filePath.localeCompare(right.filePath);
}
