// ============================================
// GLOBAL CRASH HANDLER — MUST BE FIRST
// Catches any unhandled error and writes to crash.log
// ============================================
const _fs = require('fs');
const _path = require('path');
const _os = require('os');
const axios = require('axios');

// SMART BROWSER DETECTION LOGIC
// ==========================================

let SMART_BROWSER_CONFIG = {};

if (process.platform === 'linux') {
    // Prioritas 1: Cek Chromium (Standar Termux/Debian)
    if (_fs.existsSync('/usr/bin/chromium')) {
        console.log('[SYSTEM] Menggunakan Chromium System (/usr/bin/chromium)');
        SMART_BROWSER_CONFIG = { executablePath: '/usr/bin/chromium' };
    }
    // Prioritas 2: Cek Chromium Browser (Ubuntu/Raspbian)
    else if (_fs.existsSync('/usr/bin/chromium-browser')) {
        console.log('[SYSTEM] Menggunakan Chromium Browser (/usr/bin/chromium-browser)');
        SMART_BROWSER_CONFIG = { executablePath: '/usr/bin/chromium-browser' };
    }
    // Prioritas 3: Cek Google Chrome Linux
    else if (_fs.existsSync('/usr/bin/google-chrome')) {
        console.log('[SYSTEM] Menggunakan Google Chrome Linux');
        SMART_BROWSER_CONFIG = { ...SMART_BROWSER_CONFIG };
    }
    else {
        console.log('[SYSTEM] Browser sistem tidak ditemukan, mencoba bundled...');
        SMART_BROWSER_CONFIG = {}; // Biarkan Playwright mencari sendiri
    }
} else {
   // Windows / Mac: Default pakai Chrome
    console.log('[SYSTEM] Mendeteksi Windows/Mac, menggunakan channel Chrome');
    SMART_BROWSER_CONFIG = { channel: 'chrome' };
}

const CRASH_LOG_DIR = _path.join(
    process.env.APPDATA || _path.join(_os.homedir(), 'AppData', 'Roaming'),
    'robotfb-underground-reborn'
);
if (!_fs.existsSync(CRASH_LOG_DIR)) {
    try { _fs.mkdirSync(CRASH_LOG_DIR, { recursive: true }); } catch { }
}
const CRASH_LOG_PATH = _path.join(CRASH_LOG_DIR, 'crash.log');

function writeCrashLog(label, err) {
    try {
        const ts = new Date().toISOString();
        const msg = `[${ts}] ${label}: ${err?.stack || err?.message || String(err)}\n`;
        _fs.appendFileSync(CRASH_LOG_PATH, msg, 'utf8');
    } catch { }
}

writeCrashLog('STARTUP', 'App starting...');

process.on('uncaughtException', (err) => {
    writeCrashLog('UNCAUGHT_EXCEPTION', err);
    try {
        const { dialog: dlg } = require('electron');
        dlg.showErrorBox('RobotFB — Fatal Error',
            `App crashed:\n${err?.message || err}\n\nLog: ${CRASH_LOG_PATH}`);
    } catch { }
    process.exit(1);
});

process.on('unhandledRejection', (reason) => {
    writeCrashLog('UNHANDLED_REJECTION', reason);
});

// ============================================
// Normal imports (wrapped for safety)
// ============================================
const { app, BrowserWindow, ipcMain, dialog, nativeImage, shell, Menu, MenuItem } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

let Store;
try {
    Store = require('electron-store');
} catch (err) {
    writeCrashLog('REQUIRE_ELECTRON_STORE', err);
    throw err;
}

let uploadHelper, publishHelper;
try {
    uploadHelper = require('./uploadHelper.cjs');
    publishHelper = require('./publishHelper.cjs');
} catch (err) {
    writeCrashLog('REQUIRE_HELPERS', err);
    throw err;
}
const { uploadPhotoToFB, uploadMultiplePhotos, extractFbDtsg, extractUid } = uploadHelper;
const { publishListing, publishDraftListing, launchDraftToPublic, extractPhotoPaths, mapCondition, mapCategory } = publishHelper;

// ============================================
// Configuration
// ============================================
const isDev = process.env.NODE_ENV === 'development';

let store, settingsStore, campaignStore;
try {
    store = new Store({
        name: 'robotfb-accounts',
        defaults: { accounts: [], posting_history: [], optimize_history: [] },
    });

    settingsStore = new Store({
        name: 'robotfb-settings',
        defaults: {
            appSettings: {
                theme: 'dark',
                autoFullscreen: false,
                language: 'id',
            },
        },
    });

    campaignStore = new Store({
        name: 'robotfb-campaigns',
        defaults: { campaigns: [] },
    });
    writeCrashLog('STORES', 'All stores initialized OK');
} catch (err) {
    writeCrashLog('STORE_INIT_CRASH', err);
    // If store config is corrupt, delete and retry
    try {
        const configDir = path.join(
            process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
            'robotfb-underground-reborn'
        );
        const corruptFiles = ['robotfb-accounts.json', 'robotfb-settings.json', 'robotfb-campaigns.json'];
        for (const f of corruptFiles) {
            const fp = path.join(configDir, f);
            if (fs.existsSync(fp)) {
                fs.unlinkSync(fp);
                writeCrashLog('STORE_RECOVERY', `Deleted corrupt config: ${f}`);
            }
        }
        // Retry
        store = new Store({ name: 'robotfb-accounts', defaults: { accounts: [], posting_history: [], optimize_history: [] } });
        settingsStore = new Store({ name: 'robotfb-settings', defaults: { appSettings: { theme: 'dark', autoFullscreen: false, language: 'id' } } });
        campaignStore = new Store({ name: 'robotfb-campaigns', defaults: { campaigns: [] } });
        writeCrashLog('STORE_RECOVERY', 'Stores recovered after deleting corrupt configs');
    } catch (err2) {
        writeCrashLog('STORE_RECOVERY_FAILED', err2);
        throw err2;
    }
}

let mainWindow = null;
const activeBrowsers = {}; // Track open browser instances by account ID

function generateId() {
    return 'acc_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7);
}

function sendProgress(data) {
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('account:progress-update', data);
    }
}

// ============================================
// URL Helpers
// ============================================
function isHomePage(href) {
    const h = href.toLowerCase();
    return (
        h.includes('/home') ||
        h.includes('facebook.com/?sk=') ||
        h.includes('facebook.com/?ref=') ||
        h.includes('facebook.com/#') ||
        h === 'https://www.facebook.com/' ||
        (h.startsWith('https://www.facebook.com') &&
            !h.includes('login') && !h.includes('checkpoint') &&
            !h.includes('challenge') && !h.includes('two_step') &&
            !h.includes('consent') && !h.includes('recover'))
    );
}

function isInterventionPage(href) {
    const h = href.toLowerCase();
    return (
        h.includes('checkpoint') || h.includes('challenge') ||
        h.includes('two_step_verification') || h.includes('consent') ||
        h.includes('recover')
    );
}

function isLoginPage(href) {
    const h = href.toLowerCase();
    return h.includes('/login') || h.includes('/welcome');
}

// ============================================
// Helper: Auto-mark account as INVALID on logout
// ============================================
function markAccountInvalid(accountId, reason = 'Cookies expired') {
    try {
        const accounts = store.get('accounts', []);
        const idx = accounts.findIndex(a => a.id === accountId);
        if (idx !== -1 && accounts[idx].status !== 'INVALID') {
            accounts[idx].status = 'INVALID';
            accounts[idx].lastChecked = new Date().toISOString();
            accounts[idx].invalidReason = reason;
            store.set('accounts', accounts);
            console.log(`[SESSION] Account ${accounts[idx].uid || accountId} marked INVALID: ${reason}`);
            // Notify renderer to refresh account list
            try { BrowserWindow.getAllWindows().forEach(w => w.webContents.send('account-status-changed', { accountId, status: 'INVALID', reason })); } catch { }
        }
    } catch (err) {
        console.error('[SESSION] Failed to mark account invalid:', err.message);
    }
}

// ============================================
// Anti-Detection Stealth Helpers
// ============================================
const STEALTH_USER_AGENTS = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36',
];

async function createStealthBrowser(headless = true) {
    const { chromium } = require('playwright');
    return await chromium.launch({
        headless: headless,
        ...SMART_BROWSER_CONFIG,
        ignoreDefaultArgs: ['--enable-automation'],
        args: [
            '--disable-blink-features=AutomationControlled',
            '--disable-infobars',
            '--disable-features=IsolateOrigins,site-per-process',
            '--no-first-run',
            '--no-default-browser-check',
            '--disable-background-timer-throttling',
            '--disable-backgrounding-occluded-windows',
            '--disable-renderer-backgrounding',
            '--no-sandbox',
            '--disable-gpu',      // <--- TAMBAHAN (Opsional jika macet)
            '--disable-dev-shm-usage', // <--- TAMBAHAN (Penting untuk Linux/VPS RAM keci
        ],
    });
}

async function createStealthContext(browser, cookiesPath, extraOpts = {}) {
    const ua = STEALTH_USER_AGENTS[Math.floor(Math.random() * STEALTH_USER_AGENTS.length)];
    const contextOpts = {
        viewport: { width: 1280, height: 800 },
        userAgent: ua,
        locale: 'id-ID',
        timezoneId: 'Asia/Jakarta',
        ...extraOpts,
    };
    if (cookiesPath) contextOpts.storageState = cookiesPath;

    const context = await browser.newContext(contextOpts);

    // Anti-detection: override navigator properties
    await context.addInitScript(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => false });
        Object.defineProperty(navigator, 'plugins', {
            get: () => [1, 2, 3, 4, 5],
        });
        Object.defineProperty(navigator, 'languages', {
            get: () => ['id-ID', 'id', 'en-US', 'en'],
        });
        window.chrome = { runtime: {}, loadTimes: () => { }, csi: () => { } };
        const origQuery = window.navigator.permissions.query;
        window.navigator.permissions.query = (params) =>
            params.name === 'notifications'
                ? Promise.resolve({ state: Notification.permission })
                : origQuery(params);
    });

    return context;
}

function humanDelay(min = 1000, max = 3000) {
    return Math.floor(Math.random() * (max - min)) + min;
}


// ============================================
// Helper: Scrape Facebook display name
// ============================================
async function scrapeFbName(page) {
    let userName = 'Unknown';
    try {
        // Primary selector (user-provided FB class chain)
        const nameSelector = 'span.x1lliihq.x6ikm8r.x10wlt62.x1n2onr6';
        try {
            const nameElement = await page.locator(nameSelector).first();
            const extracted = await nameElement.innerText({ timeout: 5000 });
            if (extracted && extracted.trim().length > 0 && extracted.trim().length < 80) {
                userName = extracted.trim();
                return userName;
            }
        } catch { }

        // Fallback selectors
        const fallbackSelectors = [
            'span[data-testid="royal_user_name"]',
            'div[role="navigation"] a[href*="/me"] span',
            'a[aria-label="Profile"] span',
            'a[aria-label="Profil"] span',
        ];
        for (const sel of fallbackSelectors) {
            try {
                const el = await page.$(sel);
                if (el) {
                    const text = await el.textContent();
                    if (text && text.trim().length > 0 && text.trim().length < 80) {
                        userName = text.trim();
                        return userName;
                    }
                }
            } catch { }
        }

        // Final fallback: document title
        const title = await page.title();
        if (title && !title.includes('Facebook') && !title.includes('Log')) {
            const parts = title.split('|');
            if (parts[0].trim()) userName = parts[0].trim();
        }
    } catch { }
    return userName;
}

// ============================================
// Main Window
// ============================================
function createWindow() {
    writeCrashLog('CREATE_WINDOW', 'Creating main window...');

    mainWindow = new BrowserWindow({
        width: 1280,
        height: 800,
        minWidth: 1024,
        minHeight: 680,
        title: 'ROBOTFB.ID UNDERGROUND REBORN',
        icon: nativeImage.createFromPath(
            path.join(__dirname, isDev ? '../public/logo.png' : '../dist/logo.png')
        ),
        webPreferences: {
            preload: path.join(__dirname, 'preload.cjs'),
            contextIsolation: true,
            nodeIntegration: false,
        },
        backgroundColor: '#18191A',
        show: false,
    });

    // ── Fallback: force show window after 10 seconds even if ready-to-show never fires ──
    let windowShown = false;
    const showWindowSafe = () => {
        if (!windowShown && mainWindow && !mainWindow.isDestroyed()) {
            windowShown = true;
            mainWindow.show();
            writeCrashLog('WINDOW_SHOWN', 'Window is now visible');
        }
    };
    const showTimeout = setTimeout(() => {
        writeCrashLog('WINDOW_TIMEOUT', 'ready-to-show did not fire in 10s — forcing show');
        showWindowSafe();
    }, 10000);

    const loadTarget = isDev
        ? 'http://localhost:5173'
        : path.join(__dirname, '../dist/index.html');
    writeCrashLog('LOAD_TARGET', `Loading: ${loadTarget}`);

    if (isDev) {
        mainWindow.loadURL(loadTarget);
        mainWindow.webContents.openDevTools();
    } else {
        mainWindow.loadFile(loadTarget).catch((err) => {
            writeCrashLog('LOAD_FILE_ERROR', err);
        });
    }

    // ── Handle load failures ──
    mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription) => {
        writeCrashLog('DID_FAIL_LOAD', `Code: ${errorCode}, Desc: ${errorDescription}`);
        // Show fallback error in window
        mainWindow.webContents.loadURL(`data:text/html;charset=utf-8,
            <html><body style="background:#18191A;color:#fff;font-family:sans-serif;padding:40px;text-align:center">
                <h1>⚠️ RobotFB — Load Error</h1>
                <p>Error ${errorCode}: ${errorDescription}</p>
                <p style="color:#888">Log: ${CRASH_LOG_PATH.replace(/\\/g, '/')}</p>
                <p style="color:#666;font-size:12px">Coba uninstall lalu install ulang.</p>
            </body></html>
        `).catch(() => { });
        showWindowSafe();
    });

    mainWindow.once('ready-to-show', () => {
        clearTimeout(showTimeout);
        showWindowSafe();
        // Auto fullscreen if enabled in settings
        try {
            const appSettings = settingsStore.get('appSettings', {});
            if (appSettings.autoFullscreen) {
                mainWindow.setFullScreen(true);
            }
        } catch (err) {
            writeCrashLog('SETTINGS_READ_ERROR', err);
        }
    });
    mainWindow.setMenuBarVisibility(false);

    // Tambahkan context menu (klik kanan)
    mainWindow.webContents.on('context-menu', (event, params) => {
        const menu = new Menu();
        menu.append(new MenuItem({ label: 'Potong', role: 'cut' }));
        menu.append(new MenuItem({ label: 'Salin', role: 'copy' }));
        menu.append(new MenuItem({ label: 'Tempel', role: 'paste' }));
        menu.append(new MenuItem({ type: 'separator' }));
        menu.append(new MenuItem({ label: 'Pilih Semua', role: 'selectAll' }));
        menu.popup({ window: mainWindow, x: params.x, y: params.y });
    });

    writeCrashLog('CREATE_WINDOW', 'Window created successfully');
}

// ============================================
// IPC: App Settings
// ============================================
ipcMain.handle('app:get-settings', async () => {
    return settingsStore.get('appSettings', { theme: 'dark', autoFullscreen: false, language: 'id' });
});

ipcMain.handle('app:save-settings', async (_event, settings) => {
    settingsStore.set('appSettings', settings);
    return { success: true };
});

ipcMain.handle('app:set-fullscreen', async (_event, enabled) => {
    if (mainWindow) {
        mainWindow.setFullScreen(!!enabled);
    }
    return { success: true };
});

// ============================================
// IPC: Campaign Persistence
// ============================================
ipcMain.handle('campaign:get-all', async () => {
    try {
        return campaignStore.get('campaigns', []);
    } catch {
        return [];
    }
});

ipcMain.handle('campaign:save-all', async (_event, campaigns) => {
    try {
        campaignStore.set('campaigns', campaigns || []);
        return { success: true };
    } catch (error) {
        return { success: false, error: error.message };
    }
});

// ============================================
// IPC: Get all accounts
// ============================================
ipcMain.handle('account:get-all', async () => {
    try {
        return { success: true, accounts: store.get('accounts', []) };
    } catch (error) {
        return { success: false, error: error.message, accounts: [] };
    }
});

// ============================================
// IPC: Delete account
// ============================================
ipcMain.handle('account:delete', async (_event, accountId) => {
    try {
        const accounts = store.get('accounts', []);
        const target = accounts.find((a) => a.id === accountId);
        if (target && target.cookiesPath && fs.existsSync(target.cookiesPath)) {
            try { fs.unlinkSync(target.cookiesPath); } catch { }
        }
        store.set('accounts', accounts.filter((a) => a.id !== accountId));
        return { success: true };
    } catch (error) {
        return { success: false, error: error.message };
    }
});

// ============================================
// IPC: Import raw UID|PASS|PROJECT text
// ============================================
ipcMain.handle('account:import-raw', async (_event, rawText) => {
    try {
        const lines = rawText.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
        if (lines.length === 0) {
            return { success: false, error: 'Tidak ada data yang valid.' };
        }

        const existingAccounts = store.get('accounts', []);
        const existingUids = new Set(existingAccounts.map((a) => a.uid));

        // Count how many NEW unique accounts will be imported
        let newCount = 0;
        for (const line of lines) {
            const sep = line.includes('|') ? '|' : ':';
            const uid = line.split(sep)[0]?.trim();
            if (uid && !existingUids.has(uid)) newCount++;
        }

        // ── Trial Enforcement: Account Limit ──
        if (newCount > 0) {
            const trialCheck = await checkTrialLimit('accounts', newCount);
            if (!trialCheck.allowed) {
                return { success: false, error: trialCheck.message, trial_limit: true };
            }
        }

        let imported = 0, skipped = 0;

        for (const line of lines) {
            const separator = line.includes('|') ? '|' : ':';
            const parts = line.split(separator);

            if (parts.length < 2) { skipped++; continue; }

            const uid = parts[0].trim();
            const password = parts[1].trim();
            const project = (parts[2] && parts[2].trim()) || 'General';

            if (!uid || !password) { skipped++; continue; }
            if (existingUids.has(uid)) { skipped++; continue; }

            existingAccounts.push({
                id: generateId(),
                uid,
                password,
                project,
                name: 'Unknown',
                photo: null,
                status: 'PENDING',
                cookiesPath: null,
                dateCreated: new Date().toISOString(),
                lastChecked: null,
            });

            existingUids.add(uid);
            imported++;
        }

        store.set('accounts', existingAccounts);
        return { success: true, imported, skipped, total: existingAccounts.length };
    } catch (error) {
        return { success: false, error: error.message };
    }
});

// ============================================
// IPC: Verify selected accounts (Playwright — Headed)
// ============================================
ipcMain.handle('account:verify-selected', async (_event, ids) => {
    let results = { verified: 0, failed: 0, total: ids.length };

    try {
        const { chromium } = require('playwright');
        const sessionDir = path.join(app.getPath('userData'), 'sessions');
        if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir, { recursive: true });

        for (let i = 0; i < ids.length; i++) {
            const accountId = ids[i];
            const accounts = store.get('accounts', []);
            const account = accounts.find((a) => a.id === accountId);
            if (!account) continue;

            sendProgress({ currentId: accountId, currentIndex: i + 1, total: ids.length, status: 'LOGGING_IN', message: `Login ke akun ${account.uid}...` });

            let browser = null;
            try {
                browser = await chromium.launch({
                    headless: false,
                    ...SMART_BROWSER_CONFIG,
                    ignoreDefaultArgs: ['--enable-automation'],
                    args: [
                        '--disable-blink-features=AutomationControlled',
                        '--start-maximized',
                        '--disable-infobars',
                        '--disable-features=IsolateOrigins,site-per-process',
                    ],
                });
                const context = await browser.newContext({ viewport: null });
                const page = await context.newPage();

                await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
                await page.waitForTimeout(1500);

                // Fill login form with multiple fallback selectors
                try {
                    await page.fill('input#email', account.uid, { timeout: 10000 });
                    await page.fill('input#pass', account.password, { timeout: 5000 });
                    // Try multiple button selectors — XPath role='button' is primary
                    try {
                        await page.click('(//*[@role="button"])[2]', { timeout: 3000 });
                    } catch {
                        try {
                            await page.click('button[name="login"]', { timeout: 3000 });
                        } catch {
                            await page.click('button[type="submit"]', { timeout: 3000 });
                        }
                    }
                } catch {
                    try {
                        await page.fill('input[name="email"]', account.uid, { timeout: 5000 });
                        await page.fill('input[name="pass"]', account.password, { timeout: 5000 });
                        try {
                            await page.click('(//*[@role="button"])[2]', { timeout: 3000 });
                        } catch {
                            try {
                                await page.click('button[name="login"]', { timeout: 3000 });
                            } catch {
                                await page.click('button[type="submit"]', { timeout: 3000 });
                            }
                        }
                    } catch { throw new Error('Gagal menemukan form login.'); }
                }

                // SMART WAIT — jeda 10 detik setelah klik login
                sendProgress({ currentId: accountId, currentIndex: i + 1, total: ids.length, status: 'WAITING_2FA', message: `Menunggu respons login ${account.uid}... (10 detik)` });

                try {
                    await page.waitForURL((url) => {
                        const href = url.href.toLowerCase();
                        return href !== 'https://www.facebook.com/' || isHomePage(href) || isInterventionPage(href);
                    }, { timeout: 30000 });
                } catch { }

                // Jeda 10 detik supaya halaman benar-benar selesai load
                await page.waitForTimeout(10000);

                let loginSuccess = false;
                let isCheckpoint = false;
                const currentUrl = page.url();

                if (isHomePage(currentUrl)) {
                    // Konfirmasi ulang — tunggu 3 detik lagi dan cek sekali lagi
                    await page.waitForTimeout(3000);
                    const confirmUrl = page.url();
                    if (isHomePage(confirmUrl) && !isLoginPage(confirmUrl)) {
                        loginSuccess = true;
                    }
                } else if (isInterventionPage(currentUrl)) {
                    console.log(`[ROBOTFB] Intervention for ${account.uid}: ${currentUrl}`);
                    sendProgress({ currentId: accountId, currentIndex: i + 1, total: ids.length, status: 'WAITING_USER', message: `⚠️ Selesaikan Puzzle/2FA Manual untuk ${account.uid}! (max 10 menit)` });

                    const TIMEOUT = 600000, POLL = 2000, start = Date.now();
                    while (Date.now() - start < TIMEOUT) {
                        await page.waitForTimeout(POLL);
                        try {
                            if (isHomePage(page.url())) { loginSuccess = true; break; }
                            try { if (await page.$('div[role="feed"]')) { loginSuccess = true; break; } } catch { }
                            const rem = Math.ceil((TIMEOUT - (Date.now() - start)) / 1000);
                            sendProgress({ currentId: accountId, currentIndex: i + 1, total: ids.length, status: 'WAITING_USER', message: `⚠️ Puzzle/2FA ${account.uid}... (sisa ${Math.floor(rem / 60)}m ${rem % 60}s)` });
                        } catch (e) { if (e.message && e.message.includes('closed')) break; }
                    }
                    if (!loginSuccess) isCheckpoint = true;
                } else {
                    // Masih di halaman lain — tunggu 5 detik lagi dan cek ulang
                    await page.waitForTimeout(5000);
                    const retry = page.url();
                    if (isHomePage(retry)) loginSuccess = true;
                    else if (isInterventionPage(retry)) isCheckpoint = true;
                }

                // Update store
                const fresh = store.get('accounts', []);
                const idx = fresh.findIndex((a) => a.id === accountId);
                if (idx === -1) { await browser.close(); continue; }

                if (loginSuccess) {
                    sendProgress({ currentId: accountId, currentIndex: i + 1, total: ids.length, status: 'SAVING', message: `Login berhasil! Menyimpan cookies ${account.uid}...` });

                    const cookiesPath = path.join(sessionDir, `${accountId}.json`);
                    await context.storageState({ path: cookiesPath });

                    // ONLY update status & cookies — name/photo handled by fetch-profile
                    fresh[idx].status = 'ACTIVE';
                    fresh[idx].cookiesPath = cookiesPath;
                    fresh[idx].lastChecked = new Date().toISOString();
                    results.verified++;
                } else if (isCheckpoint) {
                    fresh[idx].status = 'CHECKPOINT';
                    fresh[idx].lastChecked = new Date().toISOString();
                    results.failed++;
                } else {
                    fresh[idx].status = 'INVALID';
                    fresh[idx].lastChecked = new Date().toISOString();
                    results.failed++;
                }

                store.set('accounts', fresh);
                sendProgress({ currentId: accountId, currentIndex: i + 1, total: ids.length, status: 'DONE', message: `Selesai: ${account.uid} → ${fresh[idx].status}`, accountStatus: fresh[idx].status });

                await browser.close();
                browser = null;
                if (i < ids.length - 1) await new Promise((r) => setTimeout(r, 2000));

            } catch (err) {
                console.error(`[ROBOTFB] Error verifying ${account.uid}:`, err.message);
                const fresh = store.get('accounts', []);
                const idx = fresh.findIndex((a) => a.id === accountId);
                if (idx !== -1) { fresh[idx].status = 'INVALID'; fresh[idx].lastChecked = new Date().toISOString(); store.set('accounts', fresh); }
                results.failed++;
                sendProgress({ currentId: accountId, currentIndex: i + 1, total: ids.length, status: 'ERROR', message: `Gagal: ${account.uid} — ${err.message}`, accountStatus: 'INVALID' });
                if (browser) { try { await browser.close(); } catch { } browser = null; }
            }
        }
    } catch (error) {
        console.error('[ROBOTFB] Verify flow error:', error.message);
        return { success: false, error: error.message, ...results };
    }

    sendProgress({ currentId: null, currentIndex: ids.length, total: ids.length, status: 'COMPLETE', message: `Selesai! ${results.verified} berhasil, ${results.failed} gagal.` });
    return { success: true, ...results };
});

// ============================================
// IPC: Open browser with saved cookies (Stealth Mode)
// ============================================
ipcMain.handle('account:open-browser', async (_event, accountId) => {
    try {
        // If already open, just report
        if (activeBrowsers[accountId]) {
            return { success: true, message: 'Browser sudah terbuka.', newStatus: 'ACTIVE', alreadyOpen: true };
        }

        const accounts = store.get('accounts', []);
        const account = accounts.find((a) => a.id === accountId);
        if (!account) return { success: false, error: 'Akun tidak ditemukan.' };
        if (!account.cookiesPath || !fs.existsSync(account.cookiesPath)) {
            return { success: false, error: 'Cookies belum tersedia. Verifikasi akun terlebih dahulu.' };
        }

        const { chromium } = require('playwright');

        // STEALTH: Launch real Chrome, remove automation indicators
        const browser = await chromium.launch({
            headless: false,
            ...SMART_BROWSER_CONFIG,
            ignoreDefaultArgs: ['--enable-automation'],
            args: [
                '--disable-infobars',
                '--start-maximized',
                '--disable-blink-features=AutomationControlled',
                '--disable-features=IsolateOrigins,site-per-process',
            ],
        });

        const context = await browser.newContext({
            viewport: null,
            storageState: account.cookiesPath,
        });
        const page = await context.newPage();

        // Remove webdriver flag
        await page.addInitScript(() => {
            Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
        });

        // Track this browser instance
        activeBrowsers[accountId] = browser;

        // Listen for manual close (user clicks X on browser)
        browser.on('disconnected', () => {
            delete activeBrowsers[accountId];
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('account:browser-closed', accountId);
            }
        });

        await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForTimeout(3000);

        const currentUrl = page.url();
        const idx = accounts.findIndex((a) => a.id === accountId);

        if (isLoginPage(currentUrl)) {
            accounts[idx].status = 'INVALID';
            accounts[idx].lastChecked = new Date().toISOString();
            store.set('accounts', accounts);
            delete activeBrowsers[accountId];
            await browser.close();
            return { success: false, error: 'Cookies expired. Akun perlu login ulang.', newStatus: 'INVALID' };
        } else {
            // ONLY update status — name/photo/stats handled by fetch-profile
            accounts[idx].status = 'ACTIVE';
            accounts[idx].lastChecked = new Date().toISOString();
            store.set('accounts', accounts);
            return { success: true, message: 'Akun aktif. Browser terbuka (stealth mode).', newStatus: 'ACTIVE' };
        }
    } catch (error) {
        delete activeBrowsers[accountId];
        return { success: false, error: error.message };
    }
});

// ============================================
// IPC: Close browser for an account
// ============================================
ipcMain.handle('account:close-browser', async (_event, accountId) => {
    try {
        const browser = activeBrowsers[accountId];
        if (browser) {
            await browser.close();
            delete activeBrowsers[accountId];
        }
        return { success: true };
    } catch (error) {
        delete activeBrowsers[accountId];
        return { success: false, error: error.message };
    }
});

// ============================================
// IPC: Manual Login (User logs in manually, cookies saved on close)
// ============================================
ipcMain.handle('account:manual-login', async (_event, accountId) => {
    try {
        const accounts = store.get('accounts', []);
        const account = accounts.find((a) => a.id === accountId);
        if (!account) return { success: false, error: 'Akun tidak ditemukan.' };

        const { chromium } = require('playwright');
        const sessionDir = path.join(app.getPath('userData'), 'sessions');
        if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir, { recursive: true });

        // Use chromium.launch() + newContext() — same approach as working auto-login
        const browser = await chromium.launch({
            headless: false,
            ...SMART_BROWSER_CONFIG,
            ignoreDefaultArgs: ['--enable-automation'],
            args: [
                '--disable-infobars',
                '--start-maximized',
                '--disable-blink-features=AutomationControlled',
                '--disable-features=IsolateOrigins,site-per-process',
            ],
        });

        const context = await browser.newContext({ viewport: null });
        const page = await context.newPage();

        // Remove webdriver flag
        await page.addInitScript(() => {
            Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
        });

        // Navigate to /settings — this will REDIRECT to login page if not logged in
        // This prevents false-positive "already logged in" detection
        await page.goto('https://www.facebook.com/settings', { waitUntil: 'domcontentloaded', timeout: 30000 });

        // Poll: wait for user to manually login
        // We detect login by checking if URL has LEFT the login page
        let loginSuccess = false;
        let cookiesSaved = false;
        let browserClosed = false;

        browser.on('disconnected', () => { browserClosed = true; });

        // Poll every 3 seconds while browser is open, max 30 minutes
        const MAX_WAIT = 30 * 60 * 1000;
        const POLL_INTERVAL = 3000;
        const startTime = Date.now();

        while (!browserClosed && (Date.now() - startTime) < MAX_WAIT) {
            await new Promise((r) => setTimeout(r, POLL_INTERVAL));
            if (browserClosed) break;

            if (!cookiesSaved) {
                try {
                    const openPages = context.pages();
                    if (openPages.length === 0) break;
                    const currentPage = openPages[openPages.length - 1];
                    const currentUrl = currentPage.url().toLowerCase();

                    // Detect: URL is NO LONGER the login page (user has logged in)
                    const isStillOnLogin = currentUrl.includes('login') || currentUrl.includes('/checkpoint') || currentUrl === 'https://www.facebook.com/' || currentUrl === 'https://www.facebook.com';

                    if (!isStillOnLogin && currentUrl.includes('facebook.com')) {
                        console.log(`[MANUAL-LOGIN] Login detected! URL: ${currentUrl}`);

                        // Jeda 10 detik setelah login terdeteksi
                        console.log(`[MANUAL-LOGIN] Menunggu 10 detik...`);
                        await new Promise((r) => setTimeout(r, 10000));
                        if (browserClosed) break;

                        // Navigate ke /me untuk konfirmasi + load cookies lengkap
                        console.log(`[MANUAL-LOGIN] Navigasi ke /me...`);
                        try {
                            await currentPage.goto('https://www.facebook.com/me', { waitUntil: 'domcontentloaded', timeout: 15000 });
                        } catch { }

                        // Jeda 5 detik lagi
                        console.log(`[MANUAL-LOGIN] Menunggu 5 detik di /me...`);
                        await new Promise((r) => setTimeout(r, 5000));
                        if (browserClosed) break;

                        // Save cookies
                        const cookiesPath = path.join(sessionDir, `${accountId}.json`);
                        await context.storageState({ path: cookiesPath });
                        cookiesSaved = true;
                        loginSuccess = true;

                        const fresh = store.get('accounts', []);
                        const idx = fresh.findIndex((a) => a.id === accountId);
                        if (idx !== -1) {
                            fresh[idx].status = 'ACTIVE';
                            fresh[idx].cookiesPath = cookiesPath;
                            fresh[idx].lastChecked = new Date().toISOString();
                            store.set('accounts', fresh);
                        }

                        console.log(`[MANUAL-LOGIN] ${account.uid} → Cookies saved!`);

                        // Tutup browser otomatis
                        try { await browser.close(); } catch { }
                        break;
                    }
                } catch (pollErr) {
                    if (pollErr.message && (pollErr.message.includes('closed') || pollErr.message.includes('destroyed'))) break;
                }
            }
        }

        // If timeout reached and browser still open, close it
        if (!browserClosed) {
            try { await browser.close(); } catch { }
        }

        // Notify renderer
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('account:manual-login-closed', {
                accountId,
                success: loginSuccess,
                cookiesSaved,
            });
        }

        return {
            success: loginSuccess,
            cookiesSaved,
            message: loginSuccess
                ? 'Login berhasil! Cookies tersimpan. Browser ditutup.'
                : 'Browser ditutup. Cookies tidak tersimpan (login belum berhasil).',
            newStatus: loginSuccess ? 'ACTIVE' : undefined,
        };
    } catch (error) {
        console.error('[MANUAL-LOGIN] Error:', error.message);
        return { success: false, error: error.message };
    }
});

// ============================================
// IPC: Import Cookies (User pastes cookie text directly)
// Supports JSON array format: [{"name":"c_user","value":"...","domain":".facebook.com",...}]
// ============================================
ipcMain.handle('account:import-cookies', async (_event, accountId, cookieText) => {
    try {
        const accounts = store.get('accounts', []);
        const account = accounts.find((a) => a.id === accountId);
        if (!account) return { success: false, error: 'Akun tidak ditemukan.' };

        const { chromium } = require('playwright');
        const sessionDir = path.join(app.getPath('userData'), 'sessions');
        if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir, { recursive: true });

        // Parse the cookie text
        let parsedCookies = [];
        const trimmed = cookieText.trim();

        // Map sameSite values from Cookie-Editor format to Playwright format
        const mapSameSite = (val) => {
            if (!val) return 'None';
            const lower = String(val).toLowerCase();
            if (lower === 'no_restriction' || lower === 'none' || lower === 'unspecified') return 'None';
            if (lower === 'lax') return 'Lax';
            if (lower === 'strict') return 'Strict';
            return 'None';
        };

        if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
            // JSON format — Cookie-Editor exports this format
            const raw = JSON.parse(trimmed);
            const arr = Array.isArray(raw) ? raw : [raw];

            parsedCookies = arr
                .filter(c => (c.name || c.Name) && (c.value !== undefined || c.Value !== undefined))
                .map(c => {
                    // Cookie-Editor uses expirationDate (unix timestamp in seconds)
                    let expires = -1;
                    if (c.expirationDate) expires = Number(c.expirationDate);
                    else if (c.expires) expires = Number(c.expires);
                    else if (c.Expires) expires = Number(c.Expires);

                    // If session cookie (no expiry), set to -1 (Playwright session cookie)
                    if (!expires || isNaN(expires) || expires <= 0) expires = -1;

                    return {
                        name: String(c.name || c.Name),
                        value: String(c.value ?? c.Value ?? ''),
                        domain: String(c.domain || c.Domain || '.facebook.com'),
                        path: String(c.path || c.Path || '/'),
                        expires,
                        httpOnly: Boolean(c.httpOnly ?? c.HttpOnly ?? false),
                        secure: Boolean(c.secure ?? c.Secure ?? true),
                        sameSite: mapSameSite(c.sameSite || c.SameSite),
                    };
                });
        } else if (trimmed.includes('=') && trimmed.includes(';') && !trimmed.includes('\t')) {
            // Raw header string format: name1=val1;name2=val2;...
            console.log(`[IMPORT-COOKIES] Detected raw header string format`);
            const pairs = trimmed.split(';').filter(p => p.trim().length > 0);
            for (const pair of pairs) {
                const eqIndex = pair.indexOf('=');
                if (eqIndex < 1) continue;
                const name = pair.substring(0, eqIndex).trim();
                const value = pair.substring(eqIndex + 1).trim();
                parsedCookies.push({
                    name,
                    value,
                    domain: '.facebook.com',
                    path: '/',
                    expires: -1,
                    httpOnly: false,
                    secure: true,
                    sameSite: 'None',
                });
            }
        } else {
            // Netscape/text format: domain \t flag \t path \t secure \t expiry \t name \t value
            const lines = trimmed.split('\n').filter(l => l.trim() && !l.startsWith('#'));
            for (const line of lines) {
                const parts = line.split('\t');
                if (parts.length >= 7) {
                    parsedCookies.push({
                        name: parts[5].trim(),
                        value: parts[6] ? parts[6].trim() : '',
                        domain: parts[0].trim(),
                        path: parts[2].trim(),
                        expires: parseInt(parts[4]) || -1,
                        httpOnly: false,
                        secure: parts[3].trim().toUpperCase() === 'TRUE',
                        sameSite: 'None',
                    });
                }
            }
        }

        if (parsedCookies.length === 0) {
            return { success: false, error: 'Tidak ada cookies yang valid ditemukan. Pastikan format JSON (Cookie-Editor), Netscape, atau raw string (key=value;...).' };
        }

        console.log(`[IMPORT-COOKIES] Parsed ${parsedCookies.length} cookies for ${account.uid}`);

        // Save to storageState file
        const storageState = {
            cookies: parsedCookies,
            origins: [],
        };

        const cookiesPath = path.join(sessionDir, `${accountId}.json`);
        fs.writeFileSync(cookiesPath, JSON.stringify(storageState, null, 2), 'utf-8');

        // Validate: open VISIBLE Chrome, inject cookies, and check login
        let isValid = false;

        try {
            const browser = await chromium.launch({
                headless: false,
                ...SMART_BROWSER_CONFIG,
                ignoreDefaultArgs: ['--enable-automation'],
                args: [
                    '--disable-infobars',
                    '--start-maximized',
                    '--disable-blink-features=AutomationControlled',
                    '--disable-features=IsolateOrigins,site-per-process',
                ],
            });

            const context = await browser.newContext({ viewport: null });

            // Inject cookies via addCookies (more reliable than storageState for Cookie-Editor format)
            await context.addCookies(parsedCookies);

            const page = await context.newPage();

            // Remove webdriver flag
            await page.addInitScript(() => {
                Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
            });

            // Navigate to /me to verify cookies work
            console.log(`[IMPORT-COOKIES] Navigasi ke facebook.com/me...`);
            await page.goto('https://www.facebook.com/me', { waitUntil: 'domcontentloaded', timeout: 20000 });

            // Jeda 10 detik biar halaman fully load
            console.log(`[IMPORT-COOKIES] Menunggu 10 detik untuk validasi...`);
            await page.waitForTimeout(10000);

            const currentUrl = page.url().toLowerCase();
            console.log(`[IMPORT-COOKIES] URL setelah inject: ${currentUrl}`);

            // Check: if URL is NOT login/checkpoint, cookies work!
            const isLoginUrl = currentUrl.includes('login') || currentUrl.includes('/checkpoint');
            const isFacebook = currentUrl.includes('facebook.com');
            isValid = isFacebook && !isLoginUrl;

            if (isValid) {
                // Re-export storageState from the working browser (paling akurat)
                await context.storageState({ path: cookiesPath });
                console.log(`[IMPORT-COOKIES] ✅ Cookies valid! Disimpan ulang dari browser.`);
            } else {
                console.log(`[IMPORT-COOKIES] ❌ Cookies invalid — masih di login page.`);
            }

            await browser.close();
        } catch (valErr) {
            console.error('[IMPORT-COOKIES] Validation error:', valErr.message);
        }

        // Update account
        const fresh = store.get('accounts', []);
        const idx = fresh.findIndex((a) => a.id === accountId);
        if (idx !== -1) {
            fresh[idx].cookiesPath = cookiesPath;
            fresh[idx].status = isValid ? 'ACTIVE' : 'PENDING';
            fresh[idx].lastChecked = new Date().toISOString();
            store.set('accounts', fresh);
        }

        return {
            success: true,
            isValid,
            cookieCount: parsedCookies.length,
            message: isValid
                ? `✅ ${parsedCookies.length} cookies berhasil diimpor dan login terverifikasi! Akun aktif.`
                : `❌ ${parsedCookies.length} cookies tersimpan, tapi login gagal. Cek ulang cookies.`,
            newStatus: isValid ? 'ACTIVE' : 'PENDING',
        };
    } catch (error) {
        console.error('[IMPORT-COOKIES] Error:', error.message);
        return { success: false, error: `Gagal parse cookies: ${error.message}` };
    }
});


// ============================================
// IPC: Open URL in system browser
// ============================================
ipcMain.handle('app:open-external', async (_event, url) => {
    if (url && typeof url === 'string') {
        await shell.openExternal(url);
    }
});

// ============================================
// IPC: Validate selected cookies (Headless bulk check)
// ============================================
ipcMain.handle('account:validate-selected', async (_event, ids) => {
    let results = { active: 0, invalid: 0, skipped: 0, total: ids.length };

    try {
        const { chromium } = require('playwright');

        for (let i = 0; i < ids.length; i++) {
            const accountId = ids[i];
            const accounts = store.get('accounts', []);
            const account = accounts.find((a) => a.id === accountId);
            if (!account) { results.skipped++; continue; }

            sendProgress({ currentId: accountId, currentIndex: i + 1, total: ids.length, status: 'VALIDATING', message: `Mengecek cookies ${account.uid}... (${i + 1}/${ids.length})` });

            if (!account.cookiesPath || !fs.existsSync(account.cookiesPath)) {
                results.skipped++;
                sendProgress({ currentId: accountId, currentIndex: i + 1, total: ids.length, status: 'DONE', message: `Dilewati: ${account.uid} (belum ada cookies)`, accountStatus: account.status });
                continue;
            }

            let browser = null;
            try {
                browser = await chromium.launch({
                    headless: true,
                    ...SMART_BROWSER_CONFIG,
                    ignoreDefaultArgs: ['--enable-automation'],
                    args: [
                        '--disable-blink-features=AutomationControlled',
                        '--no-sandbox',
                        '--disable-infobars',
                        '--disable-features=IsolateOrigins,site-per-process',
                    ],
                });
                const context = await browser.newContext({ storageState: account.cookiesPath });
                const page = await context.newPage();

                await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded', timeout: 20000 });
                await page.waitForTimeout(2000);

                const url = page.url();
                const idx = accounts.findIndex((a) => a.id === accountId);

                if (isLoginPage(url) || isInterventionPage(url)) {
                    accounts[idx].status = 'INVALID';
                    accounts[idx].lastChecked = new Date().toISOString();
                    results.invalid++;
                    sendProgress({ currentId: accountId, currentIndex: i + 1, total: ids.length, status: 'DONE', message: `${account.uid} → INVALID (cookies expired)`, accountStatus: 'INVALID' });
                } else {
                    // ONLY update status — name/photo/stats handled by fetch-profile
                    accounts[idx].status = 'ACTIVE';
                    accounts[idx].lastChecked = new Date().toISOString();
                    results.active++;
                    sendProgress({ currentId: accountId, currentIndex: i + 1, total: ids.length, status: 'DONE', message: `${account.uid} → ACTIVE ✓`, accountStatus: 'ACTIVE' });
                }

                store.set('accounts', accounts);
                await browser.close();
                browser = null;
            } catch (err) {
                if (browser) { try { await browser.close(); } catch { } }
                results.invalid++;
                sendProgress({ currentId: accountId, currentIndex: i + 1, total: ids.length, status: 'ERROR', message: `${account.uid} → Error: ${err.message}`, accountStatus: 'INVALID' });
            }

            if (i < ids.length - 1) await new Promise((r) => setTimeout(r, 500));
        }
    } catch (error) {
        return { success: false, error: error.message, ...results };
    }

    sendProgress({ currentId: null, currentIndex: ids.length, total: ids.length, status: 'COMPLETE', message: `Validasi selesai! ${results.active} aktif, ${results.invalid} invalid, ${results.skipped} dilewati.` });
    return { success: true, ...results };
});

// ============================================
// IPC: Fetch Account Profile (Dedicated /me extractor)
// ============================================
ipcMain.handle('account:fetch-profile', async (_event, accountId) => {
    let browser = null;
    try {
        const { chromium } = require('playwright');
        const accounts = store.get('accounts') || [];
        const account = accounts.find((a) => a.id === accountId);
        if (!account) return { success: false, error: 'Akun tidak ditemukan.' };

        const fs = require('fs');
        if (!account.cookiesPath || !fs.existsSync(account.cookiesPath)) {
            return { success: false, error: 'Cookies belum tersedia. Login/verifikasi akun terlebih dahulu.' };
        }

        browser = await chromium.launch({
            headless: true,
            ...SMART_BROWSER_CONFIG,
            ignoreDefaultArgs: ['--enable-automation'],
            args: [
                '--disable-blink-features=AutomationControlled',
                '--no-sandbox',
                '--disable-infobars',
                '--disable-features=IsolateOrigins,site-per-process',
            ],
        });
        const context = await browser.newContext({ storageState: account.cookiesPath });
        const page = await context.newPage();

        // Navigasi ke /me — Facebook akan redirect ke URL profil user
        await page.goto('https://www.facebook.com/me', { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForTimeout(4000); // Tunggu redirect + React render

        const profileData = await page.evaluate(() => {
            let name = '';
            let pic = '';

            // --- STRATEGI 1: BEDAH JEROAN SCRIPT (The Ultimate Surgeon) ---
            const scripts = Array.from(document.querySelectorAll('script'));
            for (const script of scripts) {
                const text = script.textContent;

                if (text.includes('"actor":{"__typename":"User"') || text.includes('EAA')) {
                    // 1. Ekstrak Nama
                    if (!name) {
                        const nameMatch = text.match(/"name":"([^"]+)"/);
                        if (nameMatch && nameMatch[1].length > 2 && !nameMatch[1].includes('Facebook')) {
                            name = nameMatch[1];
                        }
                    }

                    // 2. Ekstrak Foto Profil (URL scontent yang di-escape)
                    if (!pic) {
                        const picMatch = text.match(/"uri":"(https:\\\/\\\/scontent[^"]+)"/) || text.match(/"uri":"(https:\/\/scontent[^"]+)"/);
                        if (picMatch) {
                            pic = picMatch[1].replace(/\\/g, '');
                        }
                    }
                }
                if (name && pic) break;
            }

            // --- STRATEGI 2: SANITASI TITLE (Jika Jeroan Gagal) ---
            if (!name) {
                let docTitle = document.title;
                // HAPUS ANGKA NOTIFIKASI! "(2) Facebook" → "Facebook"
                docTitle = docTitle.replace(/^\(\d+\)\s*/, '');

                if (docTitle.includes(' | Facebook')) {
                    name = docTitle.split(' | Facebook')[0].trim();
                } else if (docTitle.includes(' - Facebook')) {
                    name = docTitle.split(' - Facebook')[0].trim();
                } else if (docTitle !== 'Facebook') {
                    name = docTitle;
                }
            }

            // --- STRATEGI 3: FALLBACK FOTO DOM ---
            if (!pic || !pic.includes('scontent')) {
                const imgNode = document.querySelector('svg[role="img"] image');
                if (imgNode) {
                    pic = imgNode.getAttribute('xlink:href') || '';
                }
            }

            // --- SANITASI AKHIR ---
            if (!name || name.toLowerCase().includes('facebook') || name.toLowerCase().includes('notifikasi') || name.toLowerCase().includes('cari teman')) {
                name = 'Unknown Account';
            }

            return { name, pic };
        });

        console.log(`[FETCH-PROFILE] ${account.uid} → name="${profileData.name}", pic="${profileData.pic ? 'YES' : 'NO'}"`);

        // --- TAHAP 2: AMBIL STATISTIK DARI MOBILE FACEBOOK (THE BYPASS) ---
        let statsData = { activeListings: '0', unreadChats: '0', marketplaceAccess: true };
        try {
            await page.goto('https://m.facebook.com/marketplace/you/dashboard', { waitUntil: 'domcontentloaded', timeout: 30000 });
            await page.waitForTimeout(3000);

            // Check if redirected to ineligible page
            const currentUrl = page.url();
            if (currentUrl.includes('/ineligible')) {
                console.log(`[FETCH-PROFILE] ${account.uid} → MARKETPLACE INELIGIBLE`);
                statsData = { activeListings: 'N/A', unreadChats: 'N/A', marketplaceAccess: false };
            } else {
                statsData = await page.evaluate(() => {
                    let activeListings = '0';
                    let unreadChats = '0';

                    const bodyText = document.body.innerText;

                    // 1. Ekstrak Obrolan ("0\nObrolan yang perlu dijawab")
                    const chatMatch = bodyText.match(/(\d+\+?)\s*(?:Obrolan yang perlu|Chats to answer)/i);
                    if (chatMatch) unreadChats = chatMatch[1];

                    // 2. Ekstrak Tawaran Aktif ("20+\nAktif & sedang diproses")
                    const activeMatch = bodyText.match(/(\d+\+?)\s*(?:Tawaran aktif|Active listings|Aktif & sedang diproses)/i);
                    if (activeMatch) activeListings = activeMatch[1];

                    return { activeListings, unreadChats, marketplaceAccess: true };
                });
            }
            console.log(`[FETCH-PROFILE] ${account.uid} → listings=${statsData.activeListings}, chats=${statsData.unreadChats}, mpAccess=${statsData.marketplaceAccess}`);
        } catch (statsErr) {
            console.warn(`[FETCH-PROFILE] Stats extraction failed for ${account.uid}:`, statsErr.message);
        }

        await browser.close();
        browser = null;

        // Update electron-store (always save stats, conditionally save profile)
        const idx = accounts.findIndex((a) => a.id === accountId);
        if (idx !== -1) {
            accounts[idx].activeListings = statsData.activeListings;
            accounts[idx].unreadChats = statsData.unreadChats;
            accounts[idx].marketplaceAccess = statsData.marketplaceAccess;

            if (profileData.name && profileData.name !== 'Unknown' && profileData.name !== 'Unknown Account') {
                accounts[idx].name = profileData.name;
                if (profileData.pic) accounts[idx].profilePicture = profileData.pic;
            }
            store.set('accounts', accounts);
        }

        if (profileData.name && profileData.name !== 'Unknown' && profileData.name !== 'Unknown Account') {
            return { success: true, data: { ...profileData, ...statsData } };
        } else {
            return { success: false, error: 'Gagal menemukan elemen profil. Pastikan akun sudah login.' };
        }
    } catch (error) {
        if (browser) { try { await browser.close(); } catch { } }
        console.error('[FETCH-PROFILE] Error:', error.message);
        return { success: false, error: error.message };
    }
});

// ============================================
// IPC: Bulk Fetch Profile (sequential, with progress)
// ============================================
ipcMain.handle('account:fetch-profile-bulk', async (event, ids) => {
    let totalSuccess = 0, totalFailed = 0;
    const total = ids.length;

    for (let i = 0; i < ids.length; i++) {
        const accountId = ids[i];
        const accounts = store.get('accounts', []);
        const account = accounts.find(a => a.id === accountId);

        // Send progress to renderer
        mainWindow?.webContents.send('account:progress-update', {
            status: 'SCRAPING',
            message: `📸 Fetching profil ${i + 1}/${total}: ${account?.uid || accountId}`,
            currentIndex: i + 1,
            total,
            currentId: accountId,
        });

        try {
            // Reuse the single fetch-profile logic via internal call
            const result = await ipcMain.handle.__fetchProfileInternal(accountId);
            if (result.success) totalSuccess++;
            else totalFailed++;
        } catch {
            totalFailed++;
        }

        // Small delay between fetches to avoid rate limiting
        if (i < ids.length - 1) {
            await new Promise(r => setTimeout(r, 1500));
        }
    }

    // Send completion
    mainWindow?.webContents.send('account:progress-update', {
        status: 'COMPLETE',
        message: `✅ Selesai! ${totalSuccess} berhasil, ${totalFailed} gagal.`,
        currentIndex: total,
        total,
    });

    return { success: true, totalSuccess, totalFailed, total };
});

// Internal helper to reuse fetch-profile logic
ipcMain.handle.__fetchProfileInternal = async (accountId) => {
    let browser = null;
    try {
        const { chromium } = require('playwright');
        const accounts = store.get('accounts') || [];
        const account = accounts.find(a => a.id === accountId);
        if (!account) return { success: false, error: 'Akun tidak ditemukan.' };

        if (!account.cookiesPath || !fs.existsSync(account.cookiesPath)) {
            return { success: false, error: 'Cookies belum tersedia.' };
        }

        browser = await chromium.launch({
            headless: true, ...SMART_BROWSER_CONFIG,
            ignoreDefaultArgs: ['--enable-automation'],
            args: ['--disable-blink-features=AutomationControlled', '--no-sandbox', '--disable-infobars'],
        });
        const context = await browser.newContext({ storageState: account.cookiesPath });
        const page = await context.newPage();

        await page.goto('https://www.facebook.com/me', { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForTimeout(4000);

        const profileData = await page.evaluate(() => {
            let name = '', pic = '';
            const scripts = Array.from(document.querySelectorAll('script'));
            for (const script of scripts) {
                const text = script.textContent;
                if (text.includes('"actor":{"__typename":"User"') || text.includes('EAA')) {
                    if (!name) {
                        const m = text.match(/"name":"([^"]+)"/);
                        if (m && m[1].length > 2 && !m[1].includes('Facebook')) name = m[1];
                    }
                    if (!pic) {
                        const m = text.match(/"uri":"(https:\\\/\\\/scontent[^"]+)"/) || text.match(/"uri":"(https:\/\/scontent[^"]+)"/);
                        if (m) pic = m[1].replace(/\\/g, '');
                    }
                }
                if (name && pic) break;
            }
            if (!name) {
                let t = document.title.replace(/^\(\d+\)\s*/, '');
                if (t.includes(' | Facebook')) name = t.split(' | Facebook')[0].trim();
                else if (t.includes(' - Facebook')) name = t.split(' - Facebook')[0].trim();
                else if (t !== 'Facebook') name = t;
            }
            if (!pic || !pic.includes('scontent')) {
                const img = document.querySelector('svg[role="img"] image');
                if (img) pic = img.getAttribute('xlink:href') || '';
            }
            if (!name || name.toLowerCase().includes('facebook')) name = 'Unknown Account';
            return { name, pic };
        });

        // Stats
        let statsData = { activeListings: '0', unreadChats: '0', marketplaceAccess: true };
        try {
            await page.goto('https://m.facebook.com/marketplace/you/dashboard', { waitUntil: 'domcontentloaded', timeout: 30000 });
            await page.waitForTimeout(3000);

            const currentUrl = page.url();
            if (currentUrl.includes('/ineligible')) {
                statsData = { activeListings: 'N/A', unreadChats: 'N/A', marketplaceAccess: false };
            } else {
                statsData = await page.evaluate(() => {
                    const bodyText = document.body.innerText;
                    const chat = bodyText.match(/(\d+\+?)\s*(?:Obrolan yang perlu|Chats to answer)/i);
                    const active = bodyText.match(/(\d+\+?)\s*(?:Tawaran aktif|Active listings|Aktif & sedang diproses)/i);
                    return { activeListings: active?.[1] || '0', unreadChats: chat?.[1] || '0', marketplaceAccess: true };
                });
            }
        } catch { }

        await browser.close();
        browser = null;

        const freshAccounts = store.get('accounts', []);
        const idx = freshAccounts.findIndex(a => a.id === accountId);
        if (idx !== -1) {
            freshAccounts[idx].activeListings = statsData.activeListings;
            freshAccounts[idx].unreadChats = statsData.unreadChats;
            freshAccounts[idx].marketplaceAccess = statsData.marketplaceAccess;
            if (profileData.name && profileData.name !== 'Unknown' && profileData.name !== 'Unknown Account') {
                freshAccounts[idx].name = profileData.name;
                if (profileData.pic) freshAccounts[idx].profilePicture = profileData.pic;
            }
            store.set('accounts', freshAccounts);
        }

        return profileData.name && profileData.name !== 'Unknown Account'
            ? { success: true, data: { ...profileData, ...statsData } }
            : { success: false, error: 'Gagal extract profil' };
    } catch (err) {
        if (browser) try { await browser.close(); } catch { }
        return { success: false, error: err.message };
    }
};

// ============================================
// IPC: Bulk Update Project
// ============================================
ipcMain.handle('account:update-project', async (_event, ids, newProject) => {
    try {
        const accounts = store.get('accounts', []);
        const idSet = new Set(ids);
        let updated = 0;
        for (const acc of accounts) {
            if (idSet.has(acc.id)) {
                acc.project = newProject || 'General';
                updated++;
            }
        }
        store.set('accounts', accounts);
        return { success: true, updated };
    } catch (err) {
        return { success: false, error: err.message };
    }
});

// ============================================
// IPC: Open CSV File Dialog
// ============================================
ipcMain.handle('dialog:open-csv', async () => {
    try {
        const result = await dialog.showOpenDialog(mainWindow, {
            title: 'Pilih File CSV',
            filters: [{ name: 'CSV Files', extensions: ['csv', 'txt'] }],
            properties: ['openFile'],
        });
        if (result.canceled || !result.filePaths.length) {
            return { success: false, canceled: true };
        }
        const content = fs.readFileSync(result.filePaths[0], 'utf-8');
        return { success: true, content, filePath: result.filePaths[0] };
    } catch (err) {
        return { success: false, error: err.message };
    }
});

// ============================================
// Helper: Title Case formatter
// ============================================
function toTitleCase(str) {
    return str.replace(/\w\S*/g, (txt) => {
        return txt.charAt(0).toUpperCase() + txt.substr(1).toLowerCase();
    });
}

// ============================================
// IPC: Marketplace – Scrape Keywords (Token Grabber + Multi-Batch)
// ============================================
ipcMain.handle('marketplace:scrape-keywords', async (event, { keywords: rawInput, mode }) => {
    let tokenBrowser = null;

    try {
        if (!rawInput || !rawInput.trim()) {
            return { success: false, error: 'Kata kunci tidak boleh kosong.' };
        }

        // Parse input: split by comma or newline, trim, deduplicate
        const rootKeywords = [...new Set(
            rawInput.split(/[,\n]+/).map((k) => k.trim()).filter((k) => k.length > 0)
        )];
        if (rootKeywords.length === 0) {
            return { success: false, error: 'Tidak ada kata kunci valid ditemukan.' };
        }

        const startTime = performance.now();

        const accounts = store.get('accounts', []);
        const activeAccount = accounts.find((a) => a.status === 'ACTIVE' && a.cookiesPath && fs.existsSync(a.cookiesPath));
        if (!activeAccount) {
            return { success: false, error: 'Harap login minimal 1 akun di menu Manajemen Akun dulu!' };
        }

        const { chromium } = require('playwright');

        // ── PHASE 1: TOKEN GRABBER ──
        sendProgress({
            currentId: 'keyword-scrape',
            currentIndex: 0,
            total: 1,
            status: 'SCRAPING',
            message: 'Menginisialisasi engine pencarian...',
        });

        console.log(`[KEYWORDS] Phase 1: Token grab for ${activeAccount.uid}...`);
        tokenBrowser = await chromium.launch({
            headless: true,
            ...SMART_BROWSER_CONFIG,
            ignoreDefaultArgs: ['--enable-automation'],
            args: [
                '--disable-blink-features=AutomationControlled',
                '--no-sandbox',
                '--disable-infobars',
                '--disable-features=IsolateOrigins,site-per-process',
            ],
        });
        const browserContext = await tokenBrowser.newContext({
            storageState: activeAccount.cookiesPath,
        });
        const page = await browserContext.newPage();
        await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForTimeout(3000);

        const currentUrl = page.url();
        if (isLoginPage(currentUrl)) {
            await tokenBrowser.close();
            return { success: false, error: 'Cookies expired. Login ulang akun ini di Manajemen Akun.' };
        }

        const fbDtsg = await page.evaluate(() => {
            if (window.DTSGInitData && window.DTSGInitData.token) return window.DTSGInitData.token;
            try { if (typeof require === 'function') { const m = require('DTSGInitData'); if (m && m.token) return m.token; } } catch { }
            const input = document.querySelector('input[name="fb_dtsg"]');
            if (input) return input.value;
            const html = document.documentElement.innerHTML;
            const m1 = html.match(/"DTSGInitData".*?"token":"([^"]+)"/);
            if (m1) return m1[1];
            const m2 = html.match(/fb_dtsg.*?value="([^"]+)"/);
            if (m2) return m2[1];
            return null;
        });

        await tokenBrowser.close();
        tokenBrowser = null;
        console.log(`[KEYWORDS] Token: ${fbDtsg ? fbDtsg.substring(0, 20) + '...' : 'NULL'}`);

        if (!fbDtsg) {
            return { success: false, error: 'Gagal membangun koneksi aman. Coba login ulang akun ini di Manajemen Akun.' };
        }

        // ── PHASE 2: MULTI-KEYWORD BATCH ──
        console.log(`[KEYWORDS] Phase 2: Batch processing ${rootKeywords.length} root keywords...`);

        const requestContext = await (require('playwright')).request.newContext({
            storageState: activeAccount.cookiesPath,
            extraHTTPHeaders: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
                'Accept-Language': 'en-US,en;q=0.9',
                'Origin': 'https://www.facebook.com',
                'Referer': 'https://www.facebook.com/marketplace/',
                'Sec-Fetch-Site': 'same-origin',
                'Sec-Fetch-Mode': 'cors',
                'Sec-Fetch-Dest': 'empty',
            },
        });

        // Helper: single API request
        async function fetchKeywordsAPI(query) {
            try {
                const response = await requestContext.post('https://www.facebook.com/api/graphql/', {
                    form: {
                        fb_dtsg: fbDtsg,
                        doc_id: '9807803949296946',
                        variables: JSON.stringify({ query: query, count: 10 }),
                    },
                    timeout: 15000,
                });
                if (response.status() !== 200) return [];
                let text = await response.text();
                text = text.replace('for (;;);', '');
                const json = JSON.parse(text);
                const suggestions = json?.data?.viewer?.marketplace_search_typeahead_suggestions_v2 || [];
                return suggestions.map((item) => item.query).filter(Boolean);
            } catch (e) {
                console.error(`[KEYWORDS] Error "${query}":`, e.message);
                return [];
            }
        }

        // Helper: concurrency limiter
        async function batchWithConcurrency(tasks, limit) {
            const results = [];
            const executing = new Set();
            for (const task of tasks) {
                const p = task().then((r) => { executing.delete(p); return r; });
                executing.add(p);
                results.push(p);
                if (executing.size >= limit) await Promise.race(executing);
            }
            return Promise.all(results);
        }

        // Build suffix list for A-Z mode
        const suffixes = mode === 'A-Z' ? (() => {
            const s = [' '];
            for (let c = 97; c <= 122; c++) s.push(' ' + String.fromCharCode(c));
            for (let n = 0; n <= 9; n++) s.push(' ' + n);
            return s;
        })() : null;

        const totalSteps = rootKeywords.length * (mode === 'A-Z' ? 37 : 1);
        let globalStep = 0;

        const allResults = []; // { rootKeyword, keyword }
        const breakdown = {}; // rootKeyword -> count

        for (let ri = 0; ri < rootKeywords.length; ri++) {
            const root = rootKeywords[ri];
            let rootResults = [];

            if (mode === 'A-Z') {
                const tasks = suffixes.map((suffix) => () => {
                    globalStep++;
                    sendProgress({
                        currentId: 'keyword-scrape',
                        currentIndex: globalStep,
                        total: totalSteps,
                        status: 'SCRAPING',
                        message: `Menganalisis "${root}${suffix.trim() ? suffix : ''}" ... [${ri + 1}/${rootKeywords.length}] (${globalStep}/${totalSteps})`,
                    });
                    return fetchKeywordsAPI(root + suffix);
                });
                const batchResults = await batchWithConcurrency(tasks, 5);
                rootResults = batchResults.flat();
            } else {
                globalStep++;
                sendProgress({
                    currentId: 'keyword-scrape',
                    currentIndex: globalStep,
                    total: totalSteps,
                    status: 'SCRAPING',
                    message: `Menganalisis algoritma saran kata "${root}" ... [${ri + 1}/${rootKeywords.length}]`,
                });
                rootResults = await fetchKeywordsAPI(root);
            }

            // Deduplicate per root + Title Case
            const uniqueRoot = [...new Set(rootResults.map((k) => toTitleCase(k.trim())))].filter((k) => k.length > 0);
            uniqueRoot.forEach((kw) => allResults.push({ rootKeyword: root, keyword: kw }));
            breakdown[root] = uniqueRoot.length;
            console.log(`[KEYWORDS] "${root}" → ${uniqueRoot.length} unique results`);
        }

        await requestContext.dispose();

        // Global dedup by keyword (keep first rootKeyword)
        const seen = new Set();
        const dedupResults = [];
        for (const item of allResults) {
            if (!seen.has(item.keyword)) {
                seen.add(item.keyword);
                dedupResults.push(item);
            }
        }
        dedupResults.sort((a, b) => a.keyword.localeCompare(b.keyword));

        const executionTime = ((performance.now() - startTime) / 1000).toFixed(1);

        sendProgress({
            currentId: 'keyword-scrape',
            currentIndex: totalSteps,
            total: totalSteps,
            status: 'COMPLETE',
            message: `Selesai! Ditemukan ${dedupResults.length} kata kunci unik dalam ${executionTime} detik.`,
        });

        console.log(`[KEYWORDS] DONE: ${dedupResults.length} keywords in ${executionTime}s`);

        // ── AUTO-SAVE to keyword_history ──
        const history = store.get('keyword_history', []);
        const dateStr = new Date().toLocaleDateString('id-ID', { day: '2-digit', month: 'short', year: 'numeric' });

        // Group results by rootKeyword and save each as a history entry
        const grouped = {};
        for (const item of dedupResults) {
            if (!grouped[item.rootKeyword]) grouped[item.rootKeyword] = [];
            grouped[item.rootKeyword].push(item.keyword);
        }

        const newHistoryIds = [];
        for (const [root, kws] of Object.entries(grouped)) {
            const entry = {
                id: Date.now() + '_' + Math.random().toString(36).substring(2, 6),
                rootKeyword: root,
                total: kws.length,
                date: dateStr,
                keywords: kws,
            };
            history.unshift(entry);
            newHistoryIds.push(entry.id);
        }
        store.set('keyword_history', history);
        console.log(`[KEYWORDS] Auto-saved ${newHistoryIds.length} history entries`);

        return {
            success: true,
            results: dedupResults,
            newHistoryIds,
            report: {
                rootKeywords: rootKeywords.length,
                totalFound: dedupResults.length,
                executionTime: parseFloat(executionTime),
                breakdown,
            },
        };
    } catch (error) {
        if (tokenBrowser) {
            try { await tokenBrowser.close(); } catch { }
        }
        console.error('[KEYWORDS] Fatal error:', error.message);
        return { success: false, error: error.message };
    }
});

// ============================================
// IPC: Keyword History CRUD (Persistent via electron-store)
// ============================================
ipcMain.handle('keyword:get-history', async () => {
    return store.get('keyword_history', []);
});

ipcMain.handle('keyword:delete-history', async (event, id) => {
    const history = store.get('keyword_history', []);
    const filtered = history.filter((h) => h.id !== id);
    store.set('keyword_history', filtered);
    console.log(`[KEYWORDS DB] Deleted history "${id}". Remaining: ${filtered.length}`);
    return { success: true, remaining: filtered.length };
});

// ============================================
// IPC: Delete individual keyword from history entry
// ============================================
ipcMain.handle('keyword:delete-keyword', async (_event, historyId, keyword) => {
    try {
        const history = store.get('keyword_history', []);
        const entry = history.find(h => h.id === historyId);
        if (!entry) return { success: false, error: 'Entry not found' };

        entry.keywords = entry.keywords.filter(kw => kw !== keyword);
        entry.total = entry.keywords.length;

        // If all keywords removed, delete the entire entry
        if (entry.keywords.length === 0) {
            const idx = history.indexOf(entry);
            history.splice(idx, 1);
        }

        store.set('keyword_history', history);
        console.log(`[KEYWORDS DB] Deleted keyword "${keyword}" from "${historyId}". Remaining: ${entry.keywords.length}`);
        return { success: true, remaining: entry.keywords.length };
    } catch (err) {
        return { success: false, error: err.message };
    }
});

// ============================================
// IPC: Material Builder (Dialog + Save)
// ============================================
ipcMain.handle('dialog:open-images', async () => {
    const win = BrowserWindow.getFocusedWindow();
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
        title: 'Pilih Foto Produk (Maks 20)',
        properties: ['openFile', 'multiSelections'],
        filters: [{ name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'webp'] }],
    });
    if (canceled) return [];
    return filePaths; // Array of absolute paths (e.g. C:\Users\...\foto.jpg)
});

ipcMain.handle('dialog:open-image-folder', async () => {
    const win = BrowserWindow.getFocusedWindow();
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
        title: 'Pilih Folder Foto Produk',
        properties: ['openDirectory'],
    });
    if (canceled || !filePaths || filePaths.length === 0) return [];
    const folderPath = filePaths[0];
    const imageExts = ['.jpg', '.jpeg', '.png', '.webp'];
    try {
        const files = fs.readdirSync(folderPath)
            .filter(f => imageExts.includes(path.extname(f).toLowerCase()))
            .sort()
            .map(f => path.join(folderPath, f));
        return files;
    } catch {
        return [];
    }
});

ipcMain.handle('material:save', async (event, materials) => {
    if (!Array.isArray(materials) || materials.length === 0) {
        return { success: false, error: 'Tidak ada data.' };
    }

    // ── Trial Enforcement: Material Limit ──
    const trialCheck = await checkTrialLimit('materials', materials.length);
    if (!trialCheck.allowed) {
        return { success: false, error: trialCheck.message, trial_limit: true };
    }

    const existing = store.get('posting_materials', []);
    const merged = [...existing, ...materials];
    store.set('posting_materials', merged);
    console.log(`[MATERIALS] Saved ${materials.length} items. Total: ${merged.length}`);
    return { success: true, added: materials.length, total: merged.length };
});

ipcMain.handle('material:get-all', async () => {
    return store.get('posting_materials', []);
});

ipcMain.handle('material:delete-all', async () => {
    store.set('posting_materials', []);
    return { success: true };
});

ipcMain.handle('material:delete', async (event, ids) => {
    if (!Array.isArray(ids) || ids.length === 0) {
        return { success: false, error: 'Tidak ada ID.' };
    }
    const idSet = new Set(ids);
    const existing = store.get('posting_materials', []);
    const filtered = existing.filter((m) => !idSet.has(m.id));
    store.set('posting_materials', filtered);
    console.log(`[MATERIALS] Deleted ${ids.length} items. Remaining: ${filtered.length}`);
    return { success: true, deleted: ids.length, remaining: filtered.length };
});

// ============================================
// IPC: Location Database CRUD (Persistent via electron-store)
// ============================================
ipcMain.handle('location:get-all', async () => {
    return store.get('saved_locations', []);
});

ipcMain.handle('location:save-bulk', async (event, newLocations) => {
    if (!Array.isArray(newLocations) || newLocations.length === 0) {
        return { success: false, error: 'Tidak ada data untuk disimpan.' };
    }
    const existing = store.get('saved_locations', []);
    const existingNames = new Set(existing.map((l) => l.fbName));

    const toAdd = newLocations.filter((loc) => !existingNames.has(loc.fbName));
    const merged = [...existing, ...toAdd];
    store.set('saved_locations', merged);
    console.log(`[LOCATIONS DB] Saved ${toAdd.length} new (${newLocations.length - toAdd.length} duplicates skipped). Total: ${merged.length}`);
    return { success: true, added: toAdd.length, total: merged.length };
});

ipcMain.handle('location:delete', async (event, ids) => {
    if (!Array.isArray(ids) || ids.length === 0) {
        return { success: false, error: 'Tidak ada data untuk dihapus.' };
    }
    const idSet = new Set(ids);
    const existing = store.get('saved_locations', []);
    const filtered = existing.filter((l) => !idSet.has(l.id));
    store.set('saved_locations', filtered);
    console.log(`[LOCATIONS DB] Deleted ${existing.length - filtered.length} locations. Remaining: ${filtered.length}`);
    return { success: true, deleted: existing.length - filtered.length, total: filtered.length };
});

// ============================================
// IPC: Marketplace – Scrape Locations (Token Grabber + API Request)
// ============================================
ipcMain.handle('marketplace:scrape-locations', async (event, { cities, province }) => {
    let tokenBrowser = null;

    try {
        if (!cities || !Array.isArray(cities) || cities.length === 0) {
            return { success: false, error: 'Daftar kota tidak boleh kosong.' };
        }

        const accounts = store.get('accounts', []);
        const activeAccount = accounts.find((a) => a.status === 'ACTIVE' && a.cookiesPath && fs.existsSync(a.cookiesPath));
        if (!activeAccount) {
            return { success: false, error: 'Harap login minimal 1 akun di menu Manajemen Akun dulu!' };
        }

        const { chromium } = require('playwright');

        // ── PHASE 1: TOKEN GRABBER ──
        sendProgress({
            currentId: 'location-scrape',
            currentIndex: 0,
            total: cities.length,
            status: 'SCRAPING',
            message: 'Menginisialisasi engine pencarian lokasi...',
        });

        console.log(`[LOCATIONS] Phase 1: Token grab for ${activeAccount.uid}...`);
        tokenBrowser = await chromium.launch({
            headless: true,
            ...SMART_BROWSER_CONFIG,
            ignoreDefaultArgs: ['--enable-automation'],
            args: [
                '--disable-blink-features=AutomationControlled',
                '--no-sandbox',
                '--disable-infobars',
                '--disable-features=IsolateOrigins,site-per-process',
            ],
        });
        const browserContext = await tokenBrowser.newContext({
            storageState: activeAccount.cookiesPath,
        });
        const page = await browserContext.newPage();
        await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForTimeout(3000);

        const currentUrl = page.url();
        if (isLoginPage(currentUrl)) {
            await tokenBrowser.close();
            return { success: false, error: 'Sesi kadaluarsa. Login ulang akun ini di Manajemen Akun.' };
        }

        const fbDtsg = await page.evaluate(() => {
            if (window.DTSGInitData && window.DTSGInitData.token) return window.DTSGInitData.token;
            try { if (typeof require === 'function') { const m = require('DTSGInitData'); if (m && m.token) return m.token; } } catch { }
            const input = document.querySelector('input[name="fb_dtsg"]');
            if (input) return input.value;
            const html = document.documentElement.innerHTML;
            const m1 = html.match(/"DTSGInitData".*?"token":"([^"]+)"/);
            if (m1) return m1[1];
            const m2 = html.match(/fb_dtsg.*?value="([^"]+)"/);
            if (m2) return m2[1];
            return null;
        });

        await tokenBrowser.close();
        tokenBrowser = null;
        console.log(`[LOCATIONS] Token: ${fbDtsg ? fbDtsg.substring(0, 20) + '...' : 'NULL'}`);

        if (!fbDtsg) {
            return { success: false, error: 'Gagal membangun koneksi aman. Coba login ulang akun ini di Manajemen Akun.' };
        }

        // ── PHASE 2: API LOCATION REQUESTS ──
        console.log(`[LOCATIONS] Phase 2: Searching ${cities.length} cities...`);

        const requestContext = await (require('playwright')).request.newContext({
            storageState: activeAccount.cookiesPath,
            extraHTTPHeaders: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
                'Accept-Language': 'en-US,en;q=0.9',
                'Origin': 'https://www.facebook.com',
                'Referer': 'https://www.facebook.com/marketplace/',
                'Sec-Fetch-Site': 'same-origin',
                'Sec-Fetch-Mode': 'cors',
                'Sec-Fetch-Dest': 'empty',
            },
        });

        // Helper: single location API request
        async function fetchLocationAPI(cityName) {
            try {
                const variables = {
                    params: {
                        caller: 'MARKETPLACE',
                        integration_strategy: 'STRING_MATCH',
                        page_category: ['CITY', 'SUBCITY', 'NEIGHBORHOOD', 'POSTAL_CODE'],
                        query: cityName,
                        search_type: 'PLACE_TYPEAHEAD',
                    },
                };

                const response = await requestContext.post('https://www.facebook.com/api/graphql/', {
                    form: {
                        fb_dtsg: fbDtsg,
                        doc_id: '9660140454040174',
                        variables: JSON.stringify(variables),
                    },
                    timeout: 15000,
                });

                if (response.status() !== 200) {
                    console.log(`[LOCATIONS] Status ${response.status()} for "${cityName}"`);
                    return [];
                }

                let text = await response.text();
                text = text.replace('for (;;);', '');
                const json = JSON.parse(text);

                // Parse edges
                const edges = json?.data?.city_street_search?.street_results?.edges || [];
                console.log(`[LOCATIONS] "${cityName}" → ${edges.length} results`);

                return edges.map((edge) => {
                    const node = edge?.node || {};
                    const name = node.name || '';
                    const subtitle = node.subtitle || '';
                    const singleLineAddress = node.single_line_address || '';

                    // Extract coordinates from the node
                    const latitude = node.latitude ?? node.location?.latitude ?? null;
                    const longitude = node.longitude ?? node.location?.longitude ?? null;

                    // Build fbName: prefer single_line_address, fallback to name + subtitle
                    let fbName = singleLineAddress || name;
                    if (!singleLineAddress && subtitle) {
                        fbName = name + ', ' + subtitle;
                    }

                    // Extract people visited count with robust regex
                    // Matches patterns like: "778 orang pernah singgah", "1.234 people visited", "5,678 orang"
                    let peopleVisited = 0;
                    const visitMatch = subtitle.match(/([\d.,]+)\s*(?:orang|people|visitor)/i);
                    if (visitMatch) {
                        peopleVisited = parseInt(visitMatch[1].replace(/[.,]/g, ''), 10) || 0;
                    }

                    return {
                        id: node.id || `loc_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
                        inputCity: cityName,
                        fbName: fbName,
                        province: province || '',
                        peopleVisited: peopleVisited,
                        latitude: latitude,
                        longitude: longitude,
                    };
                }).filter((item) => item.fbName.length > 0);
            } catch (e) {
                console.error(`[LOCATIONS] Error "${cityName}":`, e.message);
                return [];
            }
        }

        // Concurrency limiter
        async function batchWithConcurrency(tasks, limit) {
            const results = [];
            const executing = new Set();
            for (const task of tasks) {
                const p = task().then((r) => { executing.delete(p); return r; });
                executing.add(p);
                results.push(p);
                if (executing.size >= limit) await Promise.race(executing);
            }
            return Promise.all(results);
        }

        let completed = 0;
        const tasks = cities.map((city) => () => {
            completed++;
            sendProgress({
                currentId: 'location-scrape',
                currentIndex: completed,
                total: cities.length,
                status: 'SCRAPING',
                message: `Mencari lokasi "${city}" ... (${completed}/${cities.length})`,
            });
            return fetchLocationAPI(city);
        });

        const batchResults = await batchWithConcurrency(tasks, 3);
        const allLocations = batchResults.flat();

        await requestContext.dispose();

        sendProgress({
            currentId: 'location-scrape',
            currentIndex: cities.length,
            total: cities.length,
            status: 'COMPLETE',
            message: `Selesai! Ditemukan ${allLocations.length} lokasi dari ${cities.length} kota.`,
        });

        console.log(`[LOCATIONS] DONE: ${allLocations.length} locations from ${cities.length} cities`);
        return { success: true, locations: allLocations, total: allLocations.length };
    } catch (error) {
        if (tokenBrowser) {
            try { await tokenBrowser.close(); } catch { }
        }
        console.error('[LOCATIONS] Fatal error:', error.message);
        return { success: false, error: error.message };
    }
});

// ============================================
// IPC: Marketplace – Auto Posting Engine (API Based)
// ============================================
const postingAbortMap = new Map(); // per-campaign abort flags

ipcMain.handle('marketplace:stop-posting', async (_event, campaignId) => {
    if (campaignId) {
        postingAbortMap.set(campaignId, true);
        console.log(`[POSTING] Abort requested for campaign ${campaignId}`);
    } else {
        // Legacy fallback: stop all
        for (const key of postingAbortMap.keys()) {
            postingAbortMap.set(key, true);
        }
        console.log('[POSTING] Abort requested for ALL campaigns.');
    }
    return { success: true };
});

ipcMain.handle('marketplace:start-posting', async (event, payload) => {
    const { accountIds, materialIds, delayMin = 30, delayMax = 60, concurrency = 1, modePosting = 'STANDAR', hideFromFriends = false, campaignId = null, distributionMode = 'ALL_TO_ALL', accountMaterialMap = null } = payload;

    // Per-campaign abort flag
    const cid = campaignId || `legacy_${Date.now()}`;
    postingAbortMap.set(cid, false);
    const isAborted = () => postingAbortMap.get(cid) === true;

    const allAccounts = store.get('accounts', []);
    const allMaterials = store.get('posting_materials', []);

    // Resolve selected accounts & materials
    const selectedAccounts = allAccounts.filter((a) => accountIds.includes(a.id) && a.status === 'ACTIVE' && a.cookiesPath);
    const selectedMaterials = allMaterials.filter((m) => materialIds.includes(m.id));

    if (selectedAccounts.length === 0) {
        postingAbortMap.delete(cid);
        return { success: false, error: 'Tidak ada akun ACTIVE yang valid (perlu cookiesPath).' };
    }
    if (selectedMaterials.length === 0) {
        postingAbortMap.delete(cid);
        return { success: false, error: 'Tidak ada bahan posting yang dipilih.' };
    }

    // ── Fix #1: Build per-account material lists based on distribution mode ──
    const materialsByAccount = {};
    if (accountMaterialMap && (distributionMode === 'SPLIT_EVEN' || distributionMode === 'CUSTOM')) {
        for (const acc of selectedAccounts) {
            const matIds = accountMaterialMap[acc.id] || [];
            materialsByAccount[acc.id] = selectedMaterials.filter(m => matIds.includes(m.id));
        }
    } else {
        // ALL_TO_ALL: every account gets all materials
        for (const acc of selectedAccounts) {
            materialsByAccount[acc.id] = [...selectedMaterials];
        }
    }

    const totalTasks = Object.values(materialsByAccount).reduce((sum, arr) => sum + arr.length, 0);

    // ── Fix #4: Trial enforcement with accurate task count ──
    const trialCheck = await checkTrialLimit('posts', totalTasks);
    if (!trialCheck.allowed) {
        postingAbortMap.delete(cid);
        return { success: false, error: trialCheck.message, trial_limit: true };
    }

    // ── Fix #2: Use object for shared counters (atomic read-write in same tick) ──
    const progress = { done: 0, failed: 0 };

    // ── Fix #3: Centralized posting history writer ──
    function appendPostingHistory(entry) {
        const history = store.get('posting_history', []);
        history.unshift(entry);
        if (history.length > 5000) history.length = 5000;
        store.set('posting_history', history);
    }

    const sendLog = (msg, type = 'info', meta = {}) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('posting:log', { msg, type, campaignId: cid, ...meta });
        }
    };
    const sendStatus = (data) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('posting:status', { campaignId: cid, ...data });
        }
    };

    sendLog(`🚀 Misi dimulai! ${selectedAccounts.length} akun, ${totalTasks} tugas | Mode: ${modePosting} | Distribusi: ${distributionMode}`, 'success');

    const { chromium } = require('playwright');

    // ── ACCOUNT WORKER: Process assigned materials for ONE account ──
    const processOneAccount = async (account, ai) => {
        const accountMaterials = materialsByAccount[account.id] || [];
        if (isAborted()) return;

        sendLog(`👤 [${account.name || account.uid}] Membuka sesi...`);
        sendStatus({ accountId: account.id, status: 'Membuka Facebook...', step: 0 });

        let browser = null;
        let context = null;

        try {
            // Verify cookies file exists
            if (!fs.existsSync(account.cookiesPath)) {
                sendLog(`❌ [${account.name || account.uid}] File cookies tidak ditemukan. Skip.`, 'error');
                progress.failed += accountMaterials.length;
                return;
            }

            // Launch stealth browser with stored cookies
            browser = await createStealthBrowser(true);
            context = await createStealthContext(browser, account.cookiesPath);
            const page = await context.newPage();

            // Navigate to Facebook to activate cookies
            sendStatus({ accountId: account.id, status: 'Login dengan cookies...', step: 1 });
            try {
                await page.goto('https://www.facebook.com/', { waitUntil: 'commit', timeout: 45000 });
            } catch (navErr) {
                console.log(`[POSTING] Warning: Navigasi FB timeout (${navErr.message}), mencoba lanjut...`);
            }
            await page.waitForTimeout(4000); // Beri waktu FB render scripts

            // Check if cookies are valid
            const currentUrl = page.url().toLowerCase();
            if (currentUrl.includes('login') || currentUrl.includes('checkpoint')) {
                sendLog(`❌ [${account.name || account.uid}] Cookies expired / checkpoint. Skip.`, 'error');
                markAccountInvalid(account.id, 'Cookies expired saat posting');
                progress.failed += accountMaterials.length;
                await browser.close();
                return;
            }

            // Extract credentials with RETRY (FB sering lambat render token)
            sendStatus({ accountId: account.id, status: 'Mengekstrak token...', step: 2 });
            let fbDtsg = null;
            let uid = null;
            for (let attempt = 1; attempt <= 3; attempt++) {
                fbDtsg = await extractFbDtsg(page);
                uid = await extractUid(context);
                if (fbDtsg && uid) break;
                console.log(`[TOKEN] Attempt ${attempt}/3 gagal (dtsg=${!!fbDtsg}, uid=${!!uid}), retry in 3s...`);
                await page.waitForTimeout(3000);
            }

            if (!fbDtsg || !uid) {
                sendLog(`❌ [${account.name || account.uid}] Gagal ekstrak token/UID setelah 3x percobaan. Skip.`, 'error');
                progress.failed += accountMaterials.length;
                await browser.close();
                return;
            }

            sendLog(`✅ [${account.name || account.uid}] Token & UID berhasil diambil. UID: ${uid}`);

            // ==========================================
            // GATEKEEPER: Daily Limit Detector
            // ==========================================
            sendStatus({ accountId: account.id, status: 'Mengecek batas posting...', step: 3 });
            try {
                await page.goto('https://www.facebook.com/marketplace/create/item', { waitUntil: 'commit', timeout: 45000 });
            } catch (navErr) {
                console.log(`[GATEKEEPER] Warning: Navigasi gatekeeper timeout (${navErr.message}), mencoba lanjut...`);
            }
            await page.waitForTimeout(3000);

            const isLimited = await page.evaluate(() => {
                const text = document.body.innerText;
                return text.includes('Batas tercapai') || text.includes('Limit reached');
            });

            if (isLimited) {
                const limitMsg = 'Akun Limit, Jeda 1x24 Jam';
                sendLog(`🚫 [${account.name || account.uid}] ${limitMsg}. Melewati semua bahan.`, 'error');

                // Mark ALL materials as GAGAL and log to posting history
                for (let mi = 0; mi < accountMaterials.length; mi++) {
                    const mat = accountMaterials[mi];
                    progress.failed++;
                    sendStatus({
                        accountId: account.id,
                        materialId: mat.id,
                        status: 'LIMIT',
                        statusText: limitMsg,
                        tasksDone: mi + 1,
                        totalTasks: accountMaterials.length,
                    });

                    appendPostingHistory({
                        id: generateId(),
                        accountId: account.id,
                        accountName: account.name || account.uid,
                        materialId: mat.id,
                        materialTitle: mat.judul || 'Unknown',
                        targetCity: mat.lokasi || '-',
                        status: 'GAGAL',
                        url: '',
                        errorMessage: limitMsg,
                        modePosting,
                        createdAt: new Date().toISOString(),
                    });
                }

                await browser.close();
                return;
            }

            sendLog(`✅ [${account.name || account.uid}] Tidak ada batas posting. Melanjutkan...`);

            // Process each material for this account (SEQUENTIAL within account)
            for (let mi = 0; mi < accountMaterials.length; mi++) {
                if (isAborted()) {
                    sendLog('🛑 Misi dihentikan oleh user.', 'error');
                    break;
                }

                const material = accountMaterials[mi];
                const taskLabel = `[${account.name || account.uid}] #${mi + 1}/${accountMaterials.length}`;

                // ── Fix #7: Token refresh every 15 materials ──
                if (mi > 0 && mi % 15 === 0) {
                    const newToken = await extractFbDtsg(page);
                    if (newToken) {
                        fbDtsg = newToken;
                        sendLog(`🔄 ${taskLabel} Token di-refresh.`);
                    }
                }

                // ── NAVIGASI ULANG ke halaman Create (reset konteks setiap material) ──
                // Wajib agar pushState dari material sebelumnya tidak meracuni upload/API
                try {
                    await page.goto('https://www.facebook.com/marketplace/create/item', { waitUntil: 'commit', timeout: 45000 });
                } catch (navErr) {
                    console.log(`[LOOP-RESET] Warning: Navigasi reset timeout (${navErr.message}), mencoba lanjut...`);
                }
                await page.waitForTimeout(3000);

                // DEBUG LOGGING — Data Pipeline Verification
                console.log(`[DEBUG BAHAN PIPA] Kategori: ${material.kategori}, Lat: ${material.latitude}, Lng: ${material.longitude}`);
                sendLog(`[DEBUG] Cek Data → Kategori: ${material.kategori || 'KOSONG'}, Lat: ${material.latitude || 'KOSONG'}, Lng: ${material.longitude || 'KOSONG'}`);

                sendLog(`📦 ${taskLabel} Memulai: ${material.judul}`, 'info', { accountId: account.id, materialId: material.id });
                sendStatus({
                    accountId: account.id,
                    materialId: material.id,
                    lokasi: material.lokasi || '',
                    status: 'UPLOADING',
                    statusText: 'Mengunggah Foto...',
                    step: 4,
                    currentMaterial: material.judul,
                    tasksDone: mi,
                    totalTasks: accountMaterials.length,
                });

                // ── STEP 1: Upload Photos
                const photoPaths = extractPhotoPaths(material);
                let photoIDs = [];

                if (photoPaths.length > 0) {
                    sendLog(`📸 ${taskLabel} Mengunggah ${photoPaths.length} foto...`);

                    const uploadResult = await uploadMultiplePhotos({
                        page,
                        context,
                        filePaths: photoPaths,
                        onProgress: (idx, total, result) => {
                            if (result.success) {
                                sendLog(`  📷 Foto ${idx}/${total} uploaded: ${result.photoID}`);
                            } else {
                                sendLog(`  ⚠️ Foto ${idx}/${total} gagal: ${result.error}`, 'error');
                            }
                        },
                    });

                    photoIDs = uploadResult.photoIDs.filter(Boolean);

                    if (photoIDs.length === 0) {
                        sendLog(`❌ ${taskLabel} Semua foto gagal diupload. Skip posting ini.`, 'error', { accountId: account.id, materialId: material.id });
                        progress.failed++;
                        sendStatus({ accountId: account.id, materialId: material.id, status: 'ERROR', statusText: 'Foto gagal', step: 4, tasksDone: mi + 1, totalTasks: accountMaterials.length });
                        appendPostingHistory({ id: Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7), accountId: account.id, accountName: account.name || account.uid, materialTitle: material.judul, targetCity: material.lokasi || '', status: 'GAGAL', url: '', errorMessage: 'Semua foto gagal diupload', modePosting, createdAt: new Date().toISOString() });
                        continue;
                    }

                    sendLog(`✅ ${taskLabel} ${photoIDs.length}/${photoPaths.length} foto berhasil diupload.`);
                } else {
                    sendLog(`⚠️ ${taskLabel} Tidak ada foto valid. Posting tanpa foto.`, 'warning');
                }

                // ── STEP 2: Publish Listing via GraphQL
                sendStatus({ accountId: account.id, materialId: material.id, status: 'PUBLISHING', statusText: 'Menerbitkan ke Server FB...', step: 5, currentMaterial: material.judul });

                let publishResult;

                if (modePosting === 'ANTI_DUPLIKAT') {
                    // ══════════════════════════════════════════
                    // KOMBO 3 LANGKAH: Draft → Auto-Save → Launch
                    // ══════════════════════════════════════════

                    // ── TAHAP 1: SIMPAN SEBAGAI DRAF BARU ──
                    sendLog(`🗒️ ${taskLabel} [ANTI-DUPLIKAT] Tahap 1: Menyimpan sebagai Draft...`, 'info', { accountId: account.id, materialId: material.id });

                    const draftResult = await publishListing({
                        page, context, fbDtsg, uid, material, photoIDs,
                        draftType: 'COMMERCE_SELL_OPTIONS',
                        hideFromFriends,
                    });

                    if (!draftResult.success) {
                        publishResult = { success: false, error: `Draft gagal: ${draftResult.error}` };
                    } else {
                        // Extract listing ID from URL
                        const draftUrl = draftResult.url || '';
                        const idMatch = draftUrl.match(/\/item\/(\d+)/) || draftUrl.match(/(\d{10,})/);
                        const listingId = idMatch ? idMatch[1] : null;

                        if (!listingId) {
                            sendLog(`⚠️ ${taskLabel} [ANTI-DUPLIKAT] Draft tersimpan tapi ID tidak ditemukan. URL: ${draftUrl}`, 'warning');
                            publishResult = draftResult;
                        } else {
                            sendLog(`✅ ${taskLabel} [ANTI-DUPLIKAT] Draft tersimpan (ID: ${listingId}).`, 'info');

                            // Extract permanent photo IDs from draft response
                            let realPhotoIds = null;
                            try {
                                if (draftResult.rawJson) {
                                    const resString = JSON.stringify(draftResult.rawJson);
                                    const match = resString.match(/"id":"(\d{15,})"/g);
                                    if (match) {
                                        const possibleIds = match.map(m => m.replace(/"id":"|"/g, ''))
                                            .filter(id => id !== listingId && id !== uid);
                                        if (possibleIds.length > 0) {
                                            realPhotoIds = [possibleIds[0]];
                                        }
                                    }
                                }
                            } catch (e) {
                                console.log('[ANTI-DUPLIKAT] Gagal parsing Asset ID dari response.');
                            }

                            if (realPhotoIds) {
                                sendLog(`📷 ${taskLabel} [ANTI-DUPLIKAT] Mendapat ID Foto Permanen: ${realPhotoIds[0]}`, 'info');
                            } else {
                                sendLog(`📷 ${taskLabel} [ANTI-DUPLIKAT] Menghapus photo_ids dari payload Edit.`, 'info');
                            }

                            // ── TAHAP 2: AUTO-SAVE / UPDATE DATA (Doc ID 249...) ──
                            sendLog(`⏳ ${taskLabel} [ANTI-DUPLIKAT] Jeda 30 detik...`, 'info');
                            await new Promise(r => setTimeout(r, 30000));

                            sendLog(`💾 ${taskLabel} [ANTI-DUPLIKAT] Tahap 2: Auto-Save / Update Data...`, 'info', { accountId: account.id, materialId: material.id });

                            const saveResult = await publishDraftListing({
                                page, context, fbDtsg, uid, material, photoIDs, listingId, realPhotoIds,
                                hideFromFriends,
                            });

                            if (!saveResult.success) {
                                sendLog(`⚠️ ${taskLabel} [ANTI-DUPLIKAT] Tahap 2 gagal: ${saveResult.error}`, 'warning');
                                publishResult = saveResult;
                            } else {
                                // ── TAHAP 3: THE FINAL LAUNCH (Doc ID 901...) ──
                                sendLog(`⏳ ${taskLabel} [ANTI-DUPLIKAT] Jeda 3 detik...`, 'info');
                                await new Promise(r => setTimeout(r, 3000));

                                sendLog(`🚀 ${taskLabel} [ANTI-DUPLIKAT] Tahap 3: Menerbitkan ke Publik!`, 'info', { accountId: account.id, materialId: material.id });

                                const launchResult = await launchDraftToPublic({
                                    page, fbDtsg, uid, listingId,
                                });

                                if (launchResult.success) {
                                    sendLog(`🎯 ${taskLabel} [ANTI-DUPLIKAT] BINGO! Postingan Aktif. ID: ${listingId}`, 'success');
                                    publishResult = launchResult;
                                } else {
                                    sendLog(`❌ ${taskLabel} [ANTI-DUPLIKAT] Tahap 3 gagal: ${launchResult.error}`, 'error');
                                    publishResult = launchResult;
                                }
                            }
                        }
                    }
                } else {
                    // ── STANDAR: Direct publish
                    sendLog(`🚀 ${taskLabel} Mengirim listing ke Facebook...`, 'info', { accountId: account.id, materialId: material.id });

                    publishResult = await publishListing({
                        page, context, fbDtsg, uid, material, photoIDs,
                        hideFromFriends,
                    });
                }

                if (publishResult.success) {
                    progress.done++;
                    sendLog(`✅ ${taskLabel} SUKSES! URL: ${publishResult.url}`, 'success', { accountId: account.id, materialId: material.id });
                    sendStatus({
                        accountId: account.id,
                        materialId: material.id,
                        status: 'SUCCESS',
                        statusText: 'Sukses! ✓',
                        step: 6,
                        currentMaterial: material.judul,
                        url: publishResult.url,
                        tasksDone: mi + 1,
                        totalTasks: accountMaterials.length,
                    });
                    appendPostingHistory({ id: Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7), accountId: account.id, accountName: account.name || account.uid, materialId: material.id, materialTitle: material.judul, targetCity: material.lokasi || '', status: 'SUKSES', url: publishResult.url || '', errorMessage: '', modePosting, createdAt: new Date().toISOString() });
                } else {
                    progress.failed++;
                    sendLog(`❌ ${taskLabel} GAGAL: ${publishResult.error}`, 'error', { accountId: account.id, materialId: material.id });
                    sendStatus({
                        accountId: account.id,
                        materialId: material.id,
                        status: 'ERROR',
                        statusText: publishResult.error || 'Gagal',
                        step: 4,
                        tasksDone: mi + 1,
                        totalTasks: accountMaterials.length,
                    });
                    appendPostingHistory({ id: Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7), accountId: account.id, accountName: account.name || account.uid, materialId: material.id, materialTitle: material.judul, targetCity: material.lokasi || '', status: 'GAGAL', url: '', errorMessage: publishResult.error || 'Unknown error', modePosting, createdAt: new Date().toISOString() });
                }

                // Send global progress
                sendStatus({
                    type: 'global',
                    done: progress.done,
                    failed: progress.failed,
                    total: totalTasks,
                });

                // ── STEP 3: Random delay before next posting
                if (mi < accountMaterials.length - 1) {
                    const delay = Math.floor(Math.random() * (delayMax - delayMin + 1) + delayMin);
                    sendLog(`⏳ ${taskLabel} Jeda ${delay} detik...`);
                    sendStatus({ accountId: account.id, status: `Menunggu ${delay}s...`, step: 3 });

                    // Break delay into 1s chunks so abort can respond quickly
                    for (let d = 0; d < delay; d++) {
                        if (isAborted()) break;
                        await new Promise((r) => setTimeout(r, 1000));
                    }
                }

                // ── Cleanup: reset page to about:blank to free memory
                try { await page.goto('about:blank'); } catch (_) { }
            }

            // Solution 3: Refresh cookies before closing (captures FB token rotations)
            try { await context.storageState({ path: account.cookiesPath }); } catch { }

            // Close this account's browser
            await browser.close();
            browser = null;
            sendLog(`👤 [${account.name || account.uid}] Sesi ditutup.`);

        } catch (err) {
            sendLog(`❌ [${account.name || account.uid}] Error fatal: ${err.message}`, 'error');
            console.error('[POSTING] Account error:', err);
            if (context) { try { await context.close(); } catch { } }
            if (browser) { try { await browser.close(); } catch { } }
        }
    };

    // ── THE EXECUTION POOL (Forced Parallel via Deferred Promises) ──
    sendLog(`🔀 Mode konkurensi: ${concurrency} akun berjalan bersamaan`, 'info');

    const runParallel = async (accounts, limit) => {
        const executing = new Set();

        for (const account of accounts) {
            if (isAborted()) {
                sendLog('🛑 Misi dihentikan oleh user.', 'error');
                break;
            }

            // Force deferred execution — this is the key to actual parallelism
            const p = Promise.resolve().then(() => processOneAccount(account, accounts.indexOf(account)));

            executing.add(p);
            p.finally(() => executing.delete(p));

            // Block ONLY when all concurrent slots are full
            if (executing.size >= limit) {
                await Promise.race(executing);
            }
        }

        // Wait for remaining workers in the last batch
        return Promise.all(executing);
    };

    await runParallel(selectedAccounts, concurrency);

    // Mission complete
    sendLog(`🏁 Misi selesai! ${progress.done} berhasil, ${progress.failed} gagal dari ${totalTasks} tugas.`, 'complete');
    sendStatus({ type: 'global', done: progress.done, failed: progress.failed, total: totalTasks, complete: true });

    // Cleanup abort flag
    postingAbortMap.delete(cid);

    return { success: true, done: progress.done, failed: progress.failed, total: totalTasks };
});


// ============================================
// IPC: Dashboard Stats (Aggregated)
// ============================================
ipcMain.handle('dashboard:get-stats', async () => {
    try {
        const accounts = store.get('accounts', []);
        const history = store.get('posting_history', []);

        const totalAkun = accounts.length;
        const akunAktif = accounts.filter(a => a.status === 'ACTIVE').length;

        let totalTawaranAktif = 0;
        let totalChatUnread = 0;
        accounts.forEach(acc => {
            if (acc.activeListings) {
                const n = parseInt(String(acc.activeListings).replace(/\D/g, ''));
                if (!isNaN(n)) totalTawaranAktif += n;
            }
            if (acc.unreadChats) {
                const n = parseInt(String(acc.unreadChats).replace(/\D/g, ''));
                if (!isNaN(n)) totalChatUnread += n;
            }
        });

        // Today's posting stats
        const todayStr = new Date().toISOString().split('T')[0];
        let totalHariIni = 0;
        let suksesHariIni = 0;
        history.forEach(h => {
            if (h.createdAt && h.createdAt.startsWith(todayStr)) {
                totalHariIni++;
                if (h.status === 'SUKSES') suksesHariIni++;
            }
        });

        return {
            success: true,
            data: { totalAkun, akunAktif, totalTawaranAktif, totalChatUnread, suksesHariIni, totalHariIni }
        };
    } catch (err) {
        console.error('[DASHBOARD] Gagal mengambil stats:', err);
        return { success: false, error: err.message };
    }
});

// ============================================
// IPC: Posting History (Persistence Logging)
// ============================================
ipcMain.handle('posting:get-history', async () => {
    try {
        return { success: true, history: store.get('posting_history', []) };
    } catch (err) {
        console.error('[HISTORY] Gagal mengambil riwayat:', err);
        return { success: false, history: [], error: err.message };
    }
});

ipcMain.handle('posting:clear-history', async () => {
    try {
        store.set('posting_history', []);
        return { success: true };
    } catch (err) {
        return { success: false, error: err.message };
    }
});

// ============================================
// IPC: Optimization History (Renew / Relist / Delete)
// ============================================
ipcMain.handle('optimize:save-entry', async (_event, entry) => {
    try {
        const history = store.get('optimize_history', []);
        history.unshift(entry);
        if (history.length > 5000) history.length = 5000;
        store.set('optimize_history', history);
        return { success: true };
    } catch (err) {
        return { success: false, error: err.message };
    }
});

ipcMain.handle('optimize:get-history', async () => {
    try {
        return { success: true, history: store.get('optimize_history', []) };
    } catch (err) {
        return { success: false, history: [], error: err.message };
    }
});

ipcMain.handle('optimize:clear-history', async () => {
    try {
        store.set('optimize_history', []);
        return { success: true };
    } catch (err) {
        return { success: false, error: err.message };
    }
});

// ============================================
// IPC: Account Health Check (Lightweight)
// ============================================
let healthCheckAbortFlag = false;

ipcMain.handle('account:check-health', async () => {
    healthCheckAbortFlag = false;
    const accounts = store.get('accounts', []);
    const activeAccounts = accounts.filter(a => a.status === 'ACTIVE' && a.cookiesPath && fs.existsSync(a.cookiesPath));

    if (activeAccounts.length === 0) {
        return { success: true, checked: 0, healthy: 0, expired: 0, results: [] };
    }

    const results = [];
    let healthy = 0;
    let expired = 0;

    // Notify progress
    const sendHealthProgress = (data) => {
        try { BrowserWindow.getAllWindows().forEach(w => w.webContents.send('health-check-progress', data)); } catch { }
    };

    sendHealthProgress({ type: 'start', total: activeAccounts.length });

    const { chromium } = require('playwright');

    for (let i = 0; i < activeAccounts.length; i++) {
        if (healthCheckAbortFlag) break;
        const acc = activeAccounts[i];
        sendHealthProgress({ type: 'checking', current: i + 1, total: activeAccounts.length, accountName: acc.name || acc.uid });

        let browser = null;
        try {
            // Use real headless browser — same proven approach as validate-selected
            browser = await chromium.launch({
                headless: true,
                ...SMART_BROWSER_CONFIG,
                ignoreDefaultArgs: ['--enable-automation'],
                args: [
                    '--disable-blink-features=AutomationControlled',
                    '--no-sandbox',
                    '--disable-infobars',
                    '--disable-features=IsolateOrigins,site-per-process',
                ],
            });
            const context = await browser.newContext({ storageState: acc.cookiesPath });
            const page = await context.newPage();

            await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded', timeout: 20000 });
            await page.waitForTimeout(2000);

            const url = page.url();
            if (isLoginPage(url) || isInterventionPage(url)) {
                expired++;
                markAccountInvalid(acc.id, 'Cookies expired (health check)');
                results.push({ accountId: acc.id, accountName: acc.name || acc.uid, status: 'EXPIRED' });
            } else {
                healthy++;
                results.push({ accountId: acc.id, accountName: acc.name || acc.uid, status: 'HEALTHY' });
            }

            await browser.close();
            browser = null;
        } catch (err) {
            console.error(`[HEALTH] Error checking ${acc.uid}:`, err.message);
            results.push({ accountId: acc.id, accountName: acc.name || acc.uid, status: 'ERROR', error: err.message });
            if (browser) { try { await browser.close(); } catch { } browser = null; }
        }

        // Small delay between checks to avoid rate limiting
        if (i < activeAccounts.length - 1) {
            await new Promise(r => setTimeout(r, 500));
        }
    }

    sendHealthProgress({ type: 'done', healthy, expired, total: activeAccounts.length });
    return { success: true, checked: activeAccounts.length, healthy, expired, results };
});

ipcMain.handle('account:stop-health-check', async () => {
    healthCheckAbortFlag = true;
    return { success: true };
});

// ============================================
// Open URL with Account Session (Playwright)
// ============================================
ipcMain.handle('open-url-with-session', async (_event, { url, accountId }) => {
    try {
        const accounts = store.get('accounts', []);
        const account = accounts.find(a => a.id === accountId);
        if (!account || !account.cookiesPath || !fs.existsSync(account.cookiesPath)) {
            return { success: false, error: 'Cookies akun tidak ditemukan' };
        }

        const { chromium } = require('playwright');
        const browser = await chromium.launch({
            headless: false,
            ...SMART_BROWSER_CONFIG,
            ignoreDefaultArgs: ['--enable-automation'],
            args: [
                '--disable-blink-features=AutomationControlled',
                '--no-sandbox',
                '--start-maximized',
            ],
        });
        const context = await browser.newContext({
            storageState: account.cookiesPath,
            viewport: null,
        });
        const page = await context.newPage();
        await page.goto(url, { waitUntil: 'commit', timeout: 45000 });

        console.log(`[OPEN-URL] Opened ${url} with session ${account.name || accountId}`);
        return { success: true };
    } catch (err) {
        console.error('[OPEN-URL] Error:', err);
        return { success: false, error: err.message };
    }
});

ipcMain.handle('posting:delete-selected', async (_event, ids) => {
    try {
        const history = store.get('posting_history', []);
        const idSet = new Set(ids);
        store.set('posting_history', history.filter(h => !idSet.has(h.id)));
        return { success: true };
    } catch (err) {
        return { success: false, error: err.message };
    }
});

// ============================================
// License System
// ============================================

// License System (DUAL SERVER SETUP - AXIOS VERSION)
// ============================================
// 1. Server Asli (Prioritas Utama)
const SERVER_ORI = 'https://akses.markasbot.id/api';

// 2. Server Saya (Google Sheet - Cadangan)
const SERVER_SAYA = 'https://script.google.com/macros/s/AKfycbyk4HUvcXZuaPJ1Pls1Uil9W5dpgpA4bykKdvQI1BxuvnwBLA-uiV2AG6IF94_O2o5I/exec';

function getHWID() {
    const cpu = os.cpus()[0]?.model || 'unknown-cpu';
    const interfaces = os.networkInterfaces();
    const mac = Object.values(interfaces)
        .flat()
        .find(i => !i.internal && i.mac && i.mac !== '00:00:00:00:00:00')?.mac || 'no-mac';
    const raw = cpu + '|' + mac + '|' + os.hostname();
    return crypto.createHash('sha256').update(raw).digest('hex').substring(0, 32);
}


// ── Trial Enforcement Helper (ANTI-CHEAT VERSION) ──
async function checkTrialLimit(type, count = 1) {
    const cached = store.get('license');
    if (!cached || !cached.trial_limits) return { allowed: true };

    // --- JALUR SERVER ASLI ---
    if (cached.source === 'ORI') {
        try {
            const result = await licenseApiCall(SERVER_ORI, 'trial_usage.php', {
                action: 'increment',
                license_key: cached.license_key,
                hwid: getHWID(),
                type, count
            });
            if (!result.success && result.error === 'LIMIT_REACHED') {
                return { allowed: false, message: result.message || `Batas limit server asli tercapai.` };
            }
            return { allowed: result.success };
        } catch { return { allowed: true }; }
    }

    // --- JALUR SERVER SAYA (Validasi Lokal) ---
    else {
        const limits = cached.trial_limits;

        // Mapping Key
        let maxKey = '', usedKey = '';
        if (type === 'posts') { maxKey = 'max_posts'; usedKey = 'used_posts'; }
        else if (type === 'accounts') { maxKey = 'max_accounts'; usedKey = 'used_accounts'; }
        else if (type === 'materials') { maxKey = 'max_materials'; usedKey = 'used_materials'; }

        const maxVal = parseInt(limits[maxKey]) || 0;
        let usedVal = parseInt(limits[usedKey]) || 0;

        if (usedVal + count > maxVal) {
            return {
                allowed: false,
                message: `✋ LIMIT HABIS!\n\nJatah Harian: ${maxVal}\nTerpakai: ${usedVal}\n\nLimit reset otomatis besok (Waktu Server).`
            };
        }

        // Update Counter
        limits[usedKey] = usedVal + count;
        store.set('license.trial_limits', limits); // Simpan perubahan

        console.log(`[LOCAL LIMIT] ${type} +${count}. Total: ${limits[usedKey]}/${maxVal}`);
        return { allowed: true };
    }
}

// Update Helper: Tambahkan parameter 'targetUrl' di depan
async function licenseApiCall(targetUrl, endpoint, body) {
    // A. Logika untuk Server Saya (Google Sheet)
    if (targetUrl === SERVER_SAYA) {
        // Google Sheet butuh 'action' di dalam body, bukan di URL endpoint
        if (endpoint.includes('login')) body.action = 'login';
        else if (endpoint.includes('check')) body.action = 'check';
        else if (endpoint.includes('reset')) body.action = 'reset';

        // Google Sheet endpointnya cuma satu URL utama
        try {
            const response = await axios.post(targetUrl, body, {
                headers: { 'Content-Type': 'application/json' },
                timeout: 30000,
                maxRedirects: 5 // Penting: Izinkan redirect!
            });
            return response.data;
        } catch (error) {
            console.error(`License Error (Google Sheet):`, error.message);
            return { success: false, error: 'Koneksi gagal: ' + error.message };
        }
    }

    // B. Logika untuk Server Asli (PHP/Laravel)
    else {
        const fullUrl = `${targetUrl}/${endpoint}`; // Gabung URL + Endpoint (misal: /login.php)
        try {
            const response = await axios.post(fullUrl, body, {
                headers: { 'Content-Type': 'application/json' },
                timeout: 30000,
                maxRedirects: 5 // Penting: Izinkan redirect!
            });
            return response.data;
        } catch (error) {
            console.error(`License Error (Server Asli):`, error.message);
            return { success: false, error: 'Koneksi gagal: ' + error.message };
        }
    }
}

// --- License: Activate (Logika Dual Server) ---
ipcMain.handle('license:activate', async (_event, email, password) => {
    try {
        const hwid = getHWID();
        let result = { success: false, error: 'Unknown' };
        let activeServer = 'NONE';

        // --- TAHAP 1: COBA SERVER ASLI ---
        console.log('[LOGIN] Mencoba Server Asli...');
        // Perhatikan: endpoint server asli biasanya 'login.php' atau 'login'
        const resultOri = await licenseApiCall(SERVER_ORI, 'login.php', { email, password, hwid });

        if (resultOri && resultOri.success) {
            console.log('[LOGIN] Ditemukan di Server Asli!');
            result = resultOri;
            activeServer = 'ORI';
        }
        else {
            // --- TAHAP 2: JIKA GAGAL, COBA SERVER SAYA ---
            console.log('[LOGIN] Tidak ada di Server Asli. Mencoba Server Saya (Google Sheet)...');
            // Google Sheet endpointnya tetap kita tulis 'login.php' agar masuk ke logika if di atas
            const resultSaya = await licenseApiCall(SERVER_SAYA, 'login.php', { email, password, hwid });

            if (resultSaya && resultSaya.success) {
                console.log('[LOGIN] Ditemukan di Server Saya!');
                result = resultSaya;
                activeServer = 'SAYA';
            } else {
                // Jika dua-duanya gagal, ambil pesan error dari Server Saya (atau Asli)
                result = resultSaya || { success: false, error: 'Koneksi ke kedua server gagal.' };
            }
        }

        // --- PENERJEMAH PESAN ERROR ---
        if (!result.success) {
            if (result.message && !result.error) result.error = result.message;
            if (!result.error) result.error = "Login Gagal. Cek Email/Password.";
        }

        // --- JIKA SUKSES ---
        if (result.success) {
            store.set('license', {
                source: activeServer,
                email: result.user.email,
                username: result.user.username,
                user_id: result.user.id,
                license_key: result.license.key,
                license_type: result.license.type || 'paid',
                product: result.license.product,
                expired_at: result.license.expired_at,
                days_left: result.license.days_left,
                hwid: result.license.hwid,
                trial_limits: result.license.trial_limits || null, // Penting untuk limit
                last_server_date: result.license.server_date || null, // Simpan tanggal server saat login
                last_check: Date.now(),
            });
        }

        return result;

    } catch (err) {
        return { success: false, error: 'System Error: ' + err.message };
    }
});

// --- License: Heartbeat check (FINAL STABLE VERSION) ---
ipcMain.handle('license:check', async () => {
    try {
        const cached = store.get('license');
        if (!cached || !cached.license_key) {
            return { success: false, error: 'No cached license', code: 'NO_CACHE' };
        }

        const targetUrl = (cached.source === 'ORI') ? SERVER_ORI : SERVER_SAYA;
        const hwid = getHWID();

        // 1. Siapkan Laporan Usage (Khusus Server Saya)
        let reportData = {};
        if (cached.source === 'SAYA' && cached.trial_limits) {
            reportData = {
                used_posts: cached.trial_limits.used_posts || 0,
                used_accounts: cached.trial_limits.used_accounts || 0,
                used_materials: cached.trial_limits.used_materials || 0
            };
        }

        // 2. Panggil Server
        const result = await licenseApiCall(targetUrl, 'check.php', {
            license_key: cached.license_key,
            hwid: hwid,
            usage_report: reportData
        });

        if (result.valid) {
            store.set('license.days_left', result.days_left);
            store.set('license.last_check', Date.now());

            // 🔥 LOGIKA ANTI-CHEAT & RESET HARIAN 🔥
            if (result.trial_limits) {
                // Ambil data lokal TERBARU
                const currentLocal = store.get('license');
                const serverLimits = result.trial_limits;

                // Jika Login via Server SAYA (Kita yang kontrol reset)
                if (cached.source === 'SAYA') {

                    const currentServerDate = result.server_date; // "2026-02-24"
                    const lastResetDate = currentLocal.last_server_date || "";

                    // Cek: Apakah Tanggal Server BEDA dengan Tanggal Terakhir Reset?
                    if (currentServerDate && currentServerDate !== lastResetDate) {
                        console.log(`[LIMIT] Ganti Hari (${lastResetDate} -> ${currentServerDate}). RESET LIMIT!`);

                        // RESET JADI 0
                        serverLimits.used_posts = 0;
                        serverLimits.used_accounts = 0;
                        serverLimits.used_materials = 0;

                        // Simpan Tanggal Reset Baru
                        store.set('license.last_server_date', currentServerDate);
                    } else {
                        // MASIH HARI YANG SAMA -> Pertahankan hitungan lokal
                        console.log(`[LIMIT] Hari Sama (${currentServerDate}). Pakai hitungan lokal.`);

                        // Safety Check: Pastikan trial_limits lokal ada
                        const localLimits = currentLocal.trial_limits || {};

                        serverLimits.used_posts = localLimits.used_posts || 0;
                        serverLimits.used_accounts = localLimits.used_accounts || 0;
                        serverLimits.used_materials = localLimits.used_materials || 0;
                    }
                }

                store.set('license.trial_limits', serverLimits);
            }
        } else {
            // Jika Invalid (Banned/Expired/HWID Salah) -> Kill Session
            console.log(`[CHECK] Lisensi Invalid (${result.error}). Menghapus sesi...`);
            store.delete('license');
        }
        return result;

    } catch (err) {
        // Offline Tolerance (24 Jam)
        const cached = store.get('license');
        if (cached && (Date.now() - cached.last_check) < 24 * 60 * 60 * 1000) {
            return { valid: true, days_left: cached.days_left, offline: true };
        }
        return { valid: false, error: 'Gagal koneksi: ' + err.message };
    }
});



// --- License: Reset HWID (Versi Aman: Auto-Logout) ---
ipcMain.handle('license:reset-hwid', async () => {
    try {
        const cached = store.get('license');
        if (!cached || !cached.license_key) {
            return { success: false, error: 'Tidak ada lisensi aktif' };
        }

        // 1. Pilih server sesuai login awal (Server ORI atau Google Sheet)
        const targetUrl = (cached.source === 'ORI') ? SERVER_ORI : SERVER_SAYA;

        // 2. Kirim perintah reset ke server
        const result = await licenseApiCall(targetUrl, 'reset_hwid.php', {
            license_key: cached.license_key,
            email: cached.email,
        });

        // 3. Jika Sukses Reset -> HAPUS SESI LOKAL (TENDANG USER)
        if (result.success) {
            store.delete('license'); // <--- Ini kuncinya! Paksa logout.
            console.log('[RESET] Sukses reset HWID. Sesi dihapus agar user login ulang.');
        }

        return result;

    } catch (err) {
        return { success: false, error: 'Gagal koneksi: ' + err.message };
    }
});

// --- License: Get cached data ---
ipcMain.handle('license:get-cache', async () => {
    return store.get('license', null);
});

// --- License: Clear (logout) ---
ipcMain.handle('license:clear-cache', async () => {
    store.delete('license');
    return { success: true };
});

// --- License: Get HWID ---
ipcMain.handle('license:get-hwid', async () => {
    return getHWID();
});

// --- Open URL in default browser ---
ipcMain.handle('license:open-url', async (_event, url) => {
    shell.openExternal(url);
    return { success: true };
});

// --- Trial: Query usage counters ---
ipcMain.handle('trial:query-usage', async () => {
    return await queryTrialUsage();
});

// ============================================
// IPC: Renew Listings — Auto Perbarui Tawaran
// ============================================
let renewAbortFlag = false;

function sendRenewProgress(data) {
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('renew:progress', data);
    }
}

// --- Scan: Find items that can be renewed ---
ipcMain.handle('renew:scan-items', async (_event, accountIds) => {
    renewAbortFlag = false;
    const allItems = [];

    try {
        const { chromium } = require('playwright');

        for (let i = 0; i < accountIds.length; i++) {
            if (renewAbortFlag) break;

            const accountId = accountIds[i];
            const accounts = store.get('accounts', []);
            const account = accounts.find(a => a.id === accountId);
            if (!account) continue;
            if (!account.cookiesPath || !fs.existsSync(account.cookiesPath)) {
                sendRenewProgress({ type: 'scan-log', message: `⚠️ ${account.name || account.uid}: Cookies tidak tersedia, skip...` });
                continue;
            }

            sendRenewProgress({ type: 'scan-log', message: `🔍 Scanning akun ${account.name || account.uid} (${i + 1}/${accountIds.length})...` });

            let browser = null;
            try {
                browser = await chromium.launch({
                    headless: true,
                    ...SMART_BROWSER_CONFIG,
                    args: [
                        '--disable-blink-features=AutomationControlled',
                        '--disable-infobars',
                        '--disable-features=IsolateOrigins,site-per-process',
                    ],
                });

                const context = await browser.newContext({
                    viewport: { width: 1280, height: 800 },
                    storageState: account.cookiesPath,
                    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
                });
                const page = await context.newPage();

                // ── Strategy 1: Navigate and capture GraphQL response via event listener ──
                console.log(`[RENEW-SCAN] Strategy 1: Navigate + capture response for ${account.uid}`);
                let capturedNodes = null;

                // Collect ALL GraphQL responses matching our query
                const capturedResponses = [];
                const responseHandler = async (response) => {
                    try {
                        if (!response.url().includes('/api/graphql')) return;
                        if (response.request().method() !== 'POST') return;
                        const postData = response.request().postData() || '';
                        if (!postData.includes('9716444631746484') && !postData.includes('MarketplaceCometRenewMultipleListingsDialogQuery')) return;
                        console.log(`[RENEW-SCAN] Captured GraphQL response for ${account.uid}`);
                        capturedResponses.push(response);
                    } catch (e) {
                        console.error('[RENEW-SCAN] Response handler error:', e.message);
                    }
                };
                page.on('response', responseHandler);

                // Navigate to the renew listings dialog
                try {
                    await page.goto(
                        'https://www.facebook.com/marketplace/selling/renew_listings/?is_routable_dialog=true',
                        { waitUntil: 'domcontentloaded', timeout: 600000 }
                    );
                } catch (navErr) {
                    console.error(`[RENEW-SCAN] Navigation error: ${navErr.message}`);
                }

                // Check if we got redirected to login
                if (isLoginPage(page.url())) {
                    sendRenewProgress({ type: 'scan-log', message: `⚠️ ${account.name || account.uid}: Cookies expired, skip...` });
                    markAccountInvalid(accountId, 'Cookies expired saat scan renew');
                    await browser.close();
                    browser = null;
                    continue;
                }

                // Wait for GraphQL responses to arrive
                await page.waitForTimeout(60000);
                page.off('response', responseHandler);

                console.log(`[RENEW-SCAN] Captured ${capturedResponses.length} GraphQL responses for ${account.uid}`);

                // Parse captured responses
                for (const resp of capturedResponses) {
                    if (capturedNodes) break;
                    try {
                        let text = await resp.text();
                        console.log(`[RENEW-SCAN] Response text length: ${text.length}`);
                        // Facebook may prefix with for(;;); — strip it
                        text = text.replace(/^for\s*\(;;\)\s*;?\s*/, '');

                        // Facebook may return multiple JSON objects concatenated by newlines
                        const jsonParts = text.split('\n').filter(line => line.trim().startsWith('{'));
                        for (const part of jsonParts) {
                            try {
                                const json = JSON.parse(part);
                                const nodes = json?.data?.viewer?.marketplace_renew_eligible_listings?.nodes;
                                if (nodes && Array.isArray(nodes) && nodes.length > 0) {
                                    capturedNodes = nodes;
                                    console.log(`[RENEW-SCAN] Found ${nodes.length} nodes from response interceptor`);
                                    break;
                                }
                                // Also check without viewer
                                const nodes2 = json?.data?.marketplace_renew_eligible_listings?.nodes;
                                if (nodes2 && Array.isArray(nodes2) && nodes2.length > 0) {
                                    capturedNodes = nodes2;
                                    console.log(`[RENEW-SCAN] Found ${nodes2.length} nodes (alt path) from response interceptor`);
                                    break;
                                }
                            } catch { /* individual json part parse error, try next */ }
                        }

                        // If splitting didn't work, try parsing the whole thing
                        if (!capturedNodes) {
                            try {
                                const json = JSON.parse(text);
                                const nodes = json?.data?.viewer?.marketplace_renew_eligible_listings?.nodes
                                    || json?.data?.marketplace_renew_eligible_listings?.nodes
                                    || [];
                                if (nodes.length > 0) {
                                    capturedNodes = nodes;
                                    console.log(`[RENEW-SCAN] Found ${nodes.length} nodes from full parse`);
                                }
                            } catch (e2) {
                                console.error(`[RENEW-SCAN] Full parse failed: ${e2.message}`);
                            }
                        }
                    } catch (parseErr) {
                        console.error(`[RENEW-SCAN] Response parse error: ${parseErr.message}`);
                    }
                }

                // ── Strategy 2: Direct fetch from page context (most reliable) ──
                if (!capturedNodes) {
                    console.log(`[RENEW-SCAN] Strategy 2: Direct fetch from page context for ${account.uid}`);
                    try {
                        const fetchResult = await page.evaluate(async () => {
                            try {
                                // Extract required tokens from the page
                                const dtsgEl = document.querySelector('input[name="fb_dtsg"]');
                                const fb_dtsg = dtsgEl ? dtsgEl.value : '';
                                const userIdMatch = document.cookie.match(/c_user=(\d+)/);
                                const userId = userIdMatch ? userIdMatch[1] : '';
                                const lsdEl = document.querySelector('input[name="lsd"]');
                                const lsd = lsdEl ? lsdEl.value : '';

                                if (!fb_dtsg || !userId) {
                                    return { error: 'Missing fb_dtsg or userId', fb_dtsg: !!fb_dtsg, userId: !!userId };
                                }

                                const params = new URLSearchParams();
                                params.append('av', userId);
                                params.append('__user', userId);
                                params.append('__a', '1');
                                params.append('__req', '99');
                                params.append('dpr', '1');
                                params.append('__ccg', 'EXCELLENT');
                                params.append('__comet_req', '15');
                                params.append('fb_dtsg', fb_dtsg);
                                params.append('lsd', lsd || '');
                                params.append('fb_api_caller_class', 'RelayModern');
                                params.append('fb_api_req_friendly_name', 'MarketplaceCometRenewMultipleListingsDialogQuery');
                                params.append('variables', '{}');
                                params.append('doc_id', '9716444631746484');

                                const resp = await fetch('/api/graphql/', {
                                    method: 'POST',
                                    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                                    body: params.toString(),
                                    credentials: 'include',
                                });

                                let text = await resp.text();
                                text = text.replace(/^for\s*\(;;\)\s*;?\s*/, '');

                                // Try multi-line parse
                                const lines = text.split('\n').filter(l => l.trim().startsWith('{'));
                                for (const line of lines) {
                                    try {
                                        const json = JSON.parse(line);
                                        const nodes = json?.data?.viewer?.marketplace_renew_eligible_listings?.nodes;
                                        if (nodes && nodes.length > 0) {
                                            return { nodes };
                                        }
                                    } catch { }
                                }

                                // Try full parse
                                try {
                                    const json = JSON.parse(text);
                                    const nodes = json?.data?.viewer?.marketplace_renew_eligible_listings?.nodes || [];
                                    return { nodes, raw_keys: Object.keys(json?.data?.viewer || {}) };
                                } catch {
                                    return { error: 'JSON parse failed', textLen: text.length, textPreview: text.substring(0, 500) };
                                }
                            } catch (err) {
                                return { error: err.message };
                            }
                        });

                        console.log(`[RENEW-SCAN] Direct fetch result:`, JSON.stringify(fetchResult).substring(0, 500));

                        if (fetchResult && fetchResult.nodes && fetchResult.nodes.length > 0) {
                            capturedNodes = fetchResult.nodes;
                            console.log(`[RENEW-SCAN] Found ${capturedNodes.length} nodes from direct fetch`);
                        } else if (fetchResult?.error) {
                            console.error(`[RENEW-SCAN] Direct fetch error: ${fetchResult.error}`);
                        }
                    } catch (fetchErr) {
                        console.error(`[RENEW-SCAN] Direct fetch failed: ${fetchErr.message}`);
                    }
                }

                // ── Strategy 3: Parse from page source as last fallback ──
                if (!capturedNodes) {
                    console.log(`[RENEW-SCAN] Strategy 3: Regex from page content for ${account.uid}`);
                    try {
                        const pageContent = await page.content();
                        console.log(`[RENEW-SCAN] Page content length: ${pageContent.length}`);

                        // Use a balanced bracket approach to extract the nodes array
                        const marker = '"marketplace_renew_eligible_listings":{"nodes":';
                        const idx = pageContent.indexOf(marker);
                        if (idx !== -1) {
                            const arrayStart = idx + marker.length;
                            let depth = 0;
                            let arrayEnd = -1;
                            for (let c = arrayStart; c < pageContent.length && c < arrayStart + 50000; c++) {
                                if (pageContent[c] === '[') depth++;
                                else if (pageContent[c] === ']') {
                                    depth--;
                                    if (depth === 0) { arrayEnd = c + 1; break; }
                                }
                            }
                            if (arrayEnd !== -1) {
                                const arrayStr = pageContent.substring(arrayStart, arrayEnd);
                                console.log(`[RENEW-SCAN] Extracted array string length: ${arrayStr.length}`);
                                try {
                                    capturedNodes = JSON.parse(arrayStr);
                                    console.log(`[RENEW-SCAN] Found ${capturedNodes.length} nodes from page content`);
                                } catch (e) {
                                    console.error(`[RENEW-SCAN] Array parse failed: ${e.message}`);
                                }
                            }
                        } else {
                            console.log(`[RENEW-SCAN] Marker not found in page content`);
                        }
                    } catch (e) {
                        console.error(`[RENEW-SCAN] Page content strategy failed: ${e.message}`);
                    }
                }

                // ── Map nodes to items ──
                let items = [];
                if (capturedNodes && capturedNodes.length > 0) {
                    items = capturedNodes.map(node => ({
                        id: node.cso?.id || node.id,
                        title: node.marketplace_listing_title || 'Tanpa Judul',
                        price: node.listing_price?.formatted_amount || '-',
                        photo: node.primary_listing_photo?.image?.uri || null,
                        accountId: account.id,
                        accountName: account.name || account.uid,
                    })).filter(item => item.id);
                    console.log(`[RENEW-SCAN] Final items count: ${items.length}`);
                }

                if (items.length > 0) {
                    allItems.push(...items);
                    sendRenewProgress({ type: 'scan-result', items });
                    sendRenewProgress({ type: 'scan-log', message: `✅ ${account.name || account.uid}: Ditemukan ${items.length} produk siap perbarui` });
                } else {
                    sendRenewProgress({ type: 'scan-log', message: `ℹ️ ${account.name || account.uid}: Tidak ada produk yang bisa diperbarui` });
                }

                await browser.close();
                browser = null;

                // Delay between accounts
                if (i < accountIds.length - 1) {
                    await new Promise(r => setTimeout(r, 2000));
                }

            } catch (err) {
                console.error(`[RENEW] Scan error for ${account?.uid}:`, err.message);
                sendRenewProgress({ type: 'scan-log', message: `❌ ${account?.name || account?.uid}: Error — ${err.message}` });
                if (browser) { try { await browser.close(); } catch { } browser = null; }
            }
        }

    } catch (err) {
        console.error('[RENEW] Scan flow error:', err.message);
    }

    sendRenewProgress({ type: 'scan-done', totalItems: allItems.length });
    return { success: true, items: allItems };
});

// --- Execute: Renew/bump selected items ---
ipcMain.handle('renew:execute-items', async (_event, payload) => {
    renewAbortFlag = false;
    const { items, delayMin = 3, delayMax = 7 } = payload;

    // Group items by accountId
    const grouped = {};
    for (const item of items) {
        if (!grouped[item.accountId]) grouped[item.accountId] = [];
        grouped[item.accountId].push(item);
    }

    try {
        const { chromium } = require('playwright');

        for (const [accountId, accountItems] of Object.entries(grouped)) {
            if (renewAbortFlag) break;

            const accounts = store.get('accounts', []);
            const account = accounts.find(a => a.id === accountId);
            if (!account || !account.cookiesPath || !fs.existsSync(account.cookiesPath)) {
                // Mark all items for this account as failed
                for (const item of accountItems) {
                    sendRenewProgress({ type: 'renew-update', itemId: item.id, status: 'failed', message: 'Cookies tidak tersedia' });
                }
                continue;
            }

            let browser = null;
            try {
                browser = await chromium.launch({
                    headless: true,
                    ...SMART_BROWSER_CONFIG,
                    args: [
                        '--disable-blink-features=AutomationControlled',
                        '--disable-infobars',
                        '--disable-features=IsolateOrigins,site-per-process',
                    ],
                });

                const context = await browser.newContext({
                    viewport: { width: 1280, height: 800 },
                    storageState: account.cookiesPath,
                    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
                });
                const page = await context.newPage();

                // Navigate to Facebook to extract tokens
                await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
                await page.waitForTimeout(3000);

                // Check login
                if (isLoginPage(page.url())) {
                    markAccountInvalid(accountId, 'Cookies expired saat eksekusi renew');
                    for (const item of accountItems) {
                        sendRenewProgress({ type: 'renew-update', itemId: item.id, status: 'failed', message: 'Cookies expired' });
                    }
                    await browser.close();
                    browser = null;
                    continue;
                }

                // Extract fb_dtsg and actor_id
                const tokens = await page.evaluate(() => {
                    let fbDtsg = null;
                    let actorId = null;

                    // fb_dtsg
                    if (window.DTSGInitData && window.DTSGInitData.token) fbDtsg = window.DTSGInitData.token;
                    if (!fbDtsg) {
                        try { if (typeof require === 'function') { const m = require('DTSGInitData'); if (m && m.token) fbDtsg = m.token; } } catch { }
                    }
                    if (!fbDtsg) {
                        const input = document.querySelector('input[name="fb_dtsg"]');
                        if (input) fbDtsg = input.value;
                    }
                    if (!fbDtsg) {
                        const html = document.documentElement.innerHTML;
                        const m1 = html.match(/"DTSGInitData".*?"token":"([^"]+)"/);
                        if (m1) fbDtsg = m1[1];
                        if (!fbDtsg) {
                            const m2 = html.match(/fb_dtsg.*?value="([^"]+)"/);
                            if (m2) fbDtsg = m2[1];
                        }
                    }

                    // actor_id / user_id
                    try {
                        const html = document.documentElement.innerHTML;
                        const uidMatch = html.match(/"USER_ID":"(\d+)"/) || html.match(/"actorID":"(\d+)"/) || html.match(/"userID":"(\d+)"/);
                        if (uidMatch) actorId = uidMatch[1];
                    } catch { }

                    if (!actorId) {
                        try {
                            const cookies = document.cookie;
                            const cUser = cookies.match(/c_user=(\d+)/);
                            if (cUser) actorId = cUser[1];
                        } catch { }
                    }

                    return { fbDtsg, actorId };
                });

                if (!tokens.fbDtsg || !tokens.actorId) {
                    for (const item of accountItems) {
                        sendRenewProgress({ type: 'renew-update', itemId: item.id, status: 'failed', message: 'Gagal ekstrak token' });
                    }
                    await browser.close();
                    browser = null;
                    continue;
                }

                console.log(`[RENEW] Tokens OK for ${account.uid}: dtsg=${tokens.fbDtsg.substring(0, 15)}... actor=${tokens.actorId}`);

                // Create API request context
                const apiContext = await (require('playwright')).request.newContext({
                    storageState: account.cookiesPath,
                    extraHTTPHeaders: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
                        'Accept-Language': 'en-US,en;q=0.9',
                        'Origin': 'https://www.facebook.com',
                        'Referer': 'https://www.facebook.com/marketplace/selling/',
                        'Sec-Fetch-Site': 'same-origin',
                        'Sec-Fetch-Mode': 'cors',
                        'Sec-Fetch-Dest': 'empty',
                        'Content-Type': 'application/x-www-form-urlencoded',
                    },
                });

                // Loop through items
                for (let j = 0; j < accountItems.length; j++) {
                    if (renewAbortFlag) {
                        // Mark remaining items as failed
                        for (let k = j; k < accountItems.length; k++) {
                            sendRenewProgress({ type: 'renew-update', itemId: accountItems[k].id, status: 'failed', message: 'Dihentikan oleh user' });
                        }
                        break;
                    }

                    const item = accountItems[j];
                    sendRenewProgress({ type: 'renew-update', itemId: item.id, status: 'processing', message: 'Memproses...' });

                    try {
                        const variables = JSON.stringify({
                            input: {
                                client_mutation_id: String(j + 1),
                                actor_id: tokens.actorId,
                                for_sale_item_id: item.id,
                                referral_surface: null,
                                surface: 'MARKETPLACE_RENEW_LISTINGS',
                            },
                        });

                        const response = await apiContext.post('https://www.facebook.com/api/graphql/', {
                            form: {
                                av: tokens.actorId,
                                __user: tokens.actorId,
                                fb_dtsg: tokens.fbDtsg,
                                doc_id: '8389763077815607',
                                variables: variables,
                            },
                            timeout: 15000,
                        });

                        const status = response.status();
                        if (status === 200) {
                            let resText = await response.text();
                            resText = resText.replace(/^for \(;;\);/, '');
                            try {
                                const resJson = JSON.parse(resText);
                                if (resJson.errors && resJson.errors.length > 0) {
                                    const errMsg = resJson.errors[0]?.message || 'Unknown error';
                                    sendRenewProgress({ type: 'renew-update', itemId: item.id, status: 'failed', message: errMsg });
                                } else {
                                    sendRenewProgress({ type: 'renew-update', itemId: item.id, status: 'success', message: '✅ Berhasil diperbarui' });
                                }
                            } catch {
                                // If we can't parse but status is 200, assume success
                                sendRenewProgress({ type: 'renew-update', itemId: item.id, status: 'success', message: '✅ Berhasil diperbarui' });
                            }
                        } else {
                            sendRenewProgress({ type: 'renew-update', itemId: item.id, status: 'failed', message: `HTTP ${status}` });
                        }

                    } catch (err) {
                        console.error(`[RENEW] Execute error for item ${item.id}:`, err.message);
                        sendRenewProgress({ type: 'renew-update', itemId: item.id, status: 'failed', message: err.message });
                    }

                    // Random delay between items (within same account)
                    if (j < accountItems.length - 1 && !renewAbortFlag) {
                        const delay = (delayMin + Math.random() * (delayMax - delayMin)) * 1000;
                        await new Promise(r => setTimeout(r, delay));
                    }
                }

                // Cleanup
                try { await apiContext.dispose(); } catch { }
                await browser.close();
                browser = null;

                // Delay between accounts
                if (!renewAbortFlag) {
                    await new Promise(r => setTimeout(r, 3000));
                }

            } catch (err) {
                console.error(`[RENEW] Account execute error for ${account?.uid}:`, err.message);
                for (const item of accountItems) {
                    if (!renewAbortFlag) {
                        sendRenewProgress({ type: 'renew-update', itemId: item.id, status: 'failed', message: err.message });
                    }
                }
                if (browser) { try { await browser.close(); } catch { } browser = null; }
            }
        }

    } catch (err) {
        console.error('[RENEW] Execute flow error:', err.message);
    }

    sendRenewProgress({ type: 'renew-done' });
    return { success: true };
});

// --- Stop: Abort renew process ---
ipcMain.handle('renew:stop', async () => {
    renewAbortFlag = true;
    return { success: true };
});

// ============================================
// HAPUS & TAWARKAN ULANG (DELETE & RELIST)
// ============================================
let relistAbortFlag = false;
function sendRelistProgress(data) {
    const wins = BrowserWindow.getAllWindows();
    wins.forEach(w => w.webContents.send('relist:progress', data));
}

// --- Scan: Find items ready to relist ---
ipcMain.handle('relist:scan-items', async (_event, accountIds) => {
    relistAbortFlag = false;
    let allItems = [];

    try {
        const { chromium } = require('playwright');
        const accounts = store.get('accounts', []);

        for (let i = 0; i < accountIds.length; i++) {
            if (relistAbortFlag) break;
            const accountId = accountIds[i];
            const account = accounts.find(a => a.id === accountId);

            if (!account || !account.cookiesPath || !fs.existsSync(account.cookiesPath)) {
                sendRelistProgress({ type: 'scan-log', message: `❌ ${account?.name || account?.uid || accountId}: Cookies tidak ditemukan` });
                continue;
            }

            sendRelistProgress({ type: 'scan-log', message: `⏳ ${account.name || account.uid}: Membuka browser...` });

            let browser = null;
            try {
                browser = await chromium.launch({
                    headless: true,
                    ...SMART_BROWSER_CONFIG,
                    args: ['--disable-blink-features=AutomationControlled']
                });

                const context = await browser.newContext({
                    viewport: { width: 1280, height: 800 },
                    storageState: account.cookiesPath,
                    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
                });

                const page = await context.newPage();

                let capturedNodesSold = [];
                let capturedNodesActive = [];

                // ── Strategy 1: Intercept Response ──
                const responseHandler = async (response) => {
                    if (relistAbortFlag) return;
                    if (response.url().includes('/api/graphql/')) {
                        try {
                            const req = response.request();
                            if (req.method() === 'POST') {
                                const postData = req.postData() || '';
                                if (postData.includes('MarketplaceCometRelistMultipleItemsDialogQuery')) {
                                    const text = await response.text();
                                    const cleanText = text.replace(/^for\s*\(;;\)\s*;?\s*/, '');

                                    const jsonParts = cleanText.split('\n').filter(l => l.trim().startsWith('{'));
                                    for (const part of jsonParts) {
                                        try {
                                            const body = JSON.parse(part);
                                            const sold = body?.data?.viewer?.marketplace_sold_relistable_listings?.nodes;
                                            const active = body?.data?.viewer?.marketplace_active_relistable_listings?.nodes;

                                            if (sold && sold.length > 0) capturedNodesSold.push(...sold);
                                            if (active && active.length > 0) capturedNodesActive.push(...active);
                                        } catch { }
                                    }
                                }
                            }
                        } catch { }
                    }
                };
                page.on('response', responseHandler);

                sendRelistProgress({ type: 'scan-log', message: `🔍 ${account.name || account.uid}: Mengambil data relist...` });

                const targetUrl = 'https://www.facebook.com/marketplace/selling/relist_items/?is_routable_dialog=true&show_only_delete_and_relist=true';
                await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });

                await page.waitForTimeout(8000);
                page.off('response', responseHandler);

                if (isLoginPage(page.url())) {
                    sendRelistProgress({ type: 'scan-log', message: `❌ ${account.name || account.uid}: Sesi expired (Login required)` });
                    markAccountInvalid(accountId, 'Cookies expired saat scan relist');
                    await browser.close();
                    continue;
                }

                if (capturedNodesSold.length === 0 && capturedNodesActive.length === 0) {
                    console.log(`[RELIST-SCAN] Strategy 1 found no nodes, trying Strategy 2`);
                    // ── Strategy 2: Direct Fetch ──
                    const fetchResult = await page.evaluate(async () => {
                        try {
                            let fb_dtsg = null;
                            if (window.DTSGInitData && window.DTSGInitData.token) fb_dtsg = window.DTSGInitData.token;
                            if (!fb_dtsg) {
                                try { if (typeof require === 'function') { const m = require('DTSGInitData'); if (m && m.token) fb_dtsg = m.token; } } catch { }
                            }
                            if (!fb_dtsg) {
                                const match = document.documentElement.innerHTML.match(/"DTSGInitData".*?"token":"([^"]+)"/);
                                if (match) fb_dtsg = match[1];
                            }
                            let userId = null;
                            const cookies = document.cookie;
                            const cUser = cookies.match(/c_user=(\d+)/);
                            if (cUser) userId = cUser[1];

                            if (!fb_dtsg || !userId) return { error: 'Missing tokens' };

                            const html = document.documentElement.innerHTML;
                            const lsdMatch = html.match(/"LSD",\[\],{"token":"([^"]+)"}/);
                            const lsd = lsdMatch ? lsdMatch[1] : '';

                            const params = new URLSearchParams();
                            params.append('av', userId);
                            params.append('__user', userId);
                            params.append('__a', '1');
                            params.append('__req', '99');
                            params.append('dpr', '1');
                            params.append('__ccg', 'EXCELLENT');
                            params.append('__comet_req', '15');
                            params.append('fb_dtsg', fb_dtsg);
                            params.append('lsd', lsd || '');
                            params.append('fb_api_caller_class', 'RelayModern');
                            params.append('fb_api_req_friendly_name', 'MarketplaceCometRelistMultipleItemsDialogQuery');
                            params.append('variables', '{}');
                            params.append('doc_id', '23938419359083764');

                            const resp = await fetch('/api/graphql/', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                                body: params.toString(),
                                credentials: 'include',
                            });

                            let text = await resp.text();
                            text = text.replace(/^for\s*\(;;\)\s*;?\s*/, '');

                            let sold = [];
                            let active = [];

                            const lines = text.split('\n').filter(l => l.trim().startsWith('{'));
                            for (const line of lines) {
                                try {
                                    const json = JSON.parse(line);
                                    const s = json?.data?.viewer?.marketplace_sold_relistable_listings?.nodes;
                                    const a = json?.data?.viewer?.marketplace_active_relistable_listings?.nodes;
                                    if (s && s.length > 0) sold.push(...s);
                                    if (a && a.length > 0) active.push(...a);
                                } catch { }
                            }

                            if (sold.length === 0 && active.length === 0) {
                                try {
                                    const json = JSON.parse(text);
                                    const s = json?.data?.viewer?.marketplace_sold_relistable_listings?.nodes;
                                    const a = json?.data?.viewer?.marketplace_active_relistable_listings?.nodes;
                                    if (s && s.length > 0) sold.push(...s);
                                    if (a && a.length > 0) active.push(...a);
                                } catch { }
                            }

                            return { sold, active };
                        } catch (e) {
                            return { error: e.message };
                        }
                    });

                    if (fetchResult && fetchResult.sold) {
                        capturedNodesSold = fetchResult.sold;
                        capturedNodesActive = fetchResult.active || [];
                    }
                }

                // ── Formatting Output ──
                let itemsMap = new Map();

                const processNodes = (nodes) => {
                    for (const node of nodes) {
                        const itemData = node.canonical_listing || node;
                        if (!itemData.id) continue;
                        if (!itemsMap.has(itemData.id)) {
                            itemsMap.set(itemData.id, {
                                id: itemData.id,
                                title: itemData.marketplace_listing_title || 'Tanpa Judul',
                                price: itemData.listing_price?.formatted_amount || '-',
                                photo: itemData.primary_listing_photo?.image?.uri || null,
                                accountId: account.id,
                                accountName: account.name || account.uid,
                            });
                        }
                    }
                };

                // The logic below ensures that each unique real item ID appears. 
                // We show all items, both sold out and active relistables.
                processNodes(capturedNodesSold);
                processNodes(capturedNodesActive);

                let items = Array.from(itemsMap.values());

                if (items.length > 0) {
                    allItems.push(...items);
                    sendRelistProgress({ type: 'scan-result', items });
                    sendRelistProgress({ type: 'scan-log', message: `✅ ${account.name || account.uid}: Ditemukan ${items.length} produk siap relist` });
                } else {
                    sendRelistProgress({ type: 'scan-log', message: `ℹ️ ${account.name || account.uid}: Tidak ada produk yang bisa direlist` });
                }

                await browser.close();
                browser = null;

                if (i < accountIds.length - 1) {
                    await new Promise(r => setTimeout(r, 2000));
                }

            } catch (err) {
                console.error(`[RELIST] Scan error for ${account?.uid}:`, err.message);
                sendRelistProgress({ type: 'scan-log', message: `❌ ${account?.name || account?.uid}: Error — ${err.message}` });
                if (browser) { try { await browser.close(); } catch { } browser = null; }
            }
        }
    } catch (err) {
        console.error('[RELIST] Scan flow error:', err.message);
    }

    sendRelistProgress({ type: 'scan-done', totalItems: allItems.length });
    return { success: true, items: allItems };
});

// --- Execute: Relist Items (mirrored from renew:execute-items) ---
ipcMain.handle('relist:execute-items', async (_event, payload) => {
    relistAbortFlag = false;
    const { items, delayMin = 3, delayMax = 7 } = payload;

    // Group items by account
    const accountsGroup = {};
    for (const item of items) {
        if (!accountsGroup[item.accountId]) {
            accountsGroup[item.accountId] = { accountId: item.accountId, items: [] };
        }
        accountsGroup[item.accountId].items.push(item);
    }

    try {
        const { chromium } = require('playwright');
        const storeAccounts = store.get('accounts', []);

        for (const accountId of Object.keys(accountsGroup)) {
            if (relistAbortFlag) break;

            const group = accountsGroup[accountId];
            const account = storeAccounts.find(a => a.id === accountId);
            const accountItems = group.items;

            if (!account || !account.cookiesPath || !fs.existsSync(account.cookiesPath)) {
                for (const item of accountItems) {
                    sendRelistProgress({ type: 'relist-update', itemId: item.id, status: 'failed', message: 'Cookies tidak ditemukan' });
                }
                continue;
            }

            let browser = null;
            try {
                browser = await chromium.launch({
                    headless: true,
                    ...SMART_BROWSER_CONFIG,
                    args: ['--disable-blink-features=AutomationControlled']
                });

                const context = await browser.newContext({
                    viewport: { width: 1280, height: 800 },
                    storageState: account.cookiesPath,
                    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
                });

                const page = await context.newPage();
                sendRelistProgress({ type: 'scan-log', message: `🚀 ${account.name || account.uid}: Memulai Eksekusi Relist...` });

                // Navigate to marketplace to get tokens
                await page.goto('https://www.facebook.com/marketplace/selling/', { waitUntil: 'domcontentloaded', timeout: 45000 });

                if (isLoginPage(page.url())) {
                    markAccountInvalid(accountId, 'Cookies expired saat eksekusi relist');
                    for (const item of accountItems) {
                        sendRelistProgress({ type: 'relist-update', itemId: item.id, status: 'failed', message: 'Sesi expired (Login required)' });
                    }
                    await browser.close();
                    browser = null;
                    continue;
                }

                // Extract fb_dtsg, actor_id, jazoest, lsd — same approach as renew + extras from capture
                const tokens = await page.evaluate(() => {
                    let fbDtsg = null;
                    let actorId = null;

                    // fb_dtsg
                    if (window.DTSGInitData && window.DTSGInitData.token) fbDtsg = window.DTSGInitData.token;
                    if (!fbDtsg) {
                        try { if (typeof require === 'function') { const m = require('DTSGInitData'); if (m && m.token) fbDtsg = m.token; } } catch { }
                    }
                    if (!fbDtsg) {
                        const input = document.querySelector('input[name="fb_dtsg"]');
                        if (input) fbDtsg = input.value;
                    }
                    if (!fbDtsg) {
                        const html = document.documentElement.innerHTML;
                        const m1 = html.match(/"DTSGInitData".*?"token":"([^"]+)"/);
                        if (m1) fbDtsg = m1[1];
                        if (!fbDtsg) {
                            const m2 = html.match(/fb_dtsg.*?value="([^"]+)"/);
                            if (m2) fbDtsg = m2[1];
                        }
                    }

                    // actor_id / user_id
                    try {
                        const html = document.documentElement.innerHTML;
                        const uidMatch = html.match(/"USER_ID":"(\d+)"/) || html.match(/"actorID":"(\d+)"/) || html.match(/"userID":"(\d+)"/);
                        if (uidMatch) actorId = uidMatch[1];
                    } catch { }

                    if (!actorId) {
                        try {
                            const cookies = document.cookie;
                            const cUser = cookies.match(/c_user=(\d+)/);
                            if (cUser) actorId = cUser[1];
                        } catch { }
                    }

                    // jazoest
                    let jazoest = '';
                    const jNode = document.querySelector('input[name="jazoest"]');
                    if (jNode) jazoest = jNode.value;
                    if (!jazoest && fbDtsg) {
                        let calc = 0;
                        for (let i = 0; i < fbDtsg.length; i++) calc += fbDtsg.charCodeAt(i);
                        jazoest = '2' + calc;
                    }

                    // lsd
                    let lsd = '';
                    try {
                        const html = document.documentElement.innerHTML;
                        const lsdMatch = html.match(/"LSD",\[\],{"token":"([^"]+)"}/);
                        if (lsdMatch) lsd = lsdMatch[1];
                    } catch { }

                    return { fbDtsg, actorId, jazoest, lsd };
                });

                if (!tokens.fbDtsg || !tokens.actorId) {
                    for (const item of accountItems) {
                        sendRelistProgress({ type: 'relist-update', itemId: item.id, status: 'failed', message: 'Gagal ekstrak token' });
                    }
                    await browser.close();
                    browser = null;
                    continue;
                }

                console.log(`[RELIST] Tokens OK for ${account.uid}: dtsg=${tokens.fbDtsg.substring(0, 15)}... actor=${tokens.actorId} jazoest=${tokens.jazoest}`);

                // Create API request context — same as renew
                const apiContext = await (require('playwright')).request.newContext({
                    storageState: account.cookiesPath,
                    extraHTTPHeaders: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
                        'Accept-Language': 'en-US,en;q=0.9',
                        'Origin': 'https://www.facebook.com',
                        'Referer': 'https://www.facebook.com/marketplace/selling/relist_items/?is_routable_dialog=true&show_only_delete_and_relist=true',
                        'Sec-Fetch-Site': 'same-origin',
                        'Sec-Fetch-Mode': 'cors',
                        'Sec-Fetch-Dest': 'empty',
                        'Content-Type': 'application/x-www-form-urlencoded',
                    },
                });

                // Loop through items
                for (let j = 0; j < accountItems.length; j++) {
                    if (relistAbortFlag) {
                        for (let k = j; k < accountItems.length; k++) {
                            sendRelistProgress({ type: 'relist-update', itemId: accountItems[k].id, status: 'failed', message: 'Dihentikan oleh user' });
                        }
                        break;
                    }

                    const item = accountItems[j];
                    sendRelistProgress({ type: 'relist-update', itemId: item.id, status: 'processing', message: `Relist listing_id=${item.id}...` });
                    console.log(`[RELIST] Executing item: id=${item.id}, type=${typeof item.id}`);

                    try {
                        const variables = JSON.stringify({
                            input: {
                                client_mutation_id: String(j + 1),
                                actor_id: tokens.actorId,
                                listing_id: String(item.id),
                            },
                        });

                        // Build URL with query params matching network capture
                        const queryParams = new URLSearchParams({
                            fb_dtsg: tokens.fbDtsg,
                            jazoest: tokens.jazoest,
                            lsd: tokens.lsd || '',
                        });
                        const apiUrl = `https://www.facebook.com/api/graphql/?${queryParams.toString()}`;

                        const response = await apiContext.post(apiUrl, {
                            form: {
                                fb_dtsg: tokens.fbDtsg,
                                jazoest: tokens.jazoest,
                                lsd: tokens.lsd || '',
                                av: tokens.actorId,
                                __user: tokens.actorId,
                                __a: '1',
                                __comet_req: '15',
                                __crn: 'comet.fbweb.MarketplaceRelistMultipleItemsDialogRoute',
                                fb_api_caller_class: 'RelayModern',
                                fb_api_req_friendly_name: 'useMarketplaceRelistAndDeleteMutation',
                                server_timestamps: 'true',
                                doc_id: '24184720494448136',
                                variables: variables,
                            },
                            timeout: 20000,
                        });

                        const status = response.status();
                        let resText = await response.text();
                        resText = resText.replace(/^for \(;;\);/, '');
                        console.log(`[RELIST] Response status=${status}, body=${resText.substring(0, 300)}`);

                        if (status === 200) {
                            try {
                                const resJson = JSON.parse(resText);
                                if (resJson.errors && resJson.errors.length > 0) {
                                    const errMsg = resJson.errors[0]?.message || 'Unknown error';
                                    const errCode = resJson.errors[0]?.code || '';
                                    console.log(`[RELIST] GraphQL error: code=${errCode}, msg=${errMsg}, full=${JSON.stringify(resJson.errors[0])}`);
                                    sendRelistProgress({ type: 'relist-update', itemId: item.id, status: 'failed', message: `${errMsg} [listing_id=${item.id}]` });
                                } else {
                                    sendRelistProgress({ type: 'relist-update', itemId: item.id, status: 'success', message: '✅ Berhasil direlist' });
                                }
                            } catch {
                                sendRelistProgress({ type: 'relist-update', itemId: item.id, status: 'success', message: '✅ Berhasil direlist' });
                            }
                        } else {
                            sendRelistProgress({ type: 'relist-update', itemId: item.id, status: 'failed', message: `HTTP ${status}` });
                        }

                    } catch (err) {
                        console.error(`[RELIST] Execute error for item ${item.id}:`, err.message);
                        sendRelistProgress({ type: 'relist-update', itemId: item.id, status: 'failed', message: err.message });
                    }

                    // Random delay between items (within same account)
                    if (j < accountItems.length - 1 && !relistAbortFlag) {
                        const delay = (delayMin + Math.random() * (delayMax - delayMin)) * 1000;
                        await new Promise(r => setTimeout(r, delay));
                    }
                }

                // Cleanup
                try { await apiContext.dispose(); } catch { }
                await browser.close();
                browser = null;

                // Delay between accounts
                if (!relistAbortFlag) {
                    await new Promise(r => setTimeout(r, 3000));
                }

            } catch (err) {
                console.error(`[RELIST] Account execute error for ${account?.uid}:`, err.message);
                for (const item of accountItems) {
                    if (!relistAbortFlag) {
                        sendRelistProgress({ type: 'relist-update', itemId: item.id, status: 'failed', message: err.message });
                    }
                }
                if (browser) { try { await browser.close(); } catch { } browser = null; }
            }
        }

    } catch (err) {
        console.error('[RELIST] Execute flow error:', err.message);
    }

    sendRelistProgress({ type: 'relist-done' });
    return { success: true };
});

ipcMain.handle('relist:stop', async () => {
    relistAbortFlag = true;
    return { success: true };
});

// ════════════════════════════════════════════════════════════════
// DELETE VIOLATING ITEMS (Hapus Produk Melanggar)
// ════════════════════════════════════════════════════════════════
let deleteViolatingAbortFlag = false;

function sendDeleteViolatingProgress(data) {
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('delete-violating:progress', data);
    }
}

// --- Scan: Violating Items ---
ipcMain.handle('delete-violating:scan-items', async (_event, accountIds) => {
    deleteViolatingAbortFlag = false;
    const accounts = store.get('accounts', []);
    const selectedAccounts = accounts.filter(a => accountIds.includes(a.id) && a.status === 'ACTIVE');
    let allItems = [];

    // Helper: extract a single violating listing item
    function makeViolatingItem(listing, account) {
        if (!listing || !listing.id) return null;
        if (listing.listing_is_rejected !== true) return null;
        return {
            id: listing.id,
            title: listing.marketplace_listing_title || listing.base_marketplace_listing_title || 'Tanpa Judul',
            price: listing.listing_price?.formatted_amount || listing.formatted_price?.text || '-',
            photo: listing.primary_listing_photo?.image?.uri || null,
            violationMessage: listing.integrity_status_indicator?.content || listing.listing_status_indicator?.content || 'Melanggar kebijakan',
            accountId: account.id,
            accountName: account.name || account.uid,
        };
    }

    // Helper: extract violating items from edges array
    function extractFromEdges(edges, account) {
        const found = [];
        if (!edges || !Array.isArray(edges)) return found;
        for (const edge of edges) {
            // Structure 1: edge.node.first_listing (inactive_listing_sets)
            const listing1 = edge?.node?.first_listing;
            if (listing1) {
                const item = makeViolatingItem(listing1, account);
                if (item) found.push(item);
            }
            // Structure 2: edge.node directly IS the listing (active_listing_sets / for_sale_items)
            const listing2 = edge?.node;
            if (listing2 && listing2.id && !listing1) {
                const item = makeViolatingItem(listing2, account);
                if (item) found.push(item);
            }
        }
        return found;
    }

    // Helper: extract violating items from any JSON response — search ALL data paths
    function extractViolatingItems(json, account) {
        const found = [];
        const viewer = json?.data?.viewer;
        if (!viewer) return found;

        // Search all known listing containers
        const containers = [
            viewer.inactive_listing_sets,
            viewer.active_listing_sets,
            viewer.for_sale_items,
            viewer.marketplace_selling_items,
            viewer.items,
        ];
        for (const container of containers) {
            if (container?.edges) {
                found.push(...extractFromEdges(container.edges, account));
            }
            if (container?.nodes) {
                for (const node of container.nodes) {
                    const item = makeViolatingItem(node, account);
                    if (item) found.push(item);
                    // Also check node.first_listing
                    if (node?.first_listing) {
                        const item2 = makeViolatingItem(node.first_listing, account);
                        if (item2) found.push(item2);
                    }
                }
            }
        }

        // Deep recursive search: find ANY object with listing_is_rejected === true
        if (found.length === 0) {
            function deepSearch(obj, depth) {
                if (!obj || typeof obj !== 'object' || depth > 6) return;
                if (obj.listing_is_rejected === true && obj.id) {
                    const item = makeViolatingItem(obj, account);
                    if (item) found.push(item);
                    return;
                }
                if (Array.isArray(obj)) {
                    for (const el of obj) deepSearch(el, depth + 1);
                } else {
                    for (const key of Object.keys(obj)) {
                        deepSearch(obj[key], depth + 1);
                    }
                }
            }
            deepSearch(json?.data, 0);
        }

        return found;
    }

    for (const account of selectedAccounts) {
        if (deleteViolatingAbortFlag) break;

        if (!account.cookiesPath || !fs.existsSync(account.cookiesPath)) {
            sendDeleteViolatingProgress({ type: 'scan-log', message: `⚠️ ${account.name || account.uid}: Cookies tidak ditemukan` });
            continue;
        }

        sendDeleteViolatingProgress({ type: 'scan-log', message: `🔍 ${account.name || account.uid}: Scanning produk melanggar...` });

        let browser = null;
        try {
            const { chromium } = require('playwright');
            browser = await createStealthBrowser(true);
            const context = await createStealthContext(browser, account.cookiesPath);

            const page = await context.newPage();

            // ═══════════════════════════════════════════════════════════
            // METODE 1: Intercept GraphQL responses for inactive listings
            // Filter by doc_id or query name to only capture relevant data
            // ═══════════════════════════════════════════════════════════
            const capturedTexts = [];
            const responseHandler = async (response) => {
                try {
                    const url = response.url();
                    if (!url.includes('graphql')) return;

                    // Check postData for the specific query
                    const postData = response.request().postData() || '';
                    const isInactiveQuery = postData.includes('26251615647796305') ||
                        postData.includes('MarketplaceYouSellingFast') ||
                        postData.includes('InactiveSection');

                    if (!isInactiveQuery) return;

                    const text = await response.text();
                    if (text && text.length > 200) {
                        capturedTexts.push(text);
                        console.log('[DELETE-VIOLATING] Captured inactive section response, length:', text.length);
                    }
                } catch { }
            };
            page.on('response', responseHandler);

            // Navigate to selling page
            const targetUrl = 'https://www.facebook.com/marketplace/you/selling?referral_surface=seller_hub';
            sendDeleteViolatingProgress({ type: 'scan-log', message: `🔍 ${account.name || account.uid}: Membuka halaman selling...` });
            try {
                await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
            } catch (navErr) {
                console.error(`[DELETE-VIOLATING] Nav error: ${navErr.message}`);
            }

            if (isLoginPage(page.url())) {
                sendDeleteViolatingProgress({ type: 'scan-log', message: `❌ ${account.name || account.uid}: Login required` });
                markAccountInvalid(account.id, 'Cookies expired saat scan delete-violating');
                await browser.close();
                browser = null;
                continue;
            }

            // Wait for initial data
            await page.waitForTimeout(8000);
            sendDeleteViolatingProgress({ type: 'scan-log', message: `🔍 ${account.name || account.uid}: ${capturedTexts.length} responses, scrolling...` });

            // Scroll to trigger pagination and load more inactive items
            let noNewStreak = 0;
            for (let s = 0; s < 20; s++) {
                if (deleteViolatingAbortFlag) break;
                const prev = capturedTexts.length;
                await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
                await page.waitForTimeout(2000);
                if (capturedTexts.length > prev) {
                    noNewStreak = 0;
                    sendDeleteViolatingProgress({ type: 'scan-log', message: `🔍 ${account.name || account.uid}: Scroll ${s + 1}, ${capturedTexts.length} responses...` });
                } else {
                    noNewStreak++;
                    if (noNewStreak >= 3) break;
                }
            }
            await page.waitForTimeout(2000);
            page.off('response', responseHandler);

            sendDeleteViolatingProgress({ type: 'scan-log', message: `🔍 ${account.name || account.uid}: Parsing ${capturedTexts.length} responses...` });

            // Parse captured GraphQL responses
            let capturedItems = [];

            for (const rawText of capturedTexts) {
                try {
                    // Strip Facebook's anti-JSON prefix
                    let text = rawText;
                    if (text.startsWith('for')) {
                        text = text.replace(/^for\s*\(;;\)\s*;?\s*/, '');
                    }

                    // Facebook sends multiple JSON objects on one line separated by space
                    // Use brace-depth counting to split them
                    let pos = 0;
                    while (pos < text.length) {
                        // Find start of next JSON object
                        while (pos < text.length && text[pos] !== '{') pos++;
                        if (pos >= text.length) break;

                        // Count braces to find end of this JSON object
                        let depth = 0;
                        let inStr = false;
                        let esc = false;
                        let endIdx = -1;
                        for (let ci = pos; ci < text.length; ci++) {
                            const ch = text[ci];
                            if (esc) { esc = false; continue; }
                            if (ch === '\\') { esc = true; continue; }
                            if (ch === '"') { inStr = !inStr; continue; }
                            if (inStr) continue;
                            if (ch === '{') depth++;
                            else if (ch === '}') {
                                depth--;
                                if (depth === 0) { endIdx = ci; break; }
                            }
                        }

                        if (endIdx <= pos) break;

                        const jsonStr = text.substring(pos, endIdx + 1);
                        pos = endIdx + 1;

                        try {
                            const json = JSON.parse(jsonStr);
                            // Extract items using the structured path
                            const edges = json?.data?.viewer?.inactive_listing_sets?.edges;
                            if (edges && Array.isArray(edges)) {
                                for (const edge of edges) {
                                    const listing = edge?.node?.first_listing;
                                    if (listing && listing.listing_is_rejected === true) {
                                        if (!capturedItems.find(item => item.id === listing.id)) {
                                            capturedItems.push({
                                                id: listing.id,
                                                title: listing.marketplace_listing_title || listing.base_marketplace_listing_title || 'Tanpa Judul',
                                                price: listing.listing_price?.formatted_amount || listing.formatted_price?.text || '-',
                                                photo: listing.primary_listing_photo?.image?.uri?.replace(/\\\//g, '/') || null,
                                                violationMessage: listing.integrity_status_indicator?.content || 'Melanggar kebijakan',
                                                accountId: account.id,
                                                accountName: account.name || account.uid,
                                            });
                                        }
                                    }
                                }
                            }
                            // Also use extractViolatingItems for any other structure
                            const found = extractViolatingItems(json, account);
                            for (const item of found) {
                                if (!capturedItems.find(ci => ci.id === item.id)) {
                                    capturedItems.push(item);
                                }
                            }
                        } catch { }
                    }
                } catch (e) {
                    console.error(`[DELETE-VIOLATING] Parse error: ${e.message}`);
                }
            }

            console.log(`[DELETE-VIOLATING] Method 1 (GraphQL): Found ${capturedItems.length} items`);
            if (capturedItems.length > 0) {
                sendDeleteViolatingProgress({ type: 'scan-log', message: `✅ ${account.name || account.uid}: Metode 1 (GraphQL) menemukan ${capturedItems.length} produk melanggar` });
            }

            // ═══════════════════════════════════════════════════════════
            // METODE 2: Parse data from HTML page (fallback)
            // Search innerHTML for listing_is_rejected patterns
            // ═══════════════════════════════════════════════════════════
            if (capturedItems.length === 0) {
                sendDeleteViolatingProgress({ type: 'scan-log', message: `🔄 ${account.name || account.uid}: Metode 2 - parsing HTML...` });
                try {
                    const htmlItems = await page.evaluate(() => {
                        const results = [];
                        const seen = new Set();
                        const html = document.documentElement.innerHTML;

                        if (!html.includes('listing_is_rejected')) return results;

                        // Search for listing_is_rejected:true pattern
                        const regex = /"listing_is_rejected":\s*true/g;
                        let match;
                        while ((match = regex.exec(html)) !== null) {
                            // Search FORWARD for id and title
                            const afterText = html.substring(match.index, Math.min(html.length, match.index + 3000));
                            const idM = afterText.match(/"id":\s*"(\d+)"/);
                            const titleM = afterText.match(/"marketplace_listing_title":\s*"([^"]*)"/);
                            const priceM = afterText.match(/"formatted_amount":\s*"([^"]*)"/);

                            // Search backward for photo
                            const beforeText = html.substring(Math.max(0, match.index - 2000), match.index + 500);
                            const photoM = beforeText.match(/"uri":\s*"(https:[^"]*fbcdn[^"]*)"/);

                            if (idM && !seen.has(idM[1])) {
                                seen.add(idM[1]);
                                results.push({
                                    id: idM[1],
                                    title: titleM ? titleM[1] : 'Tanpa Judul',
                                    price: priceM ? priceM[1] : '-',
                                    photo: photoM ? photoM[1].replace(/\\\//g, '/') : null,
                                    violationMessage: 'Melanggar kebijakan',
                                });
                            }
                        }
                        return results;
                    });

                    if (htmlItems && htmlItems.length > 0) {
                        for (const item of htmlItems) {
                            item.accountId = account.id;
                            item.accountName = account.name || account.uid;
                        }
                        capturedItems.push(...htmlItems);
                        console.log(`[DELETE-VIOLATING] Method 2 (HTML): Found ${htmlItems.length} items`);
                        sendDeleteViolatingProgress({ type: 'scan-log', message: `✅ ${account.name || account.uid}: Metode 2 (HTML) menemukan ${htmlItems.length} produk melanggar` });
                    }
                } catch (e) {
                    console.error(`[DELETE-VIOLATING] Method 2 error: ${e.message}`);
                }
            }

            if (capturedItems.length === 0) {
                sendDeleteViolatingProgress({ type: 'scan-log', message: `⚠️ ${account.name || account.uid}: Tidak ditemukan produk melanggar` });
            }


            // Deduplicate by ID
            const itemsMap = new Map();
            for (const item of capturedItems) {
                if (!itemsMap.has(item.id)) {
                    itemsMap.set(item.id, item);
                }
            }
            const items = Array.from(itemsMap.values());

            if (items.length > 0) {
                allItems.push(...items);
                sendDeleteViolatingProgress({ type: 'scan-result', items });
                sendDeleteViolatingProgress({ type: 'scan-log', message: `✅ ${account.name || account.uid}: Ditemukan ${items.length} produk melanggar` });
            } else {
                sendDeleteViolatingProgress({ type: 'scan-log', message: `⚠️ ${account.name || account.uid}: Tidak ditemukan produk melanggar (0 dari ${capturedResponses.length} response)` });
            }

            await browser.close();
            browser = null;
        } catch (err) {
            console.error(`[DELETE-VIOLATING] Scan error for ${account?.uid}:`, err.message);
            sendDeleteViolatingProgress({ type: 'scan-log', message: `❌ ${account.name || account.uid}: ${err.message}` });
            if (browser) { try { await browser.close(); } catch { } }
        }
    }

    sendDeleteViolatingProgress({ type: 'scan-done', totalItems: allItems.length });
    return { success: true, items: allItems };
});

// --- Execute: Delete Violating Items (mirrors renew:execute-items) ---
ipcMain.handle('delete-violating:execute-items', async (_event, payload) => {
    deleteViolatingAbortFlag = false;
    const { items, delayMin = 3, delayMax = 7 } = payload;

    // Group items by account
    const accountsGroup = {};
    for (const item of items) {
        if (!accountsGroup[item.accountId]) {
            accountsGroup[item.accountId] = { accountId: item.accountId, items: [] };
        }
        accountsGroup[item.accountId].items.push(item);
    }

    try {
        const { chromium } = require('playwright');
        const storeAccounts = store.get('accounts', []);

        for (const accountId of Object.keys(accountsGroup)) {
            if (deleteViolatingAbortFlag) break;

            const group = accountsGroup[accountId];
            const account = storeAccounts.find(a => a.id === accountId);
            const accountItems = group.items;

            if (!account || !account.cookiesPath || !fs.existsSync(account.cookiesPath)) {
                for (const item of accountItems) {
                    sendDeleteViolatingProgress({ type: 'delete-update', itemId: item.id, status: 'failed', message: 'Cookies tidak ditemukan' });
                }
                continue;
            }

            let browser = null;
            try {
                browser = await chromium.launch({
                    headless: true,
                    ...SMART_BROWSER_CONFIG,
                    args: ['--disable-blink-features=AutomationControlled']
                });

                const context = await browser.newContext({
                    viewport: { width: 1280, height: 800 },
                    storageState: account.cookiesPath,
                    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
                });

                const page = await context.newPage();
                sendDeleteViolatingProgress({ type: 'scan-log', message: `🗑️ ${account.name || account.uid}: Memulai hapus produk melanggar...` });

                await page.goto('https://www.facebook.com/marketplace/you/selling?referral_surface=seller_hub', { waitUntil: 'domcontentloaded', timeout: 45000 });

                if (isLoginPage(page.url())) {
                    markAccountInvalid(accountId, 'Cookies expired saat eksekusi hapus tawaran');
                    for (const item of accountItems) {
                        sendDeleteViolatingProgress({ type: 'delete-update', itemId: item.id, status: 'failed', message: 'Sesi expired (Login required)' });
                    }
                    await browser.close();
                    browser = null;
                    continue;
                }

                // Extract tokens — same as renew
                const tokens = await page.evaluate(() => {
                    let fbDtsg = null;
                    let actorId = null;

                    if (window.DTSGInitData && window.DTSGInitData.token) fbDtsg = window.DTSGInitData.token;
                    if (!fbDtsg) {
                        try { if (typeof require === 'function') { const m = require('DTSGInitData'); if (m && m.token) fbDtsg = m.token; } } catch { }
                    }
                    if (!fbDtsg) {
                        const input = document.querySelector('input[name="fb_dtsg"]');
                        if (input) fbDtsg = input.value;
                    }
                    if (!fbDtsg) {
                        const html = document.documentElement.innerHTML;
                        const m1 = html.match(/"DTSGInitData".*?"token":"([^"]+)"/);
                        if (m1) fbDtsg = m1[1];
                        if (!fbDtsg) {
                            const m2 = html.match(/fb_dtsg.*?value="([^"]+)"/);
                            if (m2) fbDtsg = m2[1];
                        }
                    }

                    try {
                        const html = document.documentElement.innerHTML;
                        const uidMatch = html.match(/"USER_ID":"(\d+)"/) || html.match(/"actorID":"(\d+)"/) || html.match(/"userID":"(\d+)"/);
                        if (uidMatch) actorId = uidMatch[1];
                    } catch { }
                    if (!actorId) {
                        try {
                            const cookies = document.cookie;
                            const cUser = cookies.match(/c_user=(\d+)/);
                            if (cUser) actorId = cUser[1];
                        } catch { }
                    }

                    return { fbDtsg, actorId };
                });

                if (!tokens.fbDtsg || !tokens.actorId) {
                    for (const item of accountItems) {
                        sendDeleteViolatingProgress({ type: 'delete-update', itemId: item.id, status: 'failed', message: 'Gagal ekstrak token' });
                    }
                    await browser.close();
                    browser = null;
                    continue;
                }

                console.log(`[DELETE-VIOLATING] Tokens OK for ${account.uid}: dtsg=${tokens.fbDtsg.substring(0, 15)}... actor=${tokens.actorId}`);

                // Create API context — same as renew
                const apiContext = await (require('playwright')).request.newContext({
                    storageState: account.cookiesPath,
                    extraHTTPHeaders: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
                        'Accept-Language': 'en-US,en;q=0.9',
                        'Origin': 'https://www.facebook.com',
                        'Referer': 'https://www.facebook.com/marketplace/you/selling?referral_surface=seller_hub',
                        'Sec-Fetch-Site': 'same-origin',
                        'Sec-Fetch-Mode': 'cors',
                        'Sec-Fetch-Dest': 'empty',
                        'Content-Type': 'application/x-www-form-urlencoded',
                    },
                });

                // Loop through items
                for (let j = 0; j < accountItems.length; j++) {
                    if (deleteViolatingAbortFlag) {
                        for (let k = j; k < accountItems.length; k++) {
                            sendDeleteViolatingProgress({ type: 'delete-update', itemId: accountItems[k].id, status: 'failed', message: 'Dihentikan oleh user' });
                        }
                        break;
                    }

                    const item = accountItems[j];
                    sendDeleteViolatingProgress({ type: 'delete-update', itemId: item.id, status: 'processing', message: 'Menghapus...' });

                    try {
                        const variables = JSON.stringify({
                            input: {
                                client_mutation_id: String(j + 1),
                                actor_id: tokens.actorId,
                                batch_delete_variants: true,
                                for_sale_item_id: String(item.id),
                                referral_surface: null,
                                surface: 'MARKETPLACE_PAGE_SELLING',
                            },
                        });

                        const response = await apiContext.post('https://www.facebook.com/api/graphql/', {
                            form: {
                                av: tokens.actorId,
                                __user: tokens.actorId,
                                fb_dtsg: tokens.fbDtsg,
                                doc_id: '30073389588942699',
                                variables: variables,
                            },
                            timeout: 15000,
                        });

                        const status = response.status();
                        if (status === 200) {
                            let resText = await response.text();
                            resText = resText.replace(/^for \(;;\);/, '');
                            try {
                                const resJson = JSON.parse(resText);
                                if (resJson.errors && resJson.errors.length > 0) {
                                    const errMsg = resJson.errors[0]?.message || 'Unknown error';
                                    sendDeleteViolatingProgress({ type: 'delete-update', itemId: item.id, status: 'failed', message: errMsg });
                                } else {
                                    sendDeleteViolatingProgress({ type: 'delete-update', itemId: item.id, status: 'success', message: '✅ Berhasil dihapus' });
                                }
                            } catch {
                                sendDeleteViolatingProgress({ type: 'delete-update', itemId: item.id, status: 'success', message: '✅ Berhasil dihapus' });
                            }
                        } else {
                            sendDeleteViolatingProgress({ type: 'delete-update', itemId: item.id, status: 'failed', message: `HTTP ${status}` });
                        }

                    } catch (err) {
                        console.error(`[DELETE-VIOLATING] Execute error for item ${item.id}:`, err.message);
                        sendDeleteViolatingProgress({ type: 'delete-update', itemId: item.id, status: 'failed', message: err.message });
                    }

                    // Random delay
                    if (j < accountItems.length - 1 && !deleteViolatingAbortFlag) {
                        const delay = (delayMin + Math.random() * (delayMax - delayMin)) * 1000;
                        await new Promise(r => setTimeout(r, delay));
                    }
                }

                // Cleanup
                try { await apiContext.dispose(); } catch { }
                await browser.close();
                browser = null;

                if (!deleteViolatingAbortFlag) {
                    await new Promise(r => setTimeout(r, 3000));
                }

            } catch (err) {
                console.error(`[DELETE-VIOLATING] Account error for ${account?.uid}:`, err.message);
                for (const item of accountItems) {
                    if (!deleteViolatingAbortFlag) {
                        sendDeleteViolatingProgress({ type: 'delete-update', itemId: item.id, status: 'failed', message: err.message });
                    }
                }
                if (browser) { try { await browser.close(); } catch { } browser = null; }
            }
        }

    } catch (err) {
        console.error('[DELETE-VIOLATING] Execute flow error:', err.message);
    }

    sendDeleteViolatingProgress({ type: 'delete-done' });
    return { success: true };
});

ipcMain.handle('delete-violating:stop', async () => {
    deleteViolatingAbortFlag = true;
    return { success: true };
});

// ============================================
// App Lifecycle
// ============================================
writeCrashLog('LIFECYCLE', 'Waiting for app.whenReady()...');

// ============================================
// GROUP SCRAPING — Scrape FB Groups by Keyword
// ============================================

// Helper: Parse member count strings like "1,5 rb", "10K", "1.2 jt"
function parseMemberCount(str) {
    if (!str) return 0;
    try {
        let s = str.toLowerCase().trim();
        s = s.replace(/anggota|members|member/gi, '').trim();
        if (s.includes('jt') || s.includes('juta')) {
            const num = parseFloat(s.replace(/[^0-9.,]/g, '').replace(',', '.'));
            return Math.round(num * 1000000);
        }
        if (s.includes('rb') || s.includes('ribu')) {
            const num = parseFloat(s.replace(/[^0-9.,]/g, '').replace(',', '.'));
            return Math.round(num * 1000);
        }
        if (s.includes('m') && !s.includes('mem')) {
            const num = parseFloat(s.replace(/[^0-9.,]/g, '').replace(',', '.'));
            return Math.round(num * 1000000);
        }
        if (s.includes('k')) {
            const num = parseFloat(s.replace(/[^0-9.,]/g, '').replace(',', '.'));
            return Math.round(num * 1000);
        }
        const cleaned = s.replace(/[^0-9]/g, '');
        return parseInt(cleaned) || 0;
    } catch {
        return 0;
    }
}

// Helper: Auto-scroll page to load more results (keeps scrolling until target met)
async function autoScrollForGroups(page, targetCount, currentCollected, maxScrolls = 25) {
    for (let i = 0; i < maxScrolls; i++) {
        if (currentCollected >= targetCount) break;
        const prevHeight = await page.evaluate(() => document.body.scrollHeight);
        await page.evaluate(() => window.scrollBy(0, window.innerHeight * 2));
        await page.waitForTimeout(humanDelay(1500, 3000));
        const newHeight = await page.evaluate(() => document.body.scrollHeight);
        // Check how many group links exist now
        const linkCount = await page.evaluate(() => document.querySelectorAll('a[href*="/groups/"]').length);
        currentCollected = linkCount;
        if (newHeight === prevHeight) {
            // Wait a bit more and try once more
            await page.waitForTimeout(humanDelay(2000, 3000));
            const finalHeight = await page.evaluate(() => document.body.scrollHeight);
            if (finalHeight === newHeight) break;
        }
    }
    return currentCollected;
}

// Helper: Extract groups from DOM
async function extractGroupsFromPage(page) {
    return page.evaluate(() => {
        const results = [];
        const seen = new Set();
        const allLinks = document.querySelectorAll('a[href*="/groups/"]');
        allLinks.forEach(link => {
            try {
                const href = link.getAttribute('href') || '';
                const match = href.match(/\/groups\/([a-zA-Z0-9_.]+)/);
                if (!match) return;
                const groupId = match[1];
                if (seen.has(groupId) || groupId === 'feed' || groupId === 'discover') return;

                let container = link;
                for (let i = 0; i < 8; i++) {
                    if (container.parentElement) container = container.parentElement;
                    const text = container.innerText || '';
                    if (text.length > 50 && (text.includes('anggota') || text.includes('member') || text.includes('Members'))) break;
                }

                const fullText = container.innerText || '';
                if (fullText.length < 20) return;

                const nameEl = link.querySelector('span') || link;
                const name = (nameEl.textContent || '').trim();
                if (name.length < 3 || name.length > 200) return;

                let privacy = 'UNKNOWN';
                const textLower = fullText.toLowerCase();
                if (textLower.includes('publik') || textLower.includes('public')) privacy = 'PUBLIC';
                else if (textLower.includes('privat') || textLower.includes('private')) privacy = 'PRIVATE';

                let memberStr = '';
                const memberPatterns = [
                    /(\d[\d.,]*\s*(?:rb|ribu|jt|juta|K|M)?\s*(?:anggota|members?|Anggota|Members?))/i,
                    /([\d.,]+\s*(?:rb|ribu|jt|juta|K|M))/i,
                ];
                for (const pat of memberPatterns) {
                    const m = fullText.match(pat);
                    if (m) { memberStr = m[1]; break; }
                }

                seen.add(groupId);
                results.push({ id: groupId, name, privacy, memberStr, url: `https://www.facebook.com/groups/${groupId}` });
            } catch { }
        });
        return results;
    });
}

let scrapeGroupAbortFlag = false;

ipcMain.handle('group:start-scrape', async (event, payload) => {
    const {
        keywords = [], accountId,
        privacyFilter = 'ALL', minMembers = 0,
        maxPerKeyword = 30, startOffset = 0,
    } = payload;
    scrapeGroupAbortFlag = false;
    const startTime = Date.now();

    const sendProgress = (data) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('group:scrape-progress', data);
        }
    };

    const allAccounts = store.get('accounts', []);
    const account = allAccounts.find(a => a.id === accountId);
    if (!account || !account.cookiesPath) {
        sendProgress({ type: 'log', message: '❌ Akun tidak valid atau tidak memiliki cookies', level: 'error' });
        sendProgress({ type: 'done' });
        return { success: false, error: 'Akun tidak valid' };
    }

    let browser = null;
    try {
        browser = await createStealthBrowser(true);
        const context = await createStealthContext(browser, account.cookiesPath);
        const page = await context.newPage();

        sendProgress({ type: 'log', message: `🔑 Login dengan akun ${account.name || account.uid}...` });
        try {
            await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
        } catch (navErr) {
            console.log('[GROUP-SCRAPE] Nav warning:', navErr.message);
        }
        await page.waitForTimeout(3000);

        if (isLoginPage(page.url())) {
            sendProgress({ type: 'log', message: '❌ Login diperlukan. Silakan cek cookies akun.', level: 'error' });
            markAccountInvalid(account.id, 'Cookies expired saat scrape grup');
            sendProgress({ type: 'done' });
            await browser.close();
            return { success: false, error: 'Login required' };
        }

        sendProgress({ type: 'log', message: `✅ Login berhasil. Mulai scrape ${keywords.length} keyword (max ${maxPerKeyword}/keyword, offset ${startOffset})...`, level: 'success' });

        let totalFound = 0;

        for (let ki = 0; ki < keywords.length; ki++) {
            if (scrapeGroupAbortFlag) {
                sendProgress({ type: 'log', message: '🛑 Scrape dihentikan oleh user', level: 'error' });
                break;
            }

            const keyword = keywords[ki];
            sendProgress({ type: 'keyword', keyword, current: ki + 1, total: keywords.length });
            sendProgress({ type: 'log', message: `🔍 [${ki + 1}/${keywords.length}] Mencari: "${keyword}"...` });

            try {
                const searchUrl = `https://www.facebook.com/search/groups/?q=${encodeURIComponent(keyword)}`;
                await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
                await page.waitForTimeout(humanDelay(3000, 5000));

                // Scroll until we have enough groups (offset + maxPerKeyword)
                const targetTotal = startOffset + maxPerKeyword;
                sendProgress({ type: 'log', message: `📜 Scrolling untuk memuat ${targetTotal} grup...` });
                await autoScrollForGroups(page, targetTotal, 0, 30);

                // Extract all groups from DOM
                const rawGroups = await extractGroupsFromPage(page);

                // Parse member counts
                const allExtracted = rawGroups.map(g => ({
                    ...g,
                    keyword,
                    memberCount: parseMemberCount(g.memberStr),
                }));
                // Remove memberStr
                allExtracted.forEach(g => delete g.memberStr);

                // Apply filters
                let filtered = allExtracted;
                if (privacyFilter !== 'ALL') {
                    filtered = filtered.filter(g => g.privacy === privacyFilter);
                }
                if (minMembers > 0) {
                    filtered = filtered.filter(g => g.memberCount >= minMembers);
                }

                // Apply offset and max
                const sliced = filtered.slice(startOffset, startOffset + maxPerKeyword);

                // Save to history (auto-save like keyword research)
                if (sliced.length > 0) {
                    const historyEntry = {
                        id: `grp_${Date.now()}_${ki}`,
                        keyword,
                        groups: sliced,
                        total: sliced.length,
                        date: new Date().toLocaleDateString('id-ID', { day: '2-digit', month: 'short', year: 'numeric' }),
                        timestamp: Date.now(),
                    };
                    const existing = store.get('group_scrape_history', []);
                    existing.unshift(historyEntry);
                    store.set('group_scrape_history', existing);
                }

                totalFound += sliced.length;
                sendProgress({ type: 'log', message: `✅ "${keyword}": ${rawGroups.length} total, ${filtered.length} lolos filter, ${sliced.length} diambil (offset ${startOffset})`, level: 'success' });

                if (ki < keywords.length - 1) {
                    await page.waitForTimeout(humanDelay(2000, 4000));
                }

            } catch (err) {
                sendProgress({ type: 'log', message: `❌ Error pada "${keyword}": ${err.message}`, level: 'error' });
            }
        }

        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        sendProgress({ type: 'log', message: `🏁 Scraping selesai! Total: ${totalFound} grup dalam ${elapsed}s`, level: 'success' });
        sendProgress({ type: 'report', report: { keywords: keywords.length, totalFound, executionTime: elapsed } });
        sendProgress({ type: 'done' });

        await browser.close();
        browser = null;
        return { success: true, total: totalFound };

    } catch (err) {
        sendProgress({ type: 'log', message: `❌ Fatal error: ${err.message}`, level: 'error' });
        sendProgress({ type: 'done' });
        if (browser) { try { await browser.close(); } catch { } }
        return { success: false, error: err.message };
    }
});

ipcMain.handle('group:stop-scrape', async () => {
    scrapeGroupAbortFlag = true;
    return { success: true };
});

ipcMain.handle('group:save-targets', async (event, groups) => {
    try {
        const existing = store.get('target_groups', []);
        const existingIds = new Set(existing.map(g => g.id));
        const newGroups = (groups || []).filter(g => !existingIds.has(g.id));
        const merged = [...newGroups, ...existing];
        store.set('target_groups', merged);
        return { success: true, total: merged.length, added: newGroups.length };
    } catch (err) {
        return { success: false, error: err.message };
    }
});

ipcMain.handle('group:get-targets', async () => {
    return store.get('target_groups', []);
});

// ── History Management (like keyword research) ──

ipcMain.handle('group:get-scrape-history', async () => {
    return store.get('group_scrape_history', []);
});

ipcMain.handle('group:delete-scrape-history', async (event, id) => {
    try {
        const history = store.get('group_scrape_history', []);
        const filtered = history.filter(h => h.id !== id);
        store.set('group_scrape_history', filtered);
        return { success: true };
    } catch (err) {
        return { success: false, error: err.message };
    }
});

ipcMain.handle('group:delete-group-from-history', async (event, historyId, groupId) => {
    try {
        const history = store.get('group_scrape_history', []);
        const entry = history.find(h => h.id === historyId);
        if (entry) {
            entry.groups = entry.groups.filter(g => g.id !== groupId);
            entry.total = entry.groups.length;
            if (entry.total === 0) {
                // Remove empty entry
                const filtered = history.filter(h => h.id !== historyId);
                store.set('group_scrape_history', filtered);
            } else {
                store.set('group_scrape_history', history);
            }
        }
        return { success: true };
    } catch (err) {
        return { success: false, error: err.message };
    }
});


// ============================================
// GROUP JOINING — Join FB Groups Automatically
// ============================================
let joinGroupAbortFlag = false;

ipcMain.handle('group:start-join', async (event, payload) => {
    const {
        accountIds = [], groups = [],
        distribution = 'SPLIT_EVEN',
        maxPerAccount = 10,
        delayMin = 30, delayMax = 60,
        skipExisting = true,
    } = payload;
    joinGroupAbortFlag = false;

    const sendJoinProgress = (data) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('group:join-progress', data);
        }
    };

    if (accountIds.length === 0 || groups.length === 0) {
        sendJoinProgress({ type: 'log', message: '❌ Tidak ada akun atau grup yang dipilih', level: 'error' });
        sendJoinProgress({ type: 'done' });
        return { success: false, error: 'No accounts or groups selected' };
    }

    const allAccounts = store.get('accounts', []);
    const selectedAccounts = accountIds.map(id => allAccounts.find(a => a.id === id)).filter(Boolean);

    if (selectedAccounts.length === 0) {
        sendJoinProgress({ type: 'log', message: '❌ Akun tidak ditemukan', level: 'error' });
        sendJoinProgress({ type: 'done' });
        return { success: false, error: 'Accounts not found' };
    }

    // ── Build task queue based on distribution mode
    let taskQueue = []; // [{accountId, accountName, group}]

    if (distribution === 'SPLIT_EVEN') {
        // Distribute groups evenly across accounts
        const shuffled = [...groups].sort(() => Math.random() - 0.5);
        for (let i = 0; i < shuffled.length; i++) {
            const accIdx = i % selectedAccounts.length;
            const acc = selectedAccounts[accIdx];
            taskQueue.push({
                accountId: acc.id,
                accountName: acc.name || acc.uid,
                cookiesPath: acc.cookiesPath,
                group: shuffled[i],
            });
        }
    } else {
        // ALL_TO_ALL: every account joins every group
        for (const acc of selectedAccounts) {
            for (const g of groups) {
                taskQueue.push({
                    accountId: acc.id,
                    accountName: acc.name || acc.uid,
                    cookiesPath: acc.cookiesPath,
                    group: g,
                });
            }
        }
    }

    // Apply max per account limit
    const perAccountCount = {};
    taskQueue = taskQueue.filter(t => {
        perAccountCount[t.accountId] = (perAccountCount[t.accountId] || 0) + 1;
        return perAccountCount[t.accountId] <= maxPerAccount;
    });

    const totalTasks = taskQueue.length;
    sendJoinProgress({ type: 'log', message: `📋 Total tugas: ${totalTasks} (${selectedAccounts.length} akun, ${groups.length} grup, mode: ${distribution})`, level: 'info' });
    sendJoinProgress({ type: 'progress', current: 0, total: totalTasks });

    // Group tasks by account to reuse browser sessions
    const tasksByAccount = {};
    for (const t of taskQueue) {
        if (!tasksByAccount[t.accountId]) tasksByAccount[t.accountId] = [];
        tasksByAccount[t.accountId].push(t);
    }

    let completedCount = 0;

    for (const [accId, tasks] of Object.entries(tasksByAccount)) {
        if (joinGroupAbortFlag) break;

        const acc = tasks[0];
        sendJoinProgress({ type: 'log', message: `🔑 Login akun: ${acc.accountName}...` });

        if (!acc.cookiesPath) {
            sendJoinProgress({ type: 'log', message: `❌ ${acc.accountName}: Tidak ada cookies`, level: 'error' });
            for (const t of tasks) {
                completedCount++;
                sendJoinProgress({ type: 'result', item: { accountId: t.accountId, accountName: t.accountName, groupName: t.group.name, groupId: t.group.id, status: 'FAILED', reason: 'No cookies' } });
                sendJoinProgress({ type: 'progress', current: completedCount, total: totalTasks });
            }
            continue;
        }

        let browser = null;
        try {
            browser = await createStealthBrowser(true);
            const context = await createStealthContext(browser, acc.cookiesPath);
            const page = await context.newPage();

            // Verify login
            try {
                await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
            } catch { }
            await page.waitForTimeout(3000);

            if (isLoginPage(page.url())) {
                sendJoinProgress({ type: 'log', message: `❌ ${acc.accountName}: Login diperlukan, skip akun`, level: 'error' });
                markAccountInvalid(acc.accountId, 'Cookies expired saat join grup');
                for (const t of tasks) {
                    completedCount++;
                    sendJoinProgress({ type: 'result', item: { accountId: t.accountId, accountName: t.accountName, groupName: t.group.name, groupId: t.group.id, status: 'FAILED', reason: 'Login required' } });
                    sendJoinProgress({ type: 'progress', current: completedCount, total: totalTasks });
                }
                await browser.close();
                continue;
            }

            sendJoinProgress({ type: 'log', message: `✅ ${acc.accountName}: Login berhasil`, level: 'success' });

            // Process each group for this account
            for (let ti = 0; ti < tasks.length; ti++) {
                if (joinGroupAbortFlag) {
                    sendJoinProgress({ type: 'log', message: '🛑 Dihentikan oleh user', level: 'error' });
                    break;
                }

                const task = tasks[ti];
                const groupUrl = task.group.url || `https://www.facebook.com/groups/${task.group.id}`;

                sendJoinProgress({ type: 'log', message: `🔍 [${completedCount + 1}/${totalTasks}] ${acc.accountName} → ${task.group.name}...` });

                let status = 'FAILED';
                let reason = '';

                try {
                    await page.goto(groupUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
                    await page.waitForTimeout(humanDelay(2000, 4000));

                    // Check if already a member
                    const pageText = await page.evaluate(() => document.body.innerText || '');
                    const isAlreadyMember = pageText.includes('Anda sudah menjadi anggota') ||
                        pageText.includes("You're a member") ||
                        pageText.includes('Anggota') && !pageText.includes('Gabung') ||
                        false;

                    // Try to find join button
                    const joinButtonExists = await page.evaluate(() => {
                        const JOIN_TEXTS = ['gabung ke grup', 'gabung grup', 'join group', 'join this group', 'bergabung dengan grup', 'bergabung ke grup'];
                        const buttons = [...document.querySelectorAll('div[role="button"], button, span[role="button"], a[role="button"]')];
                        const joinBtn = buttons.find(b => {
                            const text = (b.textContent || '').trim().toLowerCase();
                            const ariaLabel = (b.getAttribute('aria-label') || '').trim().toLowerCase();
                            return JOIN_TEXTS.some(jt => text === jt || ariaLabel === jt || text.includes(jt) || ariaLabel.includes(jt));
                        });
                        return !!joinBtn;
                    });

                    if (!joinButtonExists && skipExisting) {
                        // No join button = likely already a member
                        status = 'SKIPPED';
                        reason = 'Sudah member / tidak ada tombol gabung';
                        sendJoinProgress({ type: 'log', message: `⏭️ ${task.group.name}: Sudah member, dilewati` });
                    } else if (joinButtonExists) {
                        // Click join button
                        const clicked = await page.evaluate(() => {
                            const JOIN_TEXTS = ['gabung ke grup', 'gabung grup', 'join group', 'join this group', 'bergabung dengan grup', 'bergabung ke grup'];
                            const buttons = [...document.querySelectorAll('div[role="button"], button, span[role="button"], a[role="button"]')];
                            const joinBtn = buttons.find(b => {
                                const text = (b.textContent || '').trim().toLowerCase();
                                const ariaLabel = (b.getAttribute('aria-label') || '').trim().toLowerCase();
                                return JOIN_TEXTS.some(jt => text === jt || ariaLabel === jt || text.includes(jt) || ariaLabel.includes(jt));
                            });
                            if (joinBtn) { joinBtn.click(); return true; }
                            return false;
                        });

                        if (clicked) {
                            await page.waitForTimeout(humanDelay(3000, 5000));

                            // Check for confirmation dialogs (answer questions for private groups)
                            const hasDialog = await page.evaluate(() => {
                                return !!document.querySelector('div[role="dialog"]');
                            });

                            if (hasDialog) {
                                // Try to find and click "Submit" or "Kirim" button in dialog
                                await page.evaluate(() => {
                                    const dialog = document.querySelector('div[role="dialog"]');
                                    if (!dialog) return;
                                    const buttons = [...dialog.querySelectorAll('div[role="button"], button')];
                                    const submitBtn = buttons.find(b => {
                                        const text = (b.textContent || '').trim().toLowerCase();
                                        return text.includes('kirim') || text.includes('submit') ||
                                            text.includes('gabung') || text.includes('join');
                                    });
                                    if (submitBtn) submitBtn.click();
                                });
                                await page.waitForTimeout(humanDelay(2000, 3000));
                            }

                            // Detect result
                            const afterText = await page.evaluate(() => document.body.innerText || '');
                            const afterTextLower = afterText.toLowerCase();

                            if (afterTextLower.includes('diundang') || afterTextLower.includes('invited') ||
                                afterTextLower.includes('menunggu') || afterTextLower.includes('pending') ||
                                afterTextLower.includes('request sent') || afterTextLower.includes('permintaan terkirim') ||
                                afterTextLower.includes('tinggalkan grup') === false && hasDialog) {
                                status = 'REQUESTED';
                                reason = 'Permintaan bergabung terkirim (grup privat)';
                                sendJoinProgress({ type: 'log', message: `⏳ ${task.group.name}: Request terkirim (privat)`, level: 'success' });
                            } else if (afterTextLower.includes('tinggalkan grup') || afterTextLower.includes('leave group') ||
                                afterTextLower.includes('anda anggota') || afterTextLower.includes("you're a member")) {
                                status = 'JOINED';
                                reason = 'Berhasil bergabung';
                                sendJoinProgress({ type: 'log', message: `✅ ${task.group.name}: Berhasil join!`, level: 'success' });
                            } else {
                                // Assume requested if we clicked and got a dialog
                                status = hasDialog ? 'REQUESTED' : 'JOINED';
                                reason = hasDialog ? 'Kemungkinan request terkirim' : 'Kemungkinan berhasil join';
                                sendJoinProgress({ type: 'log', message: `${hasDialog ? '⏳' : '✅'} ${task.group.name}: ${reason}`, level: 'success' });
                            }
                        } else {
                            status = 'FAILED';
                            reason = 'Gagal klik tombol gabung';
                            sendJoinProgress({ type: 'log', message: `❌ ${task.group.name}: Gagal klik tombol`, level: 'error' });
                        }
                    } else {
                        status = 'FAILED';
                        reason = 'Tombol gabung tidak ditemukan';
                        sendJoinProgress({ type: 'log', message: `❌ ${task.group.name}: Tombol tidak ditemukan`, level: 'error' });
                    }

                } catch (err) {
                    status = 'FAILED';
                    reason = err.message;
                    sendJoinProgress({ type: 'log', message: `❌ ${task.group.name}: ${err.message}`, level: 'error' });
                }

                completedCount++;
                sendJoinProgress({ type: 'result', item: { accountId: task.accountId, accountName: task.accountName, groupName: task.group.name, groupId: task.group.id, status, reason } });
                sendJoinProgress({ type: 'progress', current: completedCount, total: totalTasks });

                // Random delay between joins
                if (ti < tasks.length - 1 && !joinGroupAbortFlag) {
                    const delay = humanDelay(delayMin * 1000, delayMax * 1000);
                    sendJoinProgress({ type: 'log', message: `⏱️ Delay ${Math.round(delay / 1000)}s sebelum grup berikutnya...` });
                    await page.waitForTimeout(delay);
                }
            }

            await browser.close();
            browser = null;

        } catch (err) {
            sendJoinProgress({ type: 'log', message: `❌ Fatal error akun ${acc.accountName}: ${err.message}`, level: 'error' });
            if (browser) { try { await browser.close(); } catch { } }
        }
    }

    sendJoinProgress({ type: 'log', message: `🏁 Selesai! Total diproses: ${completedCount}/${totalTasks}`, level: 'success' });
    sendJoinProgress({ type: 'done' });
    return { success: true, total: completedCount };
});

ipcMain.handle('group:stop-join', async () => {
    joinGroupAbortFlag = true;
    return { success: true };
});


// ═══════════════════════════════════════════════
// POST TO GROUP — GraphQL ComposerStoryCreateMutation
// ═══════════════════════════════════════════════
let postGroupAbortFlag = false;

function sendPostGroupProgress(data) {
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('group:post-progress', data);
    }
}

ipcMain.handle('group:start-post', async (event, payload) => {
    const { accountIds, groups, messageText, distribution, maxPerAccount, delayMin, delayMax } = payload;
    postGroupAbortFlag = false;

    const allAccounts = store.get('accounts', []);
    const selectedAccounts = allAccounts.filter(a => accountIds.includes(a.id));

    if (selectedAccounts.length === 0 || groups.length === 0 || !messageText) {
        return { success: false, error: 'Tidak ada akun/grup/pesan yang dipilih' };
    }

    sendPostGroupProgress({ type: 'log', message: `🚀 Memulai posting ke ${groups.length} grup dengan ${selectedAccounts.length} akun...`, level: 'info' });

    // ── Build task list based on distribution
    const tasks = [];
    if (distribution === 'ALL_TO_ALL') {
        for (const acc of selectedAccounts) {
            let count = 0;
            for (const group of groups) {
                if (count >= maxPerAccount) break;
                tasks.push({ accountId: acc.id, accountName: acc.name || acc.uid, cookiesPath: acc.cookiesPath, group });
                count++;
            }
        }
    } else {
        // SPLIT_EVEN
        const shuffled = [...groups].sort(() => Math.random() - 0.5);
        let accIndex = 0;
        const perAccCounts = {};
        for (const group of shuffled) {
            const acc = selectedAccounts[accIndex % selectedAccounts.length];
            const accId = acc.id;
            perAccCounts[accId] = (perAccCounts[accId] || 0) + 1;
            if (perAccCounts[accId] <= maxPerAccount) {
                tasks.push({ accountId: acc.id, accountName: acc.name || acc.uid, cookiesPath: acc.cookiesPath, group });
            }
            accIndex++;
        }
    }

    const totalTasks = tasks.length;
    let completedCount = 0;

    sendPostGroupProgress({ type: 'log', message: `📋 Total tugas posting: ${totalTasks}` });
    sendPostGroupProgress({ type: 'progress', current: 0, total: totalTasks });

    // Group tasks by account
    const tasksByAccount = {};
    for (const t of tasks) {
        if (!tasksByAccount[t.accountId]) tasksByAccount[t.accountId] = [];
        tasksByAccount[t.accountId].push(t);
    }

    for (const [accId, accTasks] of Object.entries(tasksByAccount)) {
        if (postGroupAbortFlag) break;

        const acc = accTasks[0];
        sendPostGroupProgress({ type: 'log', message: `🔑 Login akun: ${acc.accountName}...` });

        if (!acc.cookiesPath) {
            sendPostGroupProgress({ type: 'log', message: `❌ ${acc.accountName}: Tidak ada cookies`, level: 'error' });
            for (const t of accTasks) {
                completedCount++;
                sendPostGroupProgress({ type: 'result', item: { accountId: t.accountId, accountName: t.accountName, groupName: t.group.name, groupId: t.group.id, status: 'FAILED', reason: 'No cookies' } });
                sendPostGroupProgress({ type: 'progress', current: completedCount, total: totalTasks });
            }
            continue;
        }

        let browser = null;
        try {
            browser = await createStealthBrowser(true);
            const context = await createStealthContext(browser, acc.cookiesPath);
            const page = await context.newPage();

            // Navigate to Facebook and verify login
            try {
                await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
            } catch { }
            await page.waitForTimeout(3000);

            if (isLoginPage(page.url())) {
                sendPostGroupProgress({ type: 'log', message: `❌ ${acc.accountName}: Login diperlukan, skip akun`, level: 'error' });
                markAccountInvalid(acc.accountId, 'Cookies expired saat posting grup');
                for (const t of accTasks) {
                    completedCount++;
                    sendPostGroupProgress({ type: 'result', item: { accountId: t.accountId, accountName: t.accountName, groupName: t.group.name, groupId: t.group.id, status: 'FAILED', reason: 'Login required' } });
                    sendPostGroupProgress({ type: 'progress', current: completedCount, total: totalTasks });
                }
                await browser.close();
                continue;
            }

            // Extract tokens from the page
            const tokens = await page.evaluate(() => {
                let fbDtsg = null;
                let actorId = null;
                let lsd = null;

                // fb_dtsg
                if (window.DTSGInitData && window.DTSGInitData.token) fbDtsg = window.DTSGInitData.token;
                if (!fbDtsg) {
                    try { if (typeof require === 'function') { const m = require('DTSGInitData'); if (m && m.token) fbDtsg = m.token; } } catch { }
                }
                if (!fbDtsg) {
                    const input = document.querySelector('input[name="fb_dtsg"]');
                    if (input) fbDtsg = input.value;
                }
                if (!fbDtsg) {
                    const html = document.documentElement.innerHTML;
                    const m1 = html.match(/"DTSGInitData".*?"token":"([^"]+)"/);
                    if (m1) fbDtsg = m1[1];
                    if (!fbDtsg) {
                        const m2 = html.match(/fb_dtsg.*?value="([^"]+)"/);
                        if (m2) fbDtsg = m2[1];
                    }
                }

                // actor_id
                try {
                    const html = document.documentElement.innerHTML;
                    const uidMatch = html.match(/"USER_ID":"(\d+)"/) || html.match(/"actorID":"(\d+)"/) || html.match(/"userID":"(\d+)"/);
                    if (uidMatch) actorId = uidMatch[1];
                } catch { }
                if (!actorId) {
                    try {
                        const cookies = document.cookie;
                        const cUser = cookies.match(/c_user=(\d+)/);
                        if (cUser) actorId = cUser[1];
                    } catch { }
                }

                // lsd
                try {
                    const html = document.documentElement.innerHTML;
                    const lsdMatch = html.match(/"LSD",\[\],{"token":"([^"]+)"}/);
                    if (lsdMatch) lsd = lsdMatch[1];
                } catch { }

                return { fbDtsg, actorId, lsd };
            });

            if (!tokens.fbDtsg || !tokens.actorId) {
                sendPostGroupProgress({ type: 'log', message: `❌ ${acc.accountName}: Gagal extract token (fb_dtsg/actorId)`, level: 'error' });
                for (const t of accTasks) {
                    completedCount++;
                    sendPostGroupProgress({ type: 'result', item: { accountId: t.accountId, accountName: t.accountName, groupName: t.group.name, groupId: t.group.id, status: 'FAILED', reason: 'Token extraction failed' } });
                    sendPostGroupProgress({ type: 'progress', current: completedCount, total: totalTasks });
                }
                await browser.close();
                continue;
            }

            sendPostGroupProgress({ type: 'log', message: `✅ ${acc.accountName}: Login & token OK (actor: ${tokens.actorId})`, level: 'success' });

            // Process each group for this account
            for (let ti = 0; ti < accTasks.length; ti++) {
                if (postGroupAbortFlag) break;
                const task = accTasks[ti];
                let status = 'FAILED';
                let reason = '';
                let postUrl = null;

                try {
                    sendPostGroupProgress({ type: 'log', message: `📝 Posting ke ${task.group.name} (${ti + 1}/${accTasks.length})...` });

                    // Navigate to group page first to get proper context
                    const groupUrl = `https://www.facebook.com/groups/${task.group.id}/`;
                    try {
                        await page.goto(groupUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
                    } catch { }
                    await page.waitForTimeout(2000 + Math.random() * 2000);

                    // Execute GraphQL mutation from browser context
                    const postResult = await page.evaluate(async (params) => {
                        try {
                            const { fbDtsg, actorId, lsd, groupId, messageText } = params;

                            const composerSessionId = crypto.randomUUID ? crypto.randomUUID() : ([1e7] + -1e3 + -4e3 + -8e3 + -1e11).replace(/[018]/g, c => (c ^ (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> c / 4))).toString(16));
                            const clientMutationId = String(Math.floor(Math.random() * 100));

                            const variables = {
                                input: {
                                    composer_entry_point: "inline_composer",
                                    composer_source_surface: "group",
                                    composer_type: "group",
                                    logging: { composer_session_id: composerSessionId },
                                    source: "WWW",
                                    message: { ranges: [], text: messageText },
                                    with_tags_ids: null,
                                    inline_activities: [],
                                    text_format_preset_id: "0",
                                    group_flair: { flair_id: null },
                                    composed_text: {
                                        block_data: ["{}"],
                                        block_depths: [0],
                                        block_types: [0],
                                        blocks: [messageText],
                                        entities: ["[]"],
                                        entity_map: "{}",
                                        inline_styles: ["[]"]
                                    },
                                    navigation_data: {
                                        attribution_id_v2: `CometGroupDiscussionRoot.react,comet.group,tap_bookmark,${Date.now()},135883,${groupId},,`
                                    },
                                    tracking: [null],
                                    event_share_metadata: { surface: "newsfeed" },
                                    audience: { to_id: groupId },
                                    actor_id: actorId,
                                    client_mutation_id: clientMutationId,
                                },
                                feedLocation: "GROUP",
                                feedbackSource: 0,
                                focusCommentID: null,
                                gridMediaWidth: null,
                                groupID: null,
                                scale: 1,
                                privacySelectorRenderLocation: "COMET_STREAM",
                                checkPhotosToReelsUpsellEligibility: false,
                                referringStoryRenderLocation: null,
                                renderLocation: "group",
                                useDefaultActor: false,
                                inviteShortLinkKey: null,
                                isFeed: false,
                                isFundraiser: false,
                                isFunFactPost: false,
                                isGroup: true,
                                isEvent: false,
                                isTimeline: false,
                                isSocialLearning: false,
                                isPageNewsFeed: false,
                                isProfileReviews: false,
                                isWorkSharedDraft: false,
                                hashtag: null,
                                canUserManageOffers: false,
                                __relay_internal__pv__CometUFIShareActionMigrationrelayprovider: true,
                                __relay_internal__pv__GHLShouldChangeSponsoredDataFieldNamerelayprovider: true,
                                __relay_internal__pv__GHLShouldChangeAdIdFieldNamerelayprovider: true,
                                __relay_internal__pv__CometUFI_dedicated_comment_routable_dialog_gkrelayprovider: true,
                                __relay_internal__pv__CometUFICommentAvatarStickerAnimatedImagerelayprovider: false,
                                __relay_internal__pv__CometUFICommentActionLinksRewriteEnabledrelayprovider: false,
                                __relay_internal__pv__IsWorkUserrelayprovider: false,
                                __relay_internal__pv__CometUFIReactionsEnableShortNamerelayprovider: false,
                                __relay_internal__pv__CometUFISingleLineUFIrelayprovider: false,
                                __relay_internal__pv__TestPilotShouldIncludeDemoAdUseCaserelayprovider: false,
                                __relay_internal__pv__FBReels_deprecate_short_form_video_context_gkrelayprovider: true,
                                __relay_internal__pv__FBReels_enable_view_dubbed_audio_type_gkrelayprovider: true,
                                __relay_internal__pv__CometImmersivePhotoCanUserDisable3DMotionrelayprovider: false,
                                __relay_internal__pv__WorkCometIsEmployeeGKProviderrelayprovider: false,
                                __relay_internal__pv__IsMergQAPollsrelayprovider: false,
                                __relay_internal__pv__FBReels_enable_meta_ai_label_gkrelayprovider: true,
                                __relay_internal__pv__FBReelsMediaFooter_comet_enable_reels_ads_gkrelayprovider: true,
                                __relay_internal__pv__StoriesArmadilloReplyEnabledrelayprovider: true,
                                __relay_internal__pv__FBReelsIFUTileContent_reelsIFUPlayOnHoverrelayprovider: true,
                                __relay_internal__pv__GroupsCometGYSJFeedItemHeightrelayprovider: 206,
                                __relay_internal__pv__ShouldEnableBakedInTextStoriesrelayprovider: false,
                                __relay_internal__pv__StoriesShouldIncludeFbNotesrelayprovider: true,
                                __relay_internal__pv__groups_comet_use_glvrelayprovider: true,
                                __relay_internal__pv__GHLShouldChangeSponsoredAuctionDistanceFieldNamerelayprovider: false,
                                __relay_internal__pv__GHLShouldUseSponsoredAuctionLabelFieldNameV1relayprovider: false,
                                __relay_internal__pv__GHLShouldUseSponsoredAuctionLabelFieldNameV2relayprovider: false,
                            };

                            // Calculate jazoest from fb_dtsg
                            let jazoest = 0;
                            for (let i = 0; i < fbDtsg.length; i++) {
                                jazoest += fbDtsg.charCodeAt(i);
                            }

                            const formBody = new URLSearchParams();
                            formBody.append('av', actorId);
                            formBody.append('__user', actorId);
                            formBody.append('__a', '1');
                            formBody.append('__req', String(Math.floor(Math.random() * 50) + 10));
                            formBody.append('dpr', '1');
                            formBody.append('__ccg', 'EXCELLENT');
                            formBody.append('__comet_req', '15');
                            formBody.append('fb_dtsg', fbDtsg);
                            formBody.append('jazoest', String(jazoest));
                            formBody.append('lsd', lsd || '');
                            formBody.append('fb_api_caller_class', 'RelayModern');
                            formBody.append('fb_api_req_friendly_name', 'ComposerStoryCreateMutation');
                            formBody.append('variables', JSON.stringify(variables));
                            formBody.append('server_timestamps', 'true');
                            formBody.append('doc_id', '26107550138875663');

                            const resp = await fetch('/api/graphql/', {
                                method: 'POST',
                                headers: {
                                    'Content-Type': 'application/x-www-form-urlencoded',
                                    'X-FB-Friendly-Name': 'ComposerStoryCreateMutation',
                                    'X-FB-LSD': lsd || '',
                                },
                                body: formBody.toString(),
                            });

                            const text = await resp.text();

                            // Try to parse the response
                            // FB GraphQL responses may contain multiple JSON objects separated by newlines
                            const lines = text.split('\n').filter(l => l.trim());
                            for (const line of lines) {
                                try {
                                    const json = JSON.parse(line);
                                    if (json?.data?.story_create?.story?.url) {
                                        return {
                                            success: true,
                                            url: json.data.story_create.story.url,
                                            postId: json.data.story_create.story.post_id || json.data.story_create.story.legacy_story_hideable_id,
                                        };
                                    }
                                    if (json?.errors) {
                                        return { success: false, error: json.errors[0]?.message || 'GraphQL error' };
                                    }
                                } catch { }
                            }

                            // If we got a 200 response but couldn't parse story_create, it might still have worked
                            if (resp.ok && text.includes('story_create')) {
                                return { success: true, url: 'unknown', postId: 'unknown' };
                            }

                            return { success: false, error: `HTTP ${resp.status} - response tidak valid` };
                        } catch (err) {
                            return { success: false, error: err.message || String(err) };
                        }
                    }, {
                        fbDtsg: tokens.fbDtsg,
                        actorId: tokens.actorId,
                        lsd: tokens.lsd || '',
                        groupId: task.group.id,
                        messageText: messageText
                    });

                    if (postResult.success) {
                        status = 'POSTED';
                        reason = postResult.url || 'OK';
                        postUrl = postResult.url || null;
                        sendPostGroupProgress({ type: 'log', message: `✅ ${task.group.name}: Post berhasil! URL: ${postUrl || '-'}`, level: 'success' });
                    } else {
                        status = 'FAILED';
                        reason = postResult.error || 'Unknown error';
                        sendPostGroupProgress({ type: 'log', message: `❌ ${task.group.name}: ${reason}`, level: 'error' });
                    }

                } catch (err) {
                    status = 'FAILED';
                    reason = err.message;
                    sendPostGroupProgress({ type: 'log', message: `❌ ${task.group.name}: ${err.message}`, level: 'error' });
                }

                completedCount++;
                sendPostGroupProgress({ type: 'result', item: { accountId: task.accountId, accountName: task.accountName, groupName: task.group.name, groupId: task.group.id, status, reason, postUrl: postUrl || null } });
                sendPostGroupProgress({ type: 'progress', current: completedCount, total: totalTasks });

                // Random delay between posts
                if (ti < accTasks.length - 1 && !postGroupAbortFlag) {
                    const delay = humanDelay(delayMin * 1000, delayMax * 1000);
                    sendPostGroupProgress({ type: 'log', message: `⏱️ Delay ${Math.round(delay / 1000)}s sebelum grup berikutnya...` });
                    await page.waitForTimeout(delay);
                }
            }

            await browser.close();
            browser = null;

        } catch (err) {
            sendPostGroupProgress({ type: 'log', message: `❌ Fatal error akun ${acc.accountName}: ${err.message}`, level: 'error' });
            if (browser) { try { await browser.close(); } catch { } }
        }
    }

    sendPostGroupProgress({ type: 'log', message: `🏁 Selesai! Total diproses: ${completedCount}/${totalTasks}`, level: 'success' });
    sendPostGroupProgress({ type: 'done' });
    return { success: true, total: completedCount };
});

ipcMain.handle('group:stop-post', async () => {
    postGroupAbortFlag = true;
    return { success: true };
});


// ═══════════════════════════════════════════════
// GROUP MATERIALS — CRUD for Group Posting Content
// ═══════════════════════════════════════════════
ipcMain.handle('group:save-materials', async (event, materials) => {
    try {
        const existing = store.get('groupMaterials', []);
        const existingIds = new Set(existing.map(m => m.id));
        const newOnes = materials.filter(m => !existingIds.has(m.id));
        const merged = [...existing, ...newOnes];
        store.set('groupMaterials', merged);
        return { success: true, added: newOnes.length, total: merged.length };
    } catch (err) {
        return { success: false, error: err.message };
    }
});

ipcMain.handle('group:get-materials', async () => {
    return store.get('groupMaterials', []);
});

ipcMain.handle('group:delete-materials', async (event, ids) => {
    try {
        const existing = store.get('groupMaterials', []);
        const idSet = new Set(ids);
        const filtered = existing.filter(m => !idSet.has(m.id));
        store.set('groupMaterials', filtered);
        return { success: true, deleted: existing.length - filtered.length };
    } catch (err) {
        return { success: false, error: err.message };
    }
});

// ═══════════════════════════════════════════════
// GROUP CAMPAIGNS — CRUD for Group Campaign State
// ═══════════════════════════════════════════════
ipcMain.handle('group:save-campaigns', async (event, campaigns) => {
    try {
        store.set('groupCampaigns', campaigns);
        return { success: true };
    } catch (err) {
        return { success: false, error: err.message };
    }
});

ipcMain.handle('group:get-campaigns', async () => {
    return store.get('groupCampaigns', []);
});

// ═══════════════════════════════════════════════
// GROUP CAMPAIGN EXECUTION — Run campaign with task list
// ═══════════════════════════════════════════════
let groupCampaignAbortFlag = false;

function sendGroupCampaignProgress(data) {
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('group:campaign-progress', data);
    }
}
function sendGroupCampaignLog(data) {
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('group:campaign-log', data);
    }
}

ipcMain.handle('group:start-campaign', async (event, payload) => {
    const { campaignId, tasks, delayMin, delayMax } = payload;
    groupCampaignAbortFlag = false;

    const allAccounts = store.get('accounts', []);

    // Group tasks by account
    const tasksByAccount = {};
    for (const t of tasks) {
        if (!tasksByAccount[t.accountId]) tasksByAccount[t.accountId] = [];
        tasksByAccount[t.accountId].push(t);
    }

    sendGroupCampaignLog({ campaignId, message: `🚀 Memulai campaign — ${tasks.length} tugas posting...`, level: 'info' });

    for (const [accId, accTasks] of Object.entries(tasksByAccount)) {
        if (groupCampaignAbortFlag) break;

        const accData = allAccounts.find(a => a.id === accId);
        const accName = accData?.name || accData?.uid || accId;
        const cookiesPath = accData?.cookiesPath;

        if (!cookiesPath) {
            sendGroupCampaignLog({ campaignId, message: `❌ ${accName}: Tidak ada cookies`, level: 'error' });
            for (const t of accTasks) {
                sendGroupCampaignProgress({ campaignId, taskIndex: t.taskIndex, status: 'ERROR', error: 'No cookies', postUrl: null });
            }
            continue;
        }

        let browser = null;
        try {
            browser = await createStealthBrowser(true);
            const context = await createStealthContext(browser, cookiesPath);
            const page = await context.newPage();

            try {
                await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
            } catch { }
            await page.waitForTimeout(3000);

            if (isLoginPage(page.url())) {
                sendGroupCampaignLog({ campaignId, message: `❌ ${accName}: Login diperlukan`, level: 'error' });
                markAccountInvalid(accId, 'Cookies expired saat group campaign');
                for (const t of accTasks) {
                    sendGroupCampaignProgress({ campaignId, taskIndex: t.taskIndex, status: 'ERROR', error: 'Login required', postUrl: null });
                }
                await browser.close();
                continue;
            }

            // Extract tokens
            const tokens = await page.evaluate(() => {
                let fbDtsg = null, actorId = null, lsd = null;
                if (window.DTSGInitData && window.DTSGInitData.token) fbDtsg = window.DTSGInitData.token;
                if (!fbDtsg) { const input = document.querySelector('input[name="fb_dtsg"]'); if (input) fbDtsg = input.value; }
                if (!fbDtsg) { const html = document.documentElement.innerHTML; const m = html.match(/"DTSGInitData".*?"token":"([^"]+)"/); if (m) fbDtsg = m[1]; }
                try { const html = document.documentElement.innerHTML; const m = html.match(/"USER_ID":"(\d+)"/) || html.match(/"actorID":"(\d+)"/); if (m) actorId = m[1]; } catch { }
                if (!actorId) { try { const c = document.cookie.match(/c_user=(\d+)/); if (c) actorId = c[1]; } catch { } }
                try { const html = document.documentElement.innerHTML; const m = html.match(/"LSD",\[\],{"token":"([^"]+)"}/); if (m) lsd = m[1]; } catch { }
                return { fbDtsg, actorId, lsd };
            });

            if (!tokens.fbDtsg || !tokens.actorId) {
                sendGroupCampaignLog({ campaignId, message: `❌ ${accName}: Gagal extract token`, level: 'error' });
                for (const t of accTasks) {
                    sendGroupCampaignProgress({ campaignId, taskIndex: t.taskIndex, status: 'ERROR', error: 'Token extraction failed', postUrl: null });
                }
                await browser.close();
                continue;
            }

            sendGroupCampaignLog({ campaignId, message: `✅ ${accName}: Login & token OK`, level: 'success' });

            for (let ti = 0; ti < accTasks.length; ti++) {
                if (groupCampaignAbortFlag) break;
                const task = accTasks[ti];

                sendGroupCampaignProgress({ campaignId, taskIndex: task.taskIndex, status: 'UPLOADING' });
                sendGroupCampaignLog({ campaignId, message: `📝 ${accName} → ${task.groupName} (${task.materialTitle || 'konten'})...` });

                // Navigate to group
                try {
                    await page.goto(`https://www.facebook.com/groups/${task.groupId}/`, { waitUntil: 'domcontentloaded', timeout: 30000 });
                } catch { }
                await page.waitForTimeout(2000 + Math.random() * 2000);

                // ── Upload images if present ──
                const photoIds = [];
                const taskImages = task.images || [];
                if (taskImages.length > 0) {
                    sendGroupCampaignLog({ campaignId, message: `📷 Upload ${taskImages.length} gambar...` });
                    for (let imgIdx = 0; imgIdx < taskImages.length; imgIdx++) {
                        if (groupCampaignAbortFlag) break;
                        const imgPath = taskImages[imgIdx];
                        try {
                            const fs = require('fs');
                            const path = require('path');
                            if (!fs.existsSync(imgPath)) {
                                sendGroupCampaignLog({ campaignId, message: `⚠️ File tidak ditemukan: ${path.basename(imgPath)}`, level: 'warn' });
                                continue;
                            }
                            const imgBuffer = fs.readFileSync(imgPath);
                            const imgBase64 = imgBuffer.toString('base64');
                            const ext = path.extname(imgPath).toLowerCase().replace('.', '');
                            const mimeMap = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif' };
                            const mime = mimeMap[ext] || 'image/jpeg';
                            const fileName = path.basename(imgPath);

                            const uploadResult = await page.evaluate(async (params) => {
                                try {
                                    const { fbDtsg, actorId, lsd, imgBase64, mime, fileName, uploadIdx } = params;
                                    // Decode base64 to binary
                                    const binaryStr = atob(imgBase64);
                                    const bytes = new Uint8Array(binaryStr.length);
                                    for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i);
                                    const blob = new Blob([bytes], { type: mime });
                                    const file = new File([blob], fileName, { type: mime });

                                    // Build jazoest
                                    let jazoest = 0;
                                    for (let i = 0; i < fbDtsg.length; i++) jazoest += fbDtsg.charCodeAt(i);

                                    const formData = new FormData();
                                    formData.append('farr', file);
                                    formData.append('source', '8');
                                    formData.append('profile_id', actorId);
                                    formData.append('waterfallxapp', 'comet');
                                    formData.append('upload_id', `jsc_c_${uploadIdx}`);

                                    const uploadParams = new URLSearchParams();
                                    uploadParams.append('av', actorId);
                                    uploadParams.append('__user', actorId);
                                    uploadParams.append('__a', '1');
                                    uploadParams.append('__req', String(Math.floor(Math.random() * 50) + 10));
                                    uploadParams.append('dpr', '1');
                                    uploadParams.append('__ccg', 'EXCELLENT');
                                    uploadParams.append('__comet_req', '15');
                                    uploadParams.append('fb_dtsg', fbDtsg);
                                    uploadParams.append('jazoest', String(jazoest));
                                    uploadParams.append('lsd', lsd || '');

                                    const url = `https://upload.facebook.com/ajax/react_composer/attachments/photo/upload?${uploadParams.toString()}`;

                                    const resp = await fetch(url, {
                                        method: 'POST',
                                        body: formData,
                                        credentials: 'include',
                                    });

                                    const text = await resp.text();
                                    // Response format: for (;;);{JSON}
                                    const jsonStr = text.replace(/^for\s*\(;;\);/, '');
                                    const json = JSON.parse(jsonStr);

                                    if (json.payload && json.payload.photoID) {
                                        return { success: true, photoID: json.payload.photoID };
                                    }
                                    return { success: false, error: 'No photoID in response' };
                                } catch (err) {
                                    return { success: false, error: err.message || String(err) };
                                }
                            }, {
                                fbDtsg: tokens.fbDtsg, actorId: tokens.actorId, lsd: tokens.lsd || '',
                                imgBase64, mime, fileName, uploadIdx: imgIdx
                            });

                            if (uploadResult.success) {
                                photoIds.push(uploadResult.photoID);
                                sendGroupCampaignLog({ campaignId, message: `  📷 ${fileName} → ID: ${uploadResult.photoID}` });
                            } else {
                                sendGroupCampaignLog({ campaignId, message: `  ⚠️ ${fileName}: ${uploadResult.error}`, level: 'warn' });
                            }

                            // Small delay between uploads
                            if (imgIdx < taskImages.length - 1) {
                                await page.waitForTimeout(1000 + Math.random() * 1500);
                            }
                        } catch (imgErr) {
                            sendGroupCampaignLog({ campaignId, message: `  ⚠️ Upload error: ${imgErr.message}`, level: 'warn' });
                        }
                    }
                }

                // Execute GraphQL mutation
                const postResult = await page.evaluate(async (params) => {
                    try {
                        const { fbDtsg, actorId, lsd, groupId, messageText, photoIds } = params;
                        const composerSessionId = crypto.randomUUID ? crypto.randomUUID() : ([1e7] + -1e3 + -4e3 + -8e3 + -1e11).replace(/[018]/g, c => (c ^ (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> c / 4))).toString(16));

                        // Build attachments array from uploaded photos
                        const attachments = photoIds.map(id => ({ photo: { id } }));

                        const variables = {
                            input: {
                                composer_entry_point: "inline_composer",
                                composer_source_surface: "group",
                                composer_type: "group",
                                logging: { composer_session_id: composerSessionId },
                                source: "WWW",
                                message: { ranges: [], text: messageText },
                                with_tags_ids: null,
                                inline_activities: [],
                                text_format_preset_id: "0",
                                group_flair: { flair_id: null },
                                attachments: attachments,
                                composed_text: {
                                    block_data: ["{}"],
                                    block_depths: [0],
                                    block_types: [0],
                                    blocks: [messageText],
                                    entities: ["[]"],
                                    entity_map: "{}",
                                    inline_styles: ["[]"]
                                },
                                navigation_data: { attribution_id_v2: `CometGroupDiscussionRoot.react,comet.group,tap_bookmark,${Date.now()},135883,${groupId},,` },
                                tracking: [null],
                                event_share_metadata: { surface: "newsfeed" },
                                audience: { to_id: groupId },
                                actor_id: actorId,
                                client_mutation_id: String(Math.floor(Math.random() * 100)),
                            },
                            feedLocation: "GROUP", feedbackSource: 0, focusCommentID: null,
                            gridMediaWidth: null, groupID: null, scale: 1,
                            privacySelectorRenderLocation: "COMET_STREAM",
                            checkPhotosToReelsUpsellEligibility: false,
                            referringStoryRenderLocation: null, renderLocation: "group",
                            useDefaultActor: false, inviteShortLinkKey: null,
                            isFeed: false, isFundraiser: false, isFunFactPost: false,
                            isGroup: true, isEvent: false, isTimeline: false,
                            isSocialLearning: false, isPageNewsFeed: false,
                            isProfileReviews: false, isWorkSharedDraft: false,
                            hashtag: null, canUserManageOffers: false,
                            __relay_internal__pv__CometUFIShareActionMigrationrelayprovider: true,
                            __relay_internal__pv__GHLShouldChangeSponsoredDataFieldNamerelayprovider: true,
                            __relay_internal__pv__GHLShouldChangeAdIdFieldNamerelayprovider: true,
                        };

                        let jazoest = 0;
                        for (let i = 0; i < fbDtsg.length; i++) jazoest += fbDtsg.charCodeAt(i);

                        const formBody = new URLSearchParams();
                        formBody.append('av', actorId);
                        formBody.append('__user', actorId);
                        formBody.append('__a', '1');
                        formBody.append('__req', String(Math.floor(Math.random() * 50) + 10));
                        formBody.append('dpr', '1');
                        formBody.append('__ccg', 'EXCELLENT');
                        formBody.append('__comet_req', '15');
                        formBody.append('fb_dtsg', fbDtsg);
                        formBody.append('jazoest', String(jazoest));
                        formBody.append('lsd', lsd || '');
                        formBody.append('fb_api_caller_class', 'RelayModern');
                        formBody.append('fb_api_req_friendly_name', 'ComposerStoryCreateMutation');
                        formBody.append('variables', JSON.stringify(variables));
                        formBody.append('server_timestamps', 'true');
                        // Use the correct doc_id — photo posts use a different mutation ID
                        formBody.append('doc_id', photoIds.length > 0 ? '26246146168338719' : '26107550138875663');

                        const resp = await fetch('/api/graphql/', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-FB-Friendly-Name': 'ComposerStoryCreateMutation', 'X-FB-LSD': lsd || '' },
                            body: formBody.toString(),
                        });

                        const text = await resp.text();
                        const lines = text.split('\n').filter(l => l.trim());
                        for (const line of lines) {
                            try {
                                const json = JSON.parse(line);
                                if (json?.data?.story_create?.story?.url) {
                                    return { success: true, url: json.data.story_create.story.url, postId: json.data.story_create.story.post_id || json.data.story_create.story.legacy_story_hideable_id };
                                }
                                if (json?.errors) return { success: false, error: json.errors[0]?.message || 'GraphQL error' };
                            } catch { }
                        }
                        if (resp.ok && text.includes('story_create')) return { success: true, url: 'unknown', postId: 'unknown' };
                        return { success: false, error: `HTTP ${resp.status}` };
                    } catch (err) {
                        return { success: false, error: err.message || String(err) };
                    }
                }, { fbDtsg: tokens.fbDtsg, actorId: tokens.actorId, lsd: tokens.lsd || '', groupId: task.groupId, messageText: task.messageText, photoIds });

                if (postResult.success) {
                    const cleanUrl = (postResult.url || '').split('\\/').join('/');
                    sendGroupCampaignProgress({ campaignId, taskIndex: task.taskIndex, status: 'SUCCESS', postUrl: cleanUrl });
                    sendGroupCampaignLog({ campaignId, message: `✅ ${task.groupName}: Berhasil! ${cleanUrl}`, level: 'success' });

                    // ── Post Validation: check if post still exists after ~10s ──
                    if (cleanUrl && cleanUrl !== 'unknown' && !groupCampaignAbortFlag) {
                        const validateDelay = 8000 + Math.floor(Math.random() * 4000); // 8-12s
                        sendGroupCampaignLog({ campaignId, message: `🔍 Validasi posting ${task.groupName} dalam ${Math.round(validateDelay / 1000)}s...` });
                        await page.waitForTimeout(validateDelay);

                        try {
                            await page.goto(cleanUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
                            await page.waitForTimeout(2000);

                            const validationResult = await page.evaluate(() => {
                                const bodyText = document.body ? document.body.innerText : '';
                                const html = document.documentElement.innerHTML || '';
                                // Check for deletion/unavailability indicators
                                const deletionIndicators = [
                                    'Konten Ini Tidak Tersedia',
                                    'This Content Isn\'t Available',
                                    'content isn\'t available',
                                    'konten tidak tersedia',
                                    'This page isn\'t available',
                                    'Halaman ini tidak tersedia',
                                    'Sorry, this content isn',
                                    'was removed',
                                    'telah dihapus',
                                ];
                                const isDeleted = deletionIndicators.some(indicator =>
                                    bodyText.toLowerCase().includes(indicator.toLowerCase()) ||
                                    html.toLowerCase().includes(indicator.toLowerCase())
                                );
                                // Also check for error page meta tags
                                const hasErrorPage = html.includes('error_page') || html.includes('page_error') ||
                                    (document.querySelector('title') && document.querySelector('title').textContent.includes('Error'));
                                return { isDeleted: isDeleted || hasErrorPage, bodyPreview: bodyText.substring(0, 200) };
                            });

                            if (validationResult.isDeleted) {
                                sendGroupCampaignProgress({ campaignId, taskIndex: task.taskIndex, status: 'DELETED', postUrl: cleanUrl });
                                sendGroupCampaignLog({ campaignId, message: `🗑️ ${task.groupName}: Postingan dihapus otomatis oleh admin!`, level: 'error' });
                            } else {
                                sendGroupCampaignLog({ campaignId, message: `✅ ${task.groupName}: Validasi OK — posting masih aktif`, level: 'success' });
                            }
                        } catch (valErr) {
                            sendGroupCampaignLog({ campaignId, message: `⚠️ ${task.groupName}: Validasi gagal — ${valErr.message}`, level: 'warn' });
                        }
                    }
                } else {
                    sendGroupCampaignProgress({ campaignId, taskIndex: task.taskIndex, status: 'ERROR', error: postResult.error, postUrl: null });
                    sendGroupCampaignLog({ campaignId, message: `❌ ${task.groupName}: ${postResult.error}`, level: 'error' });
                }

                // Delay between posts
                if (ti < accTasks.length - 1 && !groupCampaignAbortFlag) {
                    const delay = humanDelay(delayMin * 1000, delayMax * 1000);
                    sendGroupCampaignLog({ campaignId, message: `⏱️ Delay ${Math.round(delay / 1000)}s...` });
                    await page.waitForTimeout(delay);
                }
            }

            await browser.close();
            browser = null;
        } catch (err) {
            sendGroupCampaignLog({ campaignId, message: `❌ Fatal: ${accName} — ${err.message}`, level: 'error' });
            if (browser) { try { await browser.close(); } catch { } }
        }
    }

    sendGroupCampaignLog({ campaignId, message: `🏁 Campaign selesai!`, level: 'success' });
    sendGroupCampaignProgress({ campaignId, type: 'done' });
    return { success: true };
});

ipcMain.handle('group:stop-campaign', async () => {
    groupCampaignAbortFlag = true;
    return { success: true };
});


app.whenReady().then(() => {
    writeCrashLog('LIFECYCLE', 'app.whenReady() resolved — calling createWindow()');
    createWindow();
    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
}).catch((err) => {
    writeCrashLog('LIFECYCLE_ERROR', err);
});

app.on('window-all-closed', () => {
    writeCrashLog('LIFECYCLE', 'All windows closed — quitting');
    if (process.platform !== 'darwin') app.quit();
});

