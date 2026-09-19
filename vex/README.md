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
