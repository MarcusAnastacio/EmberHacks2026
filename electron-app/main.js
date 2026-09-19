// Electron main process.
//
// Startup order matters and is deliberate:
//   1. import the backend (ESM) via dynamic import  <- must finish before IPC exists
//   2. register the IPC handlers
//   3. create the window
//   4. kick off the scan and stream progress to the renderer
//
// This file is CommonJS (the folder has no "type": "module"), which is why the
// backend is loaded with `await import(...)` rather than `require(...)`. The
// backend folder has its own package.json marking it ESM; Electron's bundled Node
// does not reliably support require()-of-ESM, so dynamic import is the safe path.

const path = require('node:path');
const { app, BrowserWindow, ipcMain, shell } = require('electron');

const FIXTURES = process.env.COMPAT_FIXTURES === '1';

/** @type {import('./backend/index.js').CompatibilityLayer | null} */
let layer = null;
let mainWindow = null;

async function bootstrap() {
  // 1. backend
  const { CompatibilityLayer } = await import('./backend/index.js');
  const { registerCompatibilityIpc } = await import('./backend/ipc.js');

  layer = new CompatibilityLayer();

  // 2. IPC — registered before any window exists, so the renderer can never
  //    invoke a channel that is not wired yet.
  registerCompatibilityIpc({
    ipcMain,
    layer,
    getWindows: () => BrowserWindow.getAllWindows(),
  });

  // 3. window
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#12141a',
    title: 'Agent Quiz',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  await mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  if (process.env.COMPAT_DEVTOOLS === '1') mainWindow.webContents.openDevTools();

  // Headless verification: COMPAT_SCREENSHOT=/tmp/out.png renders the window to a
  // PNG and exits. Used to check the UI in CI or from a terminal without a display.
  const shotPath = process.env.COMPAT_SCREENSHOT;
  if (shotPath) {
    const fs = require('node:fs');
    const waitMs = Number(process.env.COMPAT_SCREENSHOT_DELAY || 4000);
    setTimeout(async () => {
      try {
        const image = await mainWindow.webContents.capturePage();
        fs.writeFileSync(shotPath, image.toPNG());
        console.log(`[screenshot] wrote ${shotPath}`);
      } catch (err) {
        console.error('[screenshot] failed:', err);
      }
      app.exit(0);
    }, waitMs);
  }

  // 4. scan, streaming progress. The renderer also calls refresh() on mount; the
  //    layer de-duplicates concurrent scans, so this is safe either way.
  mainWindow.webContents.once('did-finish-load', () => {
    layer.refresh({ fixtures: FIXTURES }).catch((err) => {
      console.error('[compat] scan failed:', err);
    });
  });
}

app.whenReady().then(bootstrap);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) bootstrap();
});

// External links open in the real browser, never inside the app.
app.on('web-contents-created', (_event, contents) => {
  contents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
});
