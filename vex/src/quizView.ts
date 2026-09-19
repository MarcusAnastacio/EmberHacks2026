import * as vscode from 'vscode';
import { Quiz, QuizMode } from './gemini';

export interface QuizViewMessage {
	command: 'generate' | 'setKey';
	mode?: QuizMode;
}

export class QuizViewProvider implements vscode.WebviewViewProvider {
	public static readonly viewType = 'vex.quizView';
	private view?: vscode.WebviewView;

	public constructor(
		private readonly extensionUri: vscode.Uri,
		private readonly onGenerate: (mode: QuizMode) => Promise<void>,
		private readonly onSetKey: () => Promise<void>,
	) {}

	public resolveWebviewView(view: vscode.WebviewView): void {
		this.view = view;
		view.webview.options = { enableScripts: true };
		view.webview.html = this.getHtml(view.webview);
		view.webview.onDidReceiveMessage(async (message: QuizViewMessage) => {
			if (message.command === 'generate' && message.mode) {
				await this.onGenerate(message.mode);
			}
			if (message.command === 'setKey') {
				await this.onSetKey();
			}
		});
	}

	public show(): void {
		this.view?.show(true);
	}

	public renderQuiz(quiz: Quiz, sourceName: string): void {
		this.view?.webview.postMessage({ command: 'quiz', quiz, sourceName });
	}

	public renderStatus(message: string, kind: 'info' | 'error' = 'info'): void {
		this.view?.webview.postMessage({ command: 'status', message, kind });
	}

	private getHtml(webview: vscode.Webview): string {
		const nonce = getNonce();
		const csp = `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';`;
		return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
:root { color-scheme: light dark; --ink: var(--vscode-foreground); --muted: var(--vscode-descriptionForeground); --panel: var(--vscode-sideBar-background); --line: var(--vscode-widget-border); --accent: var(--vscode-textLink-foreground); }
* { box-sizing: border-box; }
body { margin: 0; padding: 18px; color: var(--ink); background: var(--panel); font-family: var(--vscode-font-family); font-size: 13px; }
header { border-bottom: 1px solid var(--line); padding-bottom: 16px; margin-bottom: 18px; }
.eyebrow { color: var(--accent); text-transform: uppercase; letter-spacing: .12em; font-size: 10px; font-weight: 700; }
h1 { font-size: 22px; line-height: 1.1; margin: 7px 0; }
p { color: var(--muted); line-height: 1.5; }
label { display: block; color: var(--muted); font-size: 11px; margin: 16px 0 7px; text-transform: uppercase; letter-spacing: .08em; }
select, button { width: 100%; font: inherit; border-radius: 3px; padding: 9px 10px; }
select { color: var(--ink); background: var(--vscode-dropdown-background); border: 1px solid var(--vscode-dropdown-border); }
button { cursor: pointer; color: var(--vscode-button-foreground); background: var(--vscode-button-background); border: 0; font-weight: 600; }
button:hover { background: var(--vscode-button-hoverBackground); }
button.secondary { color: var(--ink); background: transparent; border: 1px solid var(--line); margin-top: 8px; }
#status { min-height: 22px; margin: 14px 0; }
.error { color: var(--vscode-errorForeground); }
.quiz-title { margin-top: 24px; border-top: 1px solid var(--line); padding-top: 18px; }
.question { border-left: 2px solid var(--accent); padding: 0 0 4px 12px; margin: 22px 0; }
.question h2 { font-size: 14px; margin: 0 0 12px; line-height: 1.4; }
.choice { display: block; text-align: left; color: var(--ink); background: transparent; border: 1px solid var(--line); margin: 7px 0; font-weight: 400; }
.choice:hover { border-color: var(--accent); background: var(--vscode-list-hoverBackground); }
.choice.correct { border-color: var(--vscode-testing-iconPassed); }
.choice.wrong { border-color: var(--vscode-testing-iconFailed); }
.explanation { color: var(--muted); padding: 8px 0 0; line-height: 1.5; }
.concept { color: var(--accent); font-size: 11px; margin-top: 8px; }
[hidden] { display: none; }
</style>
</head>
<body>
<header><div class="eyebrow">VEX / learning lab</div><h1>Understand what the agent made.</h1><p>Turn the active editor into a short, evidence-based lesson.</p></header>
<section id="controls">
<label for="mode">Teaching mode</label>
<select id="mode"><option value="guided">Guided tour</option><option value="architecture">Architecture lens</option><option value="challenge">Challenge mode</option></select>
<button id="generate">Generate quiz</button>
<button class="secondary" id="setKey">Set Gemini API key</button>
<div id="status" role="status"></div>
</section>
<section id="quiz" hidden></section>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
const status = document.getElementById('status');
const quiz = document.getElementById('quiz');
document.getElementById('generate').addEventListener('click', () => {
	status.textContent = 'Reading the active editor and asking Gemini...';
	status.className = '';
	vscode.postMessage({ command: 'generate', mode: document.getElementById('mode').value });
});
document.getElementById('setKey').addEventListener('click', () => vscode.postMessage({ command: 'setKey' }));
window.addEventListener('message', event => {
	const message = event.data;
	if (message.command === 'status') {
		status.textContent = message.message;
		status.className = message.kind === 'error' ? 'error' : '';
	}
	if (message.command === 'quiz') {
		status.textContent = 'Quiz ready. Choose an answer to reveal the lesson.';
		renderQuiz(message.quiz, message.sourceName);
	}
});
function renderQuiz(data, sourceName) {
	quiz.hidden = false;
	quiz.innerHTML = '<div class="quiz-title"><div class="eyebrow">' + escapeHtml(sourceName) + '</div><h2>' + escapeHtml(data.title) + '</h2><p>' + escapeHtml(data.overview) + '</p></div>';
	data.questions.forEach((item, index) => {
		const section = document.createElement('article');
		section.className = 'question';
		section.innerHTML = '<h2>' + (index + 1) + '. ' + escapeHtml(item.question) + '</h2>';
		item.choices.forEach((choice, choiceIndex) => {
			const button = document.createElement('button');
			button.className = 'choice';
			button.textContent = choice;
			button.addEventListener('click', () => {
				section.querySelectorAll('.choice').forEach(element => element.disabled = true);
				button.classList.add(choiceIndex === item.answer ? 'correct' : 'wrong');
				if (choiceIndex !== item.answer) section.querySelectorAll('.choice')[item.answer].classList.add('correct');
				section.insertAdjacentHTML('beforeend', '<div class="explanation">' + escapeHtml(item.explanation) + '</div><div class="concept">Concept: ' + escapeHtml(item.concept) + '</div>');
			});
			section.appendChild(button);
		});
		quiz.appendChild(section);
	});
}
function escapeHtml(value) { const node = document.createElement('div'); node.textContent = value; return node.innerHTML; }
</script>
</body>
</html>`;
	}
}

function getNonce(): string {
	const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	let value = '';
	for (let index = 0; index < 32; index++) {
		value += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
	}
	return value;
}
