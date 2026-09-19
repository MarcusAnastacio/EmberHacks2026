import * as vscode from 'vscode';
import { buildLearningContext } from './context/contextBuilder';
import { QuizMode } from './quiz/models';
import { generateQuiz } from './quiz/quizGenerator';
import { QuizViewProvider } from './quizView';
import { registerAgentSummaryParticipant } from './chat/agentSummaryParticipant';
import { AgentSummary } from './context/agentSummary';

const geminiKeySecret = 'vex.geminiApiKey';

export function activate(context: vscode.ExtensionContext): void {
	let quizView: QuizViewProvider;
	quizView = new QuizViewProvider(
		context.extensionUri,
		mode => generateQuizForActiveEditor(context, quizView, mode),
		() => setGeminiApiKey(context, quizView),
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
			await generateQuizForActiveEditor(context, quizView, 'guided');
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
	const learningContext = await buildLearningContext(editor, agentSummary);
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
