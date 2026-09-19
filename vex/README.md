# VEX

VEX turns code written in VS Code into an interactive lesson. It sends the active file, or the selected code, to Gemini and presents a short quiz that explains the code's behavior, architecture, and tradeoffs.

## Use It

1. Press `F5` and choose **Run Extension**.
2. In the Extension Development Host, open the VEX activity-bar view named **Learning Lab**.
3. Choose **Set Gemini API Key** and paste your key. VS Code stores it in `SecretStorage`; it is not written to the project.
4. Open a code file, choose a teaching mode, and select **Generate quiz**.

You can also run **VEX: Generate Quiz from Current File** from the Command Palette. If you select code before running it, VEX teaches from that selection instead of the whole file.

## Teaching Modes

- **Guided tour** explains the code from fundamentals through its input and output.
- **Architecture lens** focuses on responsibilities, data flow, dependencies, and tradeoffs.
- **Challenge mode** uses prediction and debugging questions to strengthen recall.

## Requirements

- VS Code 1.138 or newer
- A Gemini API key with access to `gemini-2.5-flash`

The key is sent only to Google's Gemini API over HTTPS. Source code is included in the request so Gemini can create an evidence-based quiz.

## Development

Run `npm install`, then press `F5` or run `npm run compile`. The extension bundles to `dist/extension.js`.

## Architecture

- `src/analysis/` gathers facts from the active VS Code editor.
- `src/context/` builds the typed `LearningContext` sent to the learning pipeline.
- `src/llm/` owns Gemini model discovery, prompts, transport, retries, and API errors.
- `src/quiz/` owns quiz models, JSON validation, and quiz-generation orchestration.
- `src/extension.ts` registers VS Code commands and coordinates these layers.

## Inspecting Local Analysis

The analyzer only reads the active editor document. It uses VS Code's document symbol provider for language-aware symbols and adds lightweight import/export entries from the active file. It does not scan or send the entire workspace.

To inspect the discovered structure:

1. Start the extension with `F5`.
2. Open a TypeScript file containing an import, exported function or class, a method, and a variable.
3. Open **View > Output**, select **Log (Extension Host)**, and run **VEX: Generate Quiz from Current File**.
4. Find the `[VEX analyzer]` entry. It includes the file path, language, symbol count, names, kinds, and one-based line ranges.
5. Repeat with a Python file containing `import`, `from ... import ...`, a function, a class, a method, and variables. Python symbol details appear when the Python language extension is installed and its symbol provider is active; import entries are detected locally regardless.

The quiz still contains five questions. Gemini receives the active file source plus the local symbol structure, never the rest of the workspace.

## Workspace Context

VEX also builds a small ranked subset around the active file. Direct relative imports score 50, direct importers score 20, second-level related files score 20, and referenced symbols or definitions score 40. The active file itself scores 100. The analyzer does not recursively load the whole dependency graph.

These limits can be changed under **Settings > Extensions > VEX**:

- `vex.context.maxDepth`: import traversal depth, default `1`, maximum `2`.
- `vex.context.maxFiles`: maximum files inspected, default `6`.
- `vex.context.maxRelatedFiles`: related files included in the prompt, default `3`.
- `vex.context.maxRelatedSourceCharacters`: aggregate source excerpt budget, default `8000` characters.
- `vex.context.maxSourceCharactersPerFile`: per-file excerpt cap, default `4000` characters.
- `vex.context.maxSymbols`: active-file symbols checked for definitions and references, default `20`.

The complete active file remains the primary source sent to Gemini. Related files contribute only their highest-ranked metadata and budgeted excerpts.
