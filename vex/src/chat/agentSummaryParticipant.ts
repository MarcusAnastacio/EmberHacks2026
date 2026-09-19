import * as vscode from 'vscode';
import { analyzeAgentChanges } from '../analysis/gitChangeAnalyzer';
import { analyzeActiveFile } from '../analysis/activeFileAnalyzer';
import { AgentSummary, normalizeAgentSummary } from '../context/agentSummary';

export function registerAgentSummaryParticipant(
	onSummary: (summary: AgentSummary) => Thenable<void>,
): vscode.Disposable {
	const participant = vscode.chat.createChatParticipant('vex.agentSummary', async (request, chatContext, stream, token) => {
		const editor = vscode.window.activeTextEditor;
		if (!editor) {
			stream.markdown('Open the changed file before asking VEX to summarize the agent changes.');
			return;
		}

		const analysis = await analyzeActiveFile(editor);
		const changes = await analyzeAgentChanges(editor.document, analysis.codeSymbols);
		const history = chatContext.history.map(turn => {
			if (turn instanceof vscode.ChatRequestTurn) {
				return `USER REQUEST:\n${turn.prompt}`;
			}
			return `CHAT RESPONSE:\n${turn.response.map(part => 'value' in part ? String(part.value) : '').join('')}`;
		}).join('\n\n');
		const prompt = [
			'Create a concise developer-facing summary of observable coding work.',
			'Do not reveal, infer, or invent hidden chain-of-thought or private agent reasoning.',
			'Return only JSON with these optional fields: task, filesChanged, implementationChanges, importantDecisions, conceptsIntroduced, changeDependencies, assumptionsOrLimitations, testsPerformed.',
			'Keep the combined summary under 300 words.',
			`ACTIVE FILE: ${analysis.activeFilePath}`,
			changes ? `OBSERVABLE GIT CHANGES:\n${JSON.stringify(changes)}` : 'OBSERVABLE GIT CHANGES: unavailable',
			history ? `VEX CHAT HISTORY:\n${history}` : 'VEX CHAT HISTORY: none available',
		].join('\n\n');

		const response = await request.model.sendRequest([
			vscode.LanguageModelChatMessage.User(prompt),
		], {}, token);
		let text = '';
		for await (const chunk of response.text) {
			text += chunk;
		}
		const summary = parseSummary(text);
		if (!summary) {
			stream.markdown('VEX could not extract a valid observable summary from that chat response.');
			return;
		}
		await onSummary(summary);
		stream.markdown('Stored the observable agent summary for the next VEX quiz.');
	});
	return participant;
}

function parseSummary(text: string): AgentSummary | undefined {
	try {
		const jsonText = text.replace(/^```json\s*/i, '').replace(/\s*```$/i, '').trim();
		return normalizeAgentSummary(JSON.parse(jsonText) as AgentSummary);
	} catch {
		return undefined;
	}
}
