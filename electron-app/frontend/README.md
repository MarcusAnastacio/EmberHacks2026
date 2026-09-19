# VEX frontend

The renderer. Plain HTML, CSS and ES modules. No framework, no bundler, no build step.

The visual design is not final. This file explains the seam that keeps that cheap: the
functional layer is done, and restyling should not touch it.

---

## Run it

```bash
cd electron-app
npm install      # once
npm start
```

Save does not hot reload. Press **Ctrl/Cmd + R** in the window, or relaunch.

```bash
COMPAT_DEVTOOLS=1 npm start        # DevTools open
npm run start:fixtures             # bundled sample stores instead of your history
COMPAT_SCREENSHOT=/tmp/app.png npm start   # render to a PNG and exit
npm test --prefix frontend         # the contract test (see below)
```

---

## Layout

```
frontend/
├── index.html          markup and the CSP
├── styles.css          all styling, design tokens in :root at the top
├── fonts/              Nunito, bundled. See Type below.
├── app.js              WIRING: reads state, calls the API, tells components what to draw
├── lib/                FUNCTIONAL. Finalised. Restyling should not need to touch it.
│   ├── api.js            the only file that talks to the backend
│   ├── state.js          application state, with named setters
│   └── quiz-view.js      backend shapes into render-agnostic view models
└── components/         VISUAL. Expected to change.
    ├── sidebar.js        the conversation list
    ├── panel.js          empty state, transcript, settings, payload
    └── quiz.js           flashcards, the three question types, feedback, results
```

The rules that keep the seam intact:

- **`lib/api.js` is the only file that talks to the backend.** No component calls the
  bridge, no component knows a channel name.
- **`lib/quiz-view.js` is the only file that reshapes a response.** It turns a quiz into a
  flat list of steps, so no component ever reads `correctOptionKey` or `codeWithGaps`.
- **Components draw a view model and report intent through a callback.** They never fetch,
  never hold state, and never decide what to generate.
- **`app.js` owns state.** It is the only writer.

So: restyling touches `components/` and `styles.css`. A backend change touches
`lib/api.js`. Neither should need the other.

---

## Type

Nunito, **bundled rather than linked**, in `fonts/` as two variable woff2 files (latin and
latin-ext, about 75 KB total, one file covering weights 200 to 1000).

This is not a preference. The renderer makes no network requests and the CSP is
`default-src 'none'`, so a Google Fonts `<link>` fails silently: the app looks fine and
quietly renders in a system font. `font-src 'self'` is in the CSP for the same reason, and
removing it has the same invisible failure mode.

The fallback stack includes `ui-rounded` and `SF Pro Rounded`, so a machine that somehow
lacks the file still gets a rounded face where the OS has one.

Nunito is under the SIL Open Font License. The licence is committed at `fonts/OFL.txt`.
Swapping it means replacing the two `.woff2` files and the `@font-face` block.

---

## What the backend gives you

Everything below is reachable through `lib/api.js`. The full contract is in
[`../backend/README.md`](../backend/README.md).

The flow the app is built around:

```js
const catalog = await api.refresh()                    // sidebar
const session = await api.session(id)                  // the conversation
const button  = await api.quizButton({ id, ...opts })   // { action, label, reason }
const quiz    = await api.generateAndSave({ id, ...opts })   // persists
const graded  = await api.grade({ quizId, answers })   // mcq and cloze cost nothing
const band    = await api.band({ percentage })         // quartile copy
```

Two things worth knowing:

- **`quizButton` decides the label for you.** `action: 'open'` means a stored quiz is
  ready; `action: 'configure'` means offer generation. The mapping from the six staleness
  states lives in the backend so the UI does not branch on them.
- **Progress is saved after every answer.** `api.progress({ quizId })` returns
  `{ stepIndex, answers, results, resumable, completed, score, maxScore }`. Finishing
  keeps the score and resets the position, so returning offers a fresh attempt. A second
  completion overwrites the score rather than accumulating attempts.

---

## The contract test

```bash
npm test --prefix frontend
```

`frontend/test/contract.test.js` checks that `lib/api.js`, `preload.js` and
`backend/ipc.js` agree: every method the frontend calls is exposed, every exposed method
has a handler, and nothing is exposed that nothing uses.

Three files describe one interface and they drift silently. This caught two real defects
on its first run: `quizButton` was called by `app.js` but never wrapped in `api.js`, which
made a `Promise.all` reject and quietly emptied the conversation header; and `topicSlice`
was exposed in preload with no channel in `ipc.js` at all.

**Run it after touching any of the three files.** It is the cheapest test in the project
and the only one that covers the seam.

---

## Conventions

- **`textContent`, never `innerHTML`.** Titles, project names, tool names and message
  bodies all come from other tools' stores, so this is the app's main XSS boundary. The
  `h()` helper takes a `text` key and no `html` key, on purpose: the escape hatch was
  removed rather than left unused, because leaving it is how a later component ends up
  reaching for it.
- **No em dashes, no emojis, no exclamation marks** in user-facing copy. The backend
  enforces the same rule on generated content, and `scoreBand` copy is tested against it.
- **Green and red are reserved for grading an answer.** The four score bands use other
  hues (`--tone-low`, `--tone-mid`, `--tone-good`, `--tone-high`) so a colour never means
  two things.
- **Colour question types, not topics.** Three types is three accents and it is already on
  every step as `kind`. A long session yields up to fourteen topics, at which point
  per-topic colour is noise.
- **Extend the tokens in `:root`** rather than adding literal colours.
- **`type="module"` is required** on the entry script. Modules work because `main.js`
  serves the page over the `app://` scheme; over `file://` the origin is null and
  `script-src 'self'` refuses every import, silently.
