import * as assert from 'assert';

// You can import and use all API from the 'vscode' module
// as well as import your extension to test it
import * as vscode from 'vscode';
import { buildGeminiContext } from '../context/contextSelector';
import { LearningContext } from '../context/learningContext';
import { attachAgentSummary, maxAgentSummaryWords } from '../context/agentSummary';
import { LearningHistoryStore } from '../learning/learningHistory';
// import * as myExtension from '../../extension';

suite('Extension Test Suite', () => {
	vscode.window.showInformationMessage('Start all tests.');

	test('Sample test', () => {
		assert.strictEqual(-1, [1, 2, 3].indexOf(5));
		assert.strictEqual(-1, [1, 2, 3].indexOf(0));
	});

	test('Context selector enforces configured budgets', () => {
		const context: LearningContext = {
			activeFilePath: 'active.ts',
			programmingLanguage: 'typescript',
			relevantSourceCode: 'const activeValue = 1;\n',
			selectedCode: 'const selectedValue = 1;',
			codeSymbols: Array.from({ length: 10 }, (_, index) => ({
				name: `symbol${index}`,
				kind: 'function',
				filePath: 'active.ts',
				startLine: index + 1,
				endLine: index + 2,
			})),
			contextBudget: {
				maxSourceCharacters: 200,
				maxFiles: 1,
				maxSymbols: 2,
				maxEstimatedTokens: 100,
			},
		};
		const selected = buildGeminiContext(context);
		assert.ok(selected.length <= 400);
		assert.ok(selected.includes('SELECTED CODE'));
		assert.ok(selected.includes('FILES INCLUDED (1/1)'));
		assert.ok(selected.includes('SYMBOLS INCLUDED (2/2)'));
	});

	test('Agent summaries are optional, observable, and capped at 300 words', () => {
		const context: LearningContext = {
			activeFilePath: 'active.ts',
			programmingLanguage: 'typescript',
			relevantSourceCode: 'const value = 1;',
			contextBudget: { maxEstimatedTokens: 500 },
		};
		const summary = attachAgentSummary(context, {
			task: Array.from({ length: 350 }, () => 'observable').join(' '),
			testsPerformed: ['npm test'],
		});
		assert.ok(summary.agentSummary);
		const wordCount = Object.values(summary.agentSummary ?? {})
			.flatMap(value => Array.isArray(value) ? value : [value])
			.join(' ')
			.trim().split(/\s+/).length;
		assert.ok(wordCount <= maxAgentSummaryWords);
		assert.ok(!attachAgentSummary(context, undefined).agentSummary);
	});

	test('Learning history derives a compact missed-concept profile', async () => {
		const values = new Map<string, unknown>();
		const state = {
			get<T>(key: string, defaultValue?: T): T | undefined { return (values.get(key) as T | undefined) ?? defaultValue; },
			update(key: string, value: unknown): Thenable<void> { values.set(key, value); return Promise.resolve(); },
			keys(): readonly string[] { return [...values.keys()]; },
		} as vscode.Memento;
		const store = new LearningHistoryStore(state);
		await store.record({ timestamp: new Date().toISOString(), question: 'q1', concept: 'data flow', correct: false, difficulty: 'medium', filePath: 'active.ts' });
		const profile = await store.record({ timestamp: new Date().toISOString(), question: 'q2', concept: 'data flow', correct: false, difficulty: 'medium', filePath: 'active.ts' });
		assert.ok(profile.conceptsFrequentlyMissed.includes('data flow'));
		assert.ok(profile.recentTopics.includes('data flow'));
	});
});
