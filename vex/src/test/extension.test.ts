import * as assert from 'assert';

// You can import and use all API from the 'vscode' module
// as well as import your extension to test it
import * as vscode from 'vscode';
import { buildGeminiContext } from '../context/contextSelector';
import { LearningContext } from '../context/learningContext';
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
});
