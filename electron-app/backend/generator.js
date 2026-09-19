import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_MODEL = 'gemini-2.5-flash';
const SOURCE_EXTENSIONS = new Set(['.js', '.jsx', '.ts', '.tsx', '.json', '.css', '.html', '.md', '.py', '.go', '.rs', '.java', '.c', '.cpp', '.h']);
const IGNORED_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', '.next', 'coverage', '.cache']);

function readCodebase(cwd, maxChars = 12000) {
  if (!cwd || !fs.existsSync(cwd)) return '';
  const files = [];
  function walk(dir) {
    if (files.join('').length >= maxChars) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || IGNORED_DIRS.has(entry.name) || entry.name.toLowerCase().includes('.env')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (SOURCE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        try {
          const text = fs.readFileSync(full, 'utf8');
          files.push(`\n--- ${path.relative(cwd, full)} ---\n${text.slice(0, Math.max(0, maxChars - files.join('').length))}`);
        } catch { /* unreadable files are not project context */ }
      }
      if (files.join('').length >= maxChars) return;
    }
  }
  walk(cwd);
  return files.join('').slice(0, maxChars);
}

function extractJson(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('Gemini returned no JSON quiz.');
  return JSON.parse(candidate.slice(start, end + 1));
}

function validateQuiz(value) {
  if (!value || typeof value !== 'object' || !Array.isArray(value.questions)) {
    throw new Error('Gemini returned an invalid quiz shape.');
  }
  const questions = value.questions.filter((question) =>
    question &&
    typeof question.question === 'string' &&
    Array.isArray(question.options) &&
    question.options.length >= 2 &&
    Number.isInteger(question.answer) &&
    question.answer >= 0 &&
    question.answer < question.options.length,
  );
  if (!questions.length) throw new Error('Gemini returned no usable questions.');
  return {
    title: typeof value.title === 'string' ? value.title : 'Conversation quiz',
    description: typeof value.description === 'string' ? value.description : '',
    questions: questions.slice(0, 10).map((question) => ({
      question: question.question,
      options: question.options.slice(0, 5).map(String),
      answer: question.answer,
      explanation: typeof question.explanation === 'string' ? question.explanation : '',
    })),
  };
}

export async function generateQuiz({ apiKey = process.env.GEMINI_API_KEY, model = process.env.GEMINI_MODEL || DEFAULT_MODEL, payload, prompt }) {
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY is not configured. Add it to electron-app/.env and restart the app.');
  }
  if (!payload || !Array.isArray(payload.messages)) throw new Error('Select a conversation before generating a quiz.');

  const instruction = [
    'You create a rigorous, answerable quiz from an AI coding-agent transcript.',
    'Return ONLY valid JSON, with this exact shape:',
    '{"title":"string","description":"string","questions":[{"question":"string","options":["string"],"answer":0,"explanation":"string"}]}',
    'Use 4 options per question when possible. answer is the zero-based index of the correct option.',
    'Ask about concrete decisions, implementation details, debugging discoveries, and outcomes in the transcript.',
    'Do not invent facts. Make the questions useful for checking whether the developer understood the work.',
    `The developer's focus prompt is: ${String(prompt || 'Test my understanding of the most important work in this conversation.')}`,
    `Project source context (may be empty):\n${readCodebase(payload.cwd)}`,
    `Conversation payload:\n${JSON.stringify(payload)}`,
  ].join('\n\n');

  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ contents: [{ parts: [{ text: instruction }] }] }),
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Gemini request failed (${response.status}): ${detail.slice(0, 240)}`);
  }
  const data = await response.json();
  const text = data.candidates?.[0]?.content?.parts?.map((part) => part.text || '').join('') || '';
  return validateQuiz(extractJson(text));
}
