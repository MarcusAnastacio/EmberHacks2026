import * as vscode from 'vscode';
import { buildLearningContext } from './context/contextBuilder';
import { QuizMode } from './quiz/models';
import { generateQuiz } from './quiz/quizGenerator';
import { QuizViewProvider } from './quizView';
import { registerAgentSummaryParticipant } from './chat/agentSummaryParticipant';
import { AgentSummary } from './context/agentSummary';
import { CodeReference } from './quiz/models';
import { LearningHistoryStore } from './learning/learningHistory';

const geminiKeySecret = 'vex.geminiApiKey';

export function activate(context: vscode.ExtensionContext): void {
	const learningHistory = new LearningHistoryStore(context.workspaceState);
	let quizView: QuizViewProvider;
	quizView = new QuizViewProvider(
		context.extensionUri,
		mode => generateQuizForActiveEditor(context, learningHistory, quizView, mode),
		() => setGeminiApiKey(context, quizView),
		reference => viewCodeReference(reference),
		message => recordAnswer(context, learningHistory, message),
	);

	context.subscriptions.push(
		registerAgentSummaryParticipant(summary => context.workspaceState.update('vex.agentSummary', summary)),
		vscode.window.registerWebviewViewProvider(QuizViewProvider.viewType, quizView),
		vscode.commands.registerCommand('vex.openQuiz', async () => {
			await vscode.commands.executeCommand('vex.quizView.focus');
			quizView.show();
		}),
		vscode.commands.registerCommand('vex.generateQuiz', async () => {
			await vscode.commands.executeCommand('vex.quizView.focus');
			quizView.show();
			await generateQuizForActiveEditor(context, learningHistory, quizView, 'guided');
		}),
		vscode.commands.registerCommand('vex.setGeminiApiKey', () => setGeminiApiKey(context, quizView)),
	);
}

async function setGeminiApiKey(context: vscode.ExtensionContext, quizView: QuizViewProvider): Promise<void> {
	const apiKey = await vscode.window.showInputBox({
		prompt: 'Paste your Gemini API key. It will be stored securely by VS Code.',
		password: true,
		ignoreFocusOut: true,
		placeHolder: 'AIza...',
	});
	if (!apiKey?.trim()) {
		return;
	}
	await context.secrets.store(geminiKeySecret, apiKey.trim());
	quizView.renderStatus('Gemini API key saved securely.');
	void vscode.window.showInformationMessage('VEX Gemini API key saved securely.');
}

async function generateQuizForActiveEditor(
	context: vscode.ExtensionContext,
	learningHistory: LearningHistoryStore,
	quizView: QuizViewProvider,
	mode: QuizMode,
): Promise<void> {
	const editor = vscode.window.activeTextEditor;
	if (!editor) {
		quizView.renderStatus('Open a code file first, then generate the quiz.', 'error');
		return;
	}

	let apiKey = await context.secrets.get(geminiKeySecret);
	if (!apiKey) {
		quizView.renderStatus('Add your Gemini API key to generate a quiz.', 'error');
		await setGeminiApiKey(context, quizView);
		apiKey = await context.secrets.get(geminiKeySecret);
		if (!apiKey) {
			return;
		}
	}

	const agentSummary = context.workspaceState.get<AgentSummary>('vex.agentSummary');
	const learnerProfile = learningHistory.getProfile();
	const learningContext = await buildLearningContext(editor, agentSummary, learnerProfile);
	const sourceName = learningContext.activeFilePath.split(/[\\/]/).pop() ?? 'active editor';
	quizView.renderStatus('Gemini is building a lesson from your code...');
	try {
		const quiz = await generateQuiz(apiKey, learningContext, mode);
		quizView.renderQuiz(quiz, sourceName);
	} catch (error) {
		const message = error instanceof Error ? error.message : 'Quiz generation failed.';
		quizView.renderStatus(message, 'error');
		void vscode.window.showErrorMessage(`VEX: ${message}`);
	}
}

export function deactivate(): void {}

async function viewCodeReference(reference: CodeReference): Promise<void> {
	try {
		const document = await vscode.workspace.openTextDocument(vscode.Uri.file(reference.filePath));
		if (reference.startLine === undefined || reference.endLine === undefined ||
			reference.startLine < 1 || reference.endLine < reference.startLine || reference.endLine > document.lineCount) {
			void vscode.window.showWarningMessage('VEX: This code reference is no longer available in the current file.');
			return;
		}
		const startLine = reference.startLine - 1;
		const endLine = reference.endLine - 1;
		const start = new vscode.Position(startLine, 0);
		const end = new vscode.Position(endLine, document.lineAt(endLine).text.length);
		const range = new vscode.Range(start, end);
		const editor = await vscode.window.showTextDocument(document, { selection: range });
		editor.selection = new vscode.Selection(start, end);
		editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
	} catch (error) {
		const message = error instanceof Error ? error.message : 'Could not open the referenced code.';
		void vscode.window.showErrorMessage(`VEX: ${message}`);
	}
}

async function recordAnswer(
	context: vscode.ExtensionContext,
	learningHistory: LearningHistoryStore,
	message: { question?: string; concept?: string; correct?: boolean; difficulty?: 'easy' | 'medium' | 'hard' },
): Promise<void> {
	const editor = vscode.window.activeTextEditor;
	if (!message.question || !message.concept || message.correct === undefined || !message.difficulty) {
		return;
	}
	await learningHistory.record({
		timestamp: new Date().toISOString(),
		question: message.question,
		concept: message.concept,
		correct: message.correct,
		difficulty: message.difficulty,
		filePath: editor?.document.uri.fsPath ?? '',
		project: vscode.workspace.getWorkspaceFolder(editor?.document.uri ?? vscode.Uri.file(''))?.name,
	});
}
