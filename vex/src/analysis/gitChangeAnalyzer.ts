import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { AgentChangeContext } from './agentChangeContext';
import { CodeSymbol } from './codeSymbol';

const execFileAsync = promisify(execFile);
const maxDiffCharacters = 12000;

interface GitRepository {
	rootUri: vscode.Uri;
}

interface GitApi {
	repositories: GitRepository[];
}

interface GitExtension {
	getAPI(version: number): GitApi;
}

export async function analyzeAgentChanges(
	document: vscode.TextDocument,
	symbols: CodeSymbol[],
): Promise<AgentChangeContext | undefined> {
	const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
	if (!workspaceFolder) {
		return undefined;
	}

	const cwd = await getRepositoryRoot(document.uri, workspaceFolder.uri.fsPath);
	try {
		const relativePath = path.relative(cwd, document.uri.fsPath);
		const [diffResult, filesResult, commitResult] = await Promise.all([
			runGit(['diff', 'HEAD', '--no-ext-diff', '--unified=20', '--', relativePath], cwd),
			runGit(['diff', 'HEAD', '--name-only'], cwd),
			runGit(['log', '-1', '--pretty=%s', '--', relativePath], cwd),
		]);
		const diff = diffResult.stdout;
		const changedFiles = filesResult.stdout.split(/\r?\n/).map(file => file.trim()).filter(Boolean);
		if (!diff && !changedFiles.includes(relativePath)) {
			return undefined;
		}
		const changedLines = getChangedLineNumbers(diff);
		const changedSymbols = symbols
			.filter(symbol => symbol.filePath === document.uri.fsPath && overlapsChangedLines(symbol, changedLines))
			.map(symbol => `${symbol.kind} ${symbol.name} (${symbol.startLine}-${symbol.endLine})`);
		const context: AgentChangeContext = {
			changedFiles,
			additions: countDiffLines(diff, '+'),
			deletions: countDiffLines(diff, '-'),
			relevantDiff: diff ? diff.slice(0, maxDiffCharacters) : undefined,
			changedSymbols,
			commitMessage: commitResult.stdout.trim() || undefined,
		};
		console.info('[VEX Git change analyzer]', context);
		return context;
	} catch (error) {
		console.info('[VEX Git change analyzer] Git data unavailable; continuing without change context.', error);
		return undefined;
	}
}

async function getRepositoryRoot(documentUri: vscode.Uri, fallback: string): Promise<string> {
	const gitExtension = vscode.extensions.getExtension<GitExtension>('vscode.git');
	if (!gitExtension) {
		return fallback;
	}
	try {
		const extension = gitExtension.isActive ? gitExtension.exports : await gitExtension.activate();
		const repositories = extension?.getAPI(1).repositories ?? [];
		const repository = repositories.find(candidate => isWithinRepository(documentUri.fsPath, candidate.rootUri.fsPath));
		return repository?.rootUri.fsPath ?? fallback;
	} catch (error) {
		console.info('[VEX Git change analyzer] vscode.git API unavailable; using workspace root.', error);
		return fallback;
	}
}

function isWithinRepository(filePath: string, repositoryPath: string): boolean {
	const normalizedFile = path.resolve(filePath).toLowerCase();
	const normalizedRepository = path.resolve(repositoryPath).toLowerCase();
	return normalizedFile === normalizedRepository || normalizedFile.startsWith(`${normalizedRepository}${path.sep}`);
}

async function runGit(args: string[], cwd: string): Promise<{ stdout: string }> {
	return execFileAsync('git', args, { cwd, windowsHide: true, maxBuffer: 2 * 1024 * 1024 });
}

function countDiffLines(diff: string, prefix: '+' | '-'): number {
	return diff.split(/\r?\n/).filter(line => line.startsWith(prefix) && !line.startsWith(`${prefix}${prefix}`)).length;
}

function getChangedLineNumbers(diff: string): Set<number> {
	const changedLines = new Set<number>();
	let currentLine = 0;
	for (const line of diff.split(/\r?\n/)) {
		const hunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
		if (hunk) {
			currentLine = Number(hunk[1]);
			continue;
		}
		if (line.startsWith('+') && !line.startsWith('++')) {
			changedLines.add(currentLine++);
			continue;
		}
		if (line.startsWith('-') && !line.startsWith('--')) {
			continue;
		}
		if (!line.startsWith('\\')) {
			currentLine++;
		}
	}
	return changedLines;
}

function overlapsChangedLines(symbol: CodeSymbol, changedLines: Set<number>): boolean {
	for (const line of changedLines) {
		if (line >= symbol.startLine && line <= symbol.endLine) {
			return true;
		}
	}
	return false;
}
