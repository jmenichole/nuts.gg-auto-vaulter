// ==UserScript==
// @name         Nuts.gg Auto-Vault Floater Tiltcheck Tools
// @namespace    Nuts Auto-Vault Utility
// @version      2.5.0
// @description  Automatically moves a percentage of your play-balance profits into the vault on nuts.gg. Auto-tip on vault withdrawals is on by default (1% to @jmenichole) — uncheck the tip box to turn it off. Glassmorphism UI.
// @author       jmenichole
// @copyright    2026, Tiltcheck.me (https://tiltcheck.me)
// @license      All Rights Reserved. Modification and unauthorized redistribution prohibited.
// @downloadURL  https://jmenichole.github.io/nuts.gg-auto-vaulter/tiltcheck-nuts-autovault.user.js
// @updateURL    https://jmenichole.github.io/nuts.gg-auto-vaulter/tiltcheck-nuts-autovault.user.js
// @match        *://nuts.gg/*
// @match        *://*.nuts.gg/*
// @match        https://nuts.gg/*
// @match        https://www.nuts.gg/*
// @match        https://*.nuts.gg/*
// @grant        none
// @run-at       document-start
// ==/UserScript==

(function () {
    'use strict';
    // === Constants ===
    const UNIT = 1_000_000_000; // 1 SOL = 1,000,000,000 lamports
    const MIN_BALANCE_CHECKS = 2;
    const RATE_LIMIT_MAX = 50;
    const RATE_LIMIT_WINDOW = 60 * 60 * 1000;
    const WS_URL_MATCH = 'nuts.tools/graphql';

    // Auto-Tip Settings (only runs when config.autoTipEnabled is true)
    const DEV_USERNAME = 'jmenichole';
    const AUTO_TIP_PERCENT = 0.01; // 1% of withdrawal (see @description for product copy)

    // === Config ===
    function loadConfig() {
        try {
            const saved = localStorage.getItem('nuts-autovault-config');
            if (saved) return { ...defaults(), ...JSON.parse(saved) };
        } catch (e) {}
        return defaults();
    }
    function defaults() {
        return {
            saveAmount: 0.1,
            bigWinThreshold: 5,
            bigWinMultiplier: 3,
            checkInterval: 90000,
            minDepositSol: 0.001,
            /** On by default — uncheck the floaty tip box to opt out */
            autoTipEnabled: true
        };
    }
    function saveConfig() {
        localStorage.setItem('nuts-autovault-config', JSON.stringify(config));
    }
    let config = loadConfig();
    let SAVE_AMOUNT = config.saveAmount;
    let BIG_WIN_THRESHOLD = config.bigWinThreshold;
    let BIG_WIN_MULTIPLIER = config.bigWinMultiplier;
    let CHECK_INTERVAL = config.checkInterval;
    let MIN_DEPOSIT_SOL = config.minDepositSol;

    // === Activity log ===
    const activityLog = [];
    const MAX_LOG_ENTRIES = 50;
    let onLogUpdate = null;
    function logActivity(message, type = 'info') {
        const entry = { time: new Date(), message, type };
        activityLog.unshift(entry);
        if (activityLog.length > MAX_LOG_ENTRIES) activityLog.pop();
        console.log('[NutsAutoVault]', message);
        if (onLogUpdate) onLogUpdate(entry);
    }
    const log = (...args) => logActivity(args.join(' '), 'info');
    const FLAVOR = {
        profit: ['Positive difference,', 'Profit detected'],
        bigWin: ['Big win detected', 'Large profit'],
        start: ['AutoVault started', 'Monitoring active'],
        stop: ['AutoVault stopped', 'Monitoring paused'],
        rateLimit: ['Rate limited, vaulting paused', 'Limit reached, vaulting paused']
    };
    const pickFlavor = (arr) => arr[Math.floor(Math.random() * arr.length)];

    // === WebSocket hook ===
    let nutsSocket = null;
    let socketAuthenticated = false;
    const attachedSockets = new WeakSet();
    function onIncoming(raw) {
        try {
            const msg = JSON.parse(raw);
            if (msg.type === 'connection_ack' || msg.type === 'next' || msg.type === 'data') {
                if (!socketAuthenticated) {
                    socketAuthenticated = true;
                    log('Socket authenticated with nuts.tools');
                }
            }
            if (msg.type === 'next' && msg.payload?.data) handleSubscriptionPayload(msg);
        } catch {}
    }
    function attachToSocket(ws) {
        if (!ws || attachedSockets.has(ws)) return;
        attachedSockets.add(ws);
        nutsSocket = ws;
        ws.addEventListener('message', (evt) => onIncoming(evt.data));
        ws.addEventListener('close', () => {
            if (nutsSocket === ws) {
                nutsSocket = null;
                socketAuthenticated = false;
            }
        });
        ws.addEventListener('error', () => {});
        log('Hooked nuts.tools socket (readyState=' + ws.readyState + ')');
    }
    try {
        const OriginalSend = WebSocket.prototype.send;
        WebSocket.prototype.send = function (data) {
            try {
                if (this && typeof this.url === 'string' && this.url.includes(WS_URL_MATCH)) {
                    attachToSocket(this);
                }
            } catch (e) {}
            return OriginalSend.apply(this, arguments);
        };
    } catch (e) {
        console.error('[NutsAutoVault] Failed to patch WebSocket.prototype.send:', e);
    }
    try {
        const OriginalWebSocket = window.WebSocket;
        function HookedWebSocket(url, protocols) {
            const ws = protocols !== undefined ? new OriginalWebSocket(url, protocols) : new OriginalWebSocket(url);
            try {
                if (String(url).includes(WS_URL_MATCH)) attachToSocket(ws);
            } catch {}
            return ws;
        }
        HookedWebSocket.prototype = OriginalWebSocket.prototype;
        HookedWebSocket.CONNECTING = OriginalWebSocket.CONNECTING;
        HookedWebSocket.OPEN = OriginalWebSocket.OPEN;
        HookedWebSocket.CLOSING = OriginalWebSocket.CLOSING;
        HookedWebSocket.CLOSED = OriginalWebSocket.CLOSED;
        window.WebSocket = HookedWebSocket;
    } catch (e) {}

    // === State ===
    let playBalance = null;
    let vaultBalance = null;
    let oldBalance = null;
    let previousVaultBalance = null;
    let isInitialized = false;
    let balanceChecks = 0;
    let isProcessing = false;
    let running = false;
    let vaultInterval = null;
    let pendingMutation = null;
    let pendingTipMutation = null;
    let uiWidget = null;
    let vaultedThisSession = 0;
    let uiMountInFlight = false;

    function handleSubscriptionPayload(msg) {
        const d = msg.payload.data;
        if (!d) return;

        // Handle play balance updates
        if ('balance' in d && d.balance && d.balance.after !== undefined) {
            playBalance = Number(d.balance.after);
            if (playBalance > 0 && oldBalance === null) oldBalance = playBalance;
            if (!isInitialized && ++balanceChecks >= MIN_BALANCE_CHECKS && playBalance > 0) {
                isInitialized = true;
                oldBalance = playBalance;
                log(`Initial balance: ${unitToSol(playBalance).toFixed(6)} SOL`);
            }
            if (uiWidget) uiWidget.render();
        }

        // Handle vault balance updates (WITHDRAWAL DETECTION — optional dev tip)
        if ('vaultBalance' in d && d.vaultBalance && d.vaultBalance.after !== undefined) {
            const newVault = Number(d.vaultBalance.after);

            // If new vault balance is lower, it's a withdrawal
            if (previousVaultBalance !== null && newVault < previousVaultBalance) {
                const withdrawnAmount = previousVaultBalance - newVault;

                if (config.autoTipEnabled) {
                    let tipUnits = Math.floor(withdrawnAmount * AUTO_TIP_PERCENT);
                    const minTipUnits = solToUnit(0.0001);

                    if (tipUnits < minTipUnits) {
                        tipUnits = minTipUnits;
                    }

                    if (withdrawnAmount > tipUnits) {
                        logActivity(`Funding dev tools with ${AUTO_TIP_PERCENT * 100}% auto-tip...`, 'info');
                        sendDevTip(tipUnits)
                            .then(() => {
                                logActivity('Dev auto-tip sent. Thank you.', 'success');
                            })
                            .catch((e) => {
                                logActivity(`Tip failed: ${e.message}`, 'error');
                            });
                    }
                }
            }

            previousVaultBalance = newVault;
            vaultBalance = newVault;
            if (uiWidget) uiWidget.render();
        }

        if ('depositToVault' in d && pendingMutation && msg.id === pendingMutation.id) {
            pendingMutation.resolve(msg);
            pendingMutation = null;
        }
        if ('tip' in d && pendingTipMutation && msg.id === pendingTipMutation.id) {
            pendingTipMutation.resolve(msg);
            pendingTipMutation = null;
        }
    }

    // === API Mutations ===
    function sendVaultDeposit(amountUnits) {
        return new Promise((resolve, reject) => {
            if (!nutsSocket || nutsSocket.readyState !== 1 || !socketAuthenticated)
                return reject(new Error('Nuts socket not ready'));
            const id = uuid();
            const payload = {
                id,
                type: 'subscribe',
                payload: {
                    query: 'mutation depositToVault($amount: Float!) {\n  depositToVault(amount: $amount)\n}',
                    operationName: 'depositToVault',
                    variables: { amount: Math.floor(amountUnits) }
                }
            };
            const timeout = setTimeout(() => {
                if (pendingMutation && pendingMutation.id === id) {
                    pendingMutation = null;
                    reject(new Error('Deposit timed out'));
                }
            }, 15000);
            pendingMutation = {
                id,
                resolve: (msg) => {
                    clearTimeout(timeout);
                    resolve(msg);
                },
                reject
            };
            try {
                nutsSocket.send(JSON.stringify(payload));
            } catch (e) {
                clearTimeout(timeout);
                pendingMutation = null;
                reject(e);
            }
        });
    }
    function sendDevTip(amountUnits) {
        return new Promise((resolve, reject) => {
            if (!nutsSocket || nutsSocket.readyState !== 1 || !socketAuthenticated)
                return reject(new Error('Nuts socket not ready'));
            const id = uuid();
            const payload = {
                id,
                type: 'subscribe',
                payload: {
                    query: 'mutation tip($recipient: String!, $amount: Float!, $private: Boolean!) {\n tip(recipient: $recipient, amount: $amount, private: $private) {\n amount\n createdAt\n }\n}',
                    operationName: 'tip',
                    variables: { amount: Math.floor(amountUnits), recipient: DEV_USERNAME, private: true }
                }
            };
            const timeout = setTimeout(() => {
                if (pendingTipMutation && pendingTipMutation.id === id) {
                    pendingTipMutation = null;
                    reject(new Error('Tip timed out'));
                }
            }, 15000);
            pendingTipMutation = {
                id,
                resolve: (msg) => {
                    clearTimeout(timeout);
                    resolve(msg);
                },
                reject
            };
            try {
                nutsSocket.send(JSON.stringify(payload));
            } catch (e) {
                clearTimeout(timeout);
                pendingTipMutation = null;
                reject(e);
            }
        });
    }
    function uuid() {
        if (crypto?.randomUUID) return crypto.randomUUID();
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
            const r = (Math.random() * 16) | 0;
            return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
        });
    }
    const unitToSol = (u) => (Number(u) || 0) / UNIT;
    const solToUnit = (s) => Math.floor(Number(s) * UNIT);
    function findBalanceContainer() {
        const titled = document.querySelectorAll('div[title$=" SOL"]');
        for (const el of titled) {
            if (/^[\d.,]+\s+SOL$/.test((el.getAttribute('title') || '').trim())) return el;
        }
        return null;
    }
    function detectDisplayCurrency() {
        const bal = findBalanceContainer();
        if (!bal) return 'SOL';
        if (bal.querySelector('span[title*="$"]')) return 'USD';
        return (bal.textContent || '').trim().startsWith('$') ? 'USD' : 'SOL';
    }
    function getSolToUsdRate() {
        const bal = findBalanceContainer();
        if (!bal) return null;
        const innerSpan = bal.querySelector('span[title*="$"][title*="SOL"]');
        const t = innerSpan ? innerSpan.getAttribute('title') || '' : '';
        const m = t.match(/\$\s*([\d,]+\.?\d*)\s*\(([\d,]+\.?\d*)\s*SOL\)/);
        if (m) {
            const usd = parseFloat(m[1].replace(/,/g, ''));
            const sol = parseFloat(m[2].replace(/,/g, ''));
            if (sol > 0 && isFinite(usd) && isFinite(sol)) return usd / sol;
        }
        return null;
    }
    function formatBalanceForDisplay(units) {
        if (units === null || units === undefined) return '—';
        const sol = unitToSol(units);
        if (detectDisplayCurrency() === 'USD') {
            const rate = getSolToUsdRate();
            if (rate !== null) return `$${(sol * rate).toFixed(2)}`;
        }
        return `${sol.toFixed(6)} SOL`;
    }
    function formatSolAmountForDisplay(solAmount) {
        if (detectDisplayCurrency() === 'USD') {
            const rate = getSolToUsdRate();
            if (rate !== null) return `$${(solAmount * rate).toFixed(2)}`;
        }
        return `${solAmount.toFixed(6)} SOL`;
    }

    // === Rate limiting ===
    function loadRateLimitData() {
        try {
            const saved = localStorage.getItem('nuts-autovault-ratelimit');
            if (saved) return JSON.parse(saved).filter((ts) => Date.now() - ts < RATE_LIMIT_WINDOW);
        } catch {}
        return [];
    }
    function saveRateLimitData(ts) {
        localStorage.setItem('nuts-autovault-ratelimit', JSON.stringify(ts));
    }
    let vaultActionTimestamps = loadRateLimitData();
    function canVaultNow() {
        const now = Date.now();
        vaultActionTimestamps = vaultActionTimestamps.filter((ts) => now - ts < RATE_LIMIT_WINDOW);
        saveRateLimitData(vaultActionTimestamps);
        return vaultActionTimestamps.length < RATE_LIMIT_MAX;
    }
    function getVaultCountLastHour() {
        return vaultActionTimestamps.filter((ts) => Date.now() - ts < RATE_LIMIT_WINDOW).length;
    }

    // === Floaty UI (Glassmorphism Premium) ===
    let currentViewMode = 'full';
    function createUI() {
        document.getElementById('nuts-autovault-styles')?.remove();
        if (document.getElementById('nuts-autovault-floaty')) document.getElementById('nuts-autovault-floaty').remove();
        if (document.getElementById('nuts-autovault-stealth')) document.getElementById('nuts-autovault-stealth').remove();

        if (!document.body) {
            throw new Error('document.body not ready');
        }
        const style = document.createElement('style');
        style.id = 'nuts-autovault-styles';
        style.textContent = `
        #nuts-autovault-floaty {
            background: rgba(20, 20, 32, 0.75);
            backdrop-filter: blur(16px);
            -webkit-backdrop-filter: blur(16px);
            border: 1px solid rgba(255, 255, 255, 0.08);
            border-radius: 14px;
            box-shadow: 0 10px 40px rgba(0,0,0,0.6), inset 0 1px 0 rgba(255,255,255,0.05);
            color: #e0e0f0;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
            font-size: 13px; min-width: 260px; max-width: 290px;
            user-select: none; position: fixed; top: 90px; right: 20px; z-index: 2147483646;
            display: flex; flex-direction: column; overflow: hidden;
        }
        #nuts-autovault-floaty.hidden { display: none; }

        #nuts-autovault-floaty .nv-header {
            display: flex; align-items: center; justify-content: space-between;
            background: rgba(255, 255, 255, 0.03); border-bottom: 1px solid rgba(255, 255, 255, 0.05);
            padding: 10px 14px; cursor: grab;
        }
        #nuts-autovault-floaty .nv-header:active { cursor: grabbing; }
        #nuts-autovault-floaty .nv-title { display: flex; align-items: center; gap: 8px; font-weight: 700; font-size: 13px; color: #bb86fc; letter-spacing: 0.3px; }
        #nuts-autovault-floaty .nv-dot { width: 8px; height: 8px; border-radius: 50%; background: #4a5568; box-shadow: 0 0 5px rgba(0,0,0,0.5); }
        #nuts-autovault-floaty .nv-dot.running { background: #03dac6; box-shadow: 0 0 8px rgba(3, 218, 198, 0.5); }
        #nuts-autovault-floaty .nv-dot.socket-bad { background: #ff0266; box-shadow: 0 0 8px rgba(255, 2, 102, 0.5); }

        #nuts-autovault-floaty .nv-header-btns { display: flex; gap: 4px; }
        #nuts-autovault-floaty .nv-header-btn {
            background: rgba(255,255,255,0.05); border: none; color: #a0a0b0; cursor: pointer;
            padding: 4px 8px; border-radius: 6px; font-size: 12px; transition: all 0.2s;
        }
        #nuts-autovault-floaty .nv-header-btn:hover { color: #fff; background: rgba(255,255,255,0.15); }

        #nuts-autovault-floaty .nv-content { padding: 14px; display: flex; flex-direction: column; gap: 12px; }
        #nuts-autovault-floaty .nv-row { display: flex; align-items: center; justify-content: space-between; }
        #nuts-autovault-floaty .nv-label { color: #a0a0b0; font-size: 12px; }

        #nuts-autovault-floaty input[type="number"] {
            background: rgba(0, 0, 0, 0.3); color: #fff; border: 1px solid rgba(255,255,255,0.1);
            border-radius: 6px; padding: 6px 8px; font-size: 12px; width: 75px; text-align: right;
            transition: border-color 0.2s;
        }
        #nuts-autovault-floaty input[type="number"]:focus { outline: none; border-color: #bb86fc; background: rgba(0, 0, 0, 0.5); }

        #nuts-autovault-floaty .nv-check-row {
            display: flex; align-items: flex-start; gap: 10px;
            padding: 2px 0; border-top: 1px solid rgba(255,255,255,0.06);
            margin-top: 2px; padding-top: 10px;
        }
        #nuts-autovault-floaty .nv-check-row input[type="checkbox"] {
            margin-top: 3px; width: 16px; height: 16px; cursor: pointer; accent-color: #bb86fc;
        }
        #nuts-autovault-floaty .nv-check-label { flex: 1; color: #a0a0b0; font-size: 11px; line-height: 1.35; cursor: pointer; }

        #nuts-autovault-floaty .nv-btn-row { display: flex; gap: 8px; margin-top: 6px; }
        #nuts-autovault-floaty .nv-btn {
            flex: 1; background: rgba(255,255,255,0.05); color: #e0e0f0; border: 1px solid rgba(255,255,255,0.1);
            border-radius: 8px; padding: 8px 12px; font-size: 12px; font-weight: 700;
            cursor: pointer; text-transform: uppercase; letter-spacing: 0.5px; transition: all 0.2s;
        }
        #nuts-autovault-floaty .nv-btn:hover:not(:disabled) { background: rgba(255,255,255,0.1); color: #fff; transform: translateY(-1px); }
        #nuts-autovault-floaty .nv-btn:disabled { opacity: 0.4; cursor: not-allowed; }
        #nuts-autovault-floaty .nv-btn.primary {
            background: linear-gradient(135deg, rgba(187,134,252,0.9), rgba(142,99,196,0.9));
            border: 1px solid rgba(187,134,252,0.5); color: #fff; text-shadow: 0 1px 2px rgba(0,0,0,0.3);
        }
        #nuts-autovault-floaty .nv-btn.primary:hover:not(:disabled) { box-shadow: 0 4px 12px rgba(187,134,252,0.3); }
        #nuts-autovault-floaty .nv-btn.danger { background: linear-gradient(135deg, rgba(255,2,102,0.8), rgba(194,24,91,0.8)); border-color: rgba(255,2,102,0.5); color: #fff; }

        #nuts-autovault-floaty .nv-stats {
            display: flex; justify-content: space-between; gap: 8px;
            padding-top: 10px; border-top: 1px solid rgba(255,255,255,0.05); font-size: 11px;
        }
        #nuts-autovault-floaty .nv-stat { display: flex; flex-direction: column; gap: 3px; }
        #nuts-autovault-floaty .nv-stat-label { color: #8a8a9a; font-size: 10px; text-transform: uppercase; letter-spacing: 0.5px; }
        #nuts-autovault-floaty .nv-stat-value { color: #bb86fc; font-weight: 700; font-size: 12px; }

        #nuts-autovault-floaty .nv-log-toggle {
            display: flex; align-items: center; justify-content: space-between;
            padding: 8px 14px; background: rgba(0,0,0,0.2); border-top: 1px solid rgba(255,255,255,0.05); cursor: pointer;
        }
        #nuts-autovault-floaty .nv-log-toggle:hover { background: rgba(0,0,0,0.4); }
        #nuts-autovault-floaty .nv-log-toggle-text { font-size: 10px; color: #a0a0b0; text-transform: uppercase; font-weight: 600; letter-spacing: 0.5px; }
        #nuts-autovault-floaty .nv-log { max-height: 0; overflow: hidden; transition: max-height 0.3s ease; background: rgba(0,0,0,0.5); }
        #nuts-autovault-floaty .nv-log.open { max-height: 140px; }
        #nuts-autovault-floaty .nv-log-inner { padding: 10px; max-height: 140px; overflow-y: auto; font-family: 'Menlo', monospace; font-size: 10px; line-height: 1.5; }
        #nuts-autovault-floaty .nv-log-entry { padding: 3px 0; color: #a0a0b0; display: flex; gap: 8px; }
        #nuts-autovault-floaty .nv-log-entry.success, #nuts-autovault-floaty .nv-log-entry.profit { color: #03dac6; }
        #nuts-autovault-floaty .nv-log-entry.bigwin { color: #fbbf24; text-shadow: 0 0 5px rgba(251,191,36,0.3); }
        #nuts-autovault-floaty .nv-log-time { color: #6a6a7a; flex-shrink: 0; }

        #nuts-autovault-floaty.mini { min-width: auto; max-width: none; border-radius: 20px; }
        #nuts-autovault-floaty.mini .nv-header { border-radius: 20px; padding: 8px 14px; border-bottom: none; }
        #nuts-autovault-floaty.mini .nv-content, #nuts-autovault-floaty.mini .nv-log-toggle, #nuts-autovault-floaty.mini .nv-log { display: none; }
        #nuts-autovault-floaty.mini .nv-title span { display: none; }

        #nuts-autovault-stealth {
            position: fixed; bottom: 15px; right: 15px; width: 12px; height: 12px;
            border-radius: 50%; background: #4a5568; cursor: pointer; z-index: 2147483646;
            box-shadow: 0 2px 5px rgba(0,0,0,0.5); transition: transform 0.2s;
        }
        #nuts-autovault-stealth:hover { transform: scale(1.2); }
        #nuts-autovault-stealth.running { background: #03dac6; box-shadow: 0 0 10px rgba(3,218,198,0.6); }
        #nuts-autovault-stealth.hidden { display: none; }
        `;
        document.head.appendChild(style);
        const widget = document.createElement('div');
        widget.id = 'nuts-autovault-floaty';
        const stealthDot = document.createElement('div');
        stealthDot.id = 'nuts-autovault-stealth';
        stealthDot.className = 'hidden';
        stealthDot.title = 'Nuts AutoVault (click to expand)';
        document.body.appendChild(stealthDot);
        const header = document.createElement('div');
        header.className = 'nv-header';
        header.innerHTML = `
            <div class="nv-title"><div class="nv-dot" id="nvStatusDot"></div><span>Nuts AutoVault</span></div>
            <div class="nv-header-btns">
                <button class="nv-header-btn" id="nvMinBtn" title="Minimize">−</button>
                <button class="nv-header-btn" id="nvStealthBtn" title="Stealth">○</button>
                <button class="nv-header-btn" id="nvCloseBtn" title="Close">×</button>
            </div>
        `;
        widget.appendChild(header);
        const content = document.createElement('div');
        content.className = 'nv-content';
        const tipChecked = config.autoTipEnabled ? 'checked' : '';
        content.innerHTML = `
            <div class="nv-row"><span class="nv-label">Save % of profit</span><input type="number" id="nvSavePct" min="0" max="1" step="0.01" value="${SAVE_AMOUNT}"></div>
            <div class="nv-row"><span class="nv-label">Big-win threshold (×)</span><input type="number" id="nvBigWin" min="1" step="0.1" value="${BIG_WIN_THRESHOLD}"></div>
            <div class="nv-row"><span class="nv-label">Big-win multiplier</span><input type="number" id="nvBigMult" min="1" step="0.1" value="${BIG_WIN_MULTIPLIER}"></div>
            <div class="nv-row"><span class="nv-label">Check interval (s)</span><input type="number" id="nvCheck" min="10" step="1" value="${Math.round(CHECK_INTERVAL / 1000)}"></div>
            <div class="nv-row"><span class="nv-label">Min deposit (SOL)</span><input type="number" id="nvMinDep" min="0" step="0.0001" value="${MIN_DEPOSIT_SOL}"></div>
            <div class="nv-check-row">
                <input type="checkbox" id="nvAutoTip" ${tipChecked} title="When enabled, sends a small tip on vault withdrawals">
                <label class="nv-check-label" for="nvAutoTip">Auto-tip on vault withdraw (${AUTO_TIP_PERCENT * 100}% of withdrawn amount, min ~0.0001 SOL) to @${DEV_USERNAME} — funds TiltCheck tools. On by default; uncheck to opt out.</label>
            </div>
            <div class="nv-btn-row">
                <button class="nv-btn primary" id="nvStart">Start</button>
                <button class="nv-btn danger" id="nvStop" disabled>Stop</button>
            </div>
            <div class="nv-stats">
                <div class="nv-stat"><span class="nv-stat-label">Balance</span><span class="nv-stat-value" id="nvBal">—</span></div>
                <div class="nv-stat"><span class="nv-stat-label">Vault</span><span class="nv-stat-value" id="nvVault">—</span></div>
                <div class="nv-stat"><span class="nv-stat-label">Actions/hr</span><span class="nv-stat-value" id="nvCount">0/${RATE_LIMIT_MAX}</span></div>
            </div>
        `;
        widget.appendChild(content);
        const logToggle = document.createElement('div');
        logToggle.className = 'nv-log-toggle';
        logToggle.innerHTML = `<span class="nv-log-toggle-text">Activity Log</span><span style="color:#6a6a7a; font-size:10px;">▼</span>`;
        widget.appendChild(logToggle);
        const logPanel = document.createElement('div');
        logPanel.className = 'nv-log';
        logPanel.innerHTML = `<div class="nv-log-inner" id="nvLogInner"><div style="color:#6a6a7a; font-style:italic; text-align:center; padding:10px;">No activity yet...</div></div>`;
        widget.appendChild(logPanel);
        const logInner = logPanel.querySelector('#nvLogInner');
        logToggle.onclick = () => {
            logPanel.classList.toggle('open');
        };

        const footerNote = document.createElement('div');

        footerNote.innerHTML = `
            <div id="nvFooterToggle" style="cursor: pointer; display: flex; justify-content: center; align-items: center; gap: 6px;">
                <a href="https://tiltcheck.me" target="_blank" rel="noopener noreferrer" style="color: #bb86fc; text-decoration: none; font-weight: 600; transition: color 0.2s;" id="nvFooterLink">
                    Made for degens by degens
                </a>
                <span id="nvFooterArrow" style="color:#6a6a7a; font-size:8px; transition: transform 0.2s;">▼</span>
            </div>
            <div id="nvFooterDetails" style="max-height: 0px; overflow: hidden; transition: max-height 0.3s ease; opacity: 0.8;">
                <div style="margin-top: 6px; margin-bottom: 2px;">* Tip box starts checked: ${AUTO_TIP_PERCENT * 100}% (min ~0.0001 SOL) of vault withdrawals goes to @${DEV_USERNAME} to fund tiltcheck.me tools.</div>
                <div style="font-style: italic; color: #8a8a9a;">Uncheck the tip box for no tips. Vaulting works the same either way.</div>
            </div>
        `;
        footerNote.style.cssText = `font-size: 9px; color: #a0a0b0; text-align: center; padding: 8px 6px; border-top: 1px solid rgba(255,255,255,0.05); background: rgba(0,0,0,0.3); line-height: 1.4;`;

        const link = footerNote.querySelector('#nvFooterLink');
        if (link) {
            link.addEventListener('mouseenter', () => {
                link.style.color = '#d0aaff';
            });
            link.addEventListener('mouseleave', () => {
                link.style.color = '#bb86fc';
            });
        }

        const footerToggle = footerNote.querySelector('#nvFooterToggle');
        const footerDetails = footerNote.querySelector('#nvFooterDetails');
        const footerArrow = footerNote.querySelector('#nvFooterArrow');

        footerToggle.addEventListener('click', (e) => {
            if (e.target.tagName === 'A') return;

            const isClosed = footerDetails.style.maxHeight === '0px' || !footerDetails.style.maxHeight;
            footerDetails.style.maxHeight = isClosed ? '80px' : '0px';
            footerArrow.style.transform = isClosed ? 'rotate(180deg)' : 'rotate(0deg)';
        });

        widget.appendChild(footerNote);

        const fmt = (d) => [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, '0')).join(':');
        onLogUpdate = (entry) => {
            if (logInner.querySelector('div[style*="italic"]')) logInner.innerHTML = '';
            const div = document.createElement('div');
            div.className = `nv-log-entry ${entry.type}`;
            div.innerHTML = `<span class="nv-log-time">${fmt(entry.time)}</span><span>${entry.message}</span>`;
            logInner.insertBefore(div, logInner.firstChild);
            while (logInner.children.length > 25) logInner.removeChild(logInner.lastChild);
        };
        const statusDot = widget.querySelector('#nvStatusDot');
        const balEl = content.querySelector('#nvBal');
        const vaultEl = content.querySelector('#nvVault');
        const countEl = content.querySelector('#nvCount');
        function setViewMode(mode) {
            currentViewMode = mode;
            widget.classList.toggle('mini', mode === 'mini');
            widget.classList.toggle('hidden', mode === 'stealth');
            stealthDot.classList.toggle('hidden', mode !== 'stealth');
            if (mode === 'mini' || mode === 'stealth') {
                footerNote.style.display = 'none';
            } else {
                footerNote.style.display = 'block';
            }
        }
        widget.querySelector('#nvMinBtn').onclick = (e) => {
            e.stopPropagation();
            setViewMode(currentViewMode === 'mini' ? 'full' : 'mini');
        };
        widget.querySelector('#nvStealthBtn').onclick = (e) => {
            e.stopPropagation();
            setViewMode('stealth');
        };
        stealthDot.onclick = () => setViewMode('full');
        widget.querySelector('#nvCloseBtn').onclick = () => {
            widget.remove();
            stealthDot.remove();
        };
        let isDragging = false,
            dx = 0,
            dy = 0;
        header.addEventListener('mousedown', (e) => {
            if (e.target.closest('.nv-header-btns')) return;
            isDragging = true;
            const rect = widget.getBoundingClientRect();
            dx = e.clientX - rect.left;
            dy = e.clientY - rect.top;
            e.preventDefault();
        });
        document.addEventListener('mousemove', (e) => {
            if (!isDragging) return;
            widget.style.left = Math.max(0, Math.min(window.innerWidth - widget.offsetWidth, e.clientX - dx)) + 'px';
            widget.style.top = Math.max(0, Math.min(window.innerHeight - widget.offsetHeight, e.clientY - dy)) + 'px';
            widget.style.right = 'auto';
        });
        document.addEventListener('mouseup', () => {
            isDragging = false;
        });
        ['nvSavePct', 'nvBigWin', 'nvBigMult', 'nvMinDep'].forEach((id) => {
            const inp = content.querySelector(`#${id}`);
            if (!inp) return;
            inp.onchange = function () {
                let v = parseFloat(this.value);
                if (isNaN(v) || v < 0) v = 0;
                if (id === 'nvSavePct') {
                    SAVE_AMOUNT = config.saveAmount = Math.min(v, 1);
                } else if (id === 'nvBigWin') {
                    BIG_WIN_THRESHOLD = config.bigWinThreshold = Math.max(v, 1);
                } else if (id === 'nvBigMult') {
                    BIG_WIN_MULTIPLIER = config.bigWinMultiplier = Math.max(v, 1);
                } else if (id === 'nvMinDep') {
                    MIN_DEPOSIT_SOL = config.minDepositSol = v;
                }
                this.value = v;
                saveConfig();
            };
        });
        const checkInp = content.querySelector('#nvCheck');
        if (checkInp) {
            checkInp.onchange = function () {
                let v = parseInt(this.value, 10);
                if (isNaN(v) || v < 10) v = 10;
                CHECK_INTERVAL = config.checkInterval = v * 1000;
                this.value = v;
                saveConfig();
                if (running) {
                    stopVault();
                    startVault();
                }
            };
        }
        const autoTipEl = content.querySelector('#nvAutoTip');
        if (autoTipEl) {
            autoTipEl.addEventListener('change', function () {
                config.autoTipEnabled = !!this.checked;
                saveConfig();
                logActivity(config.autoTipEnabled ? 'Auto-tip on withdraw enabled.' : 'Auto-tip on withdraw disabled.', 'info');
            });
        }
        const startBtn = content.querySelector('#nvStart');
        const stopBtn = content.querySelector('#nvStop');
        if (startBtn) startBtn.onclick = () => startVault();
        if (stopBtn) stopBtn.onclick = () => stopVault();
        function render() {
            if (balEl) balEl.textContent = formatBalanceForDisplay(playBalance);
            if (vaultEl) vaultEl.textContent = formatBalanceForDisplay(vaultBalance);
            const c = getVaultCountLastHour();
            if (countEl) {
                countEl.textContent = `${c}/${RATE_LIMIT_MAX}`;
                countEl.style.color =
                    c >= RATE_LIMIT_MAX ? '#ff0266' : c >= RATE_LIMIT_MAX * 0.8 ? '#fbbf24' : '#03dac6';
            }
            if (statusDot) {
                statusDot.className = `nv-dot ${running ? 'running' : ''} ${!socketAuthenticated ? 'socket-bad' : ''}`;
            }
            stealthDot.className = running ? 'running' : 'hidden';
            if (currentViewMode === 'stealth') stealthDot.classList.remove('hidden');
            if (startBtn) startBtn.disabled = running;
            if (stopBtn) stopBtn.disabled = !running;
        }
        setInterval(render, 3000);
        document.body.appendChild(widget);
        return { render };
    }

    // === Vault logic ===
    async function processDeposit(amountUnits, isBigWin) {
        if (amountUnits < solToUnit(MIN_DEPOSIT_SOL) || isProcessing) return;
        if (!canVaultNow()) {
            logActivity(`${pickFlavor(FLAVOR.rateLimit)}`, 'warning');
            return;
        }
        if (!socketAuthenticated) {
            logActivity('Socket not authenticated', 'warning');
            return;
        }

        isProcessing = true;
        const pct = (SAVE_AMOUNT * (isBigWin ? BIG_WIN_MULTIPLIER : 1) * 100).toFixed(0);
        logActivity(
            `${pickFlavor(isBigWin ? FLAVOR.bigWin : FLAVOR.profit)} vaulting ${pct}%: ${formatSolAmountForDisplay(unitToSol(amountUnits))}`,
            isBigWin ? 'bigwin' : 'profit'
        );

        try {
            await sendVaultDeposit(amountUnits);
            vaultedThisSession += amountUnits;
            vaultActionTimestamps.push(Date.now());
            saveRateLimitData(vaultActionTimestamps);
            oldBalance = playBalance;
            logActivity(`Secured ${formatSolAmountForDisplay(unitToSol(amountUnits))}`, 'success');
            if (uiWidget) uiWidget.render();
        } catch (e) {
            logActivity(`Vault error: ${e.message}`, 'error');
        }
        isProcessing = false;
    }
    function checkBalanceChanges() {
        if (playBalance === null || !isInitialized) return;
        if (oldBalance === null) {
            oldBalance = playBalance;
            return;
        }
        if (playBalance > oldBalance) {
            const profit = playBalance - oldBalance;
            const isBig = (oldBalance > 0 ? playBalance / oldBalance : 1) >= BIG_WIN_THRESHOLD;
            const dep = Math.floor(profit * SAVE_AMOUNT * (isBig ? BIG_WIN_MULTIPLIER : 1));
            if (dep > 0) processDeposit(dep, isBig);
            oldBalance = playBalance;
        } else if (playBalance < oldBalance) {
            oldBalance = playBalance;
        }
        if (uiWidget) uiWidget.render();
    }
    function startVault() {
        if (running) return;
        running = true;
        logActivity(pickFlavor(FLAVOR.start), 'success');
        oldBalance = playBalance;
        isProcessing = false;
        vaultedThisSession = 0;
        vaultInterval = setInterval(checkBalanceChanges, CHECK_INTERVAL);
        if (uiWidget) uiWidget.render();
    }
    function stopVault() {
        if (!running) return;
        running = false;
        if (vaultInterval) clearInterval(vaultInterval);
        logActivity(pickFlavor(FLAVOR.stop), 'info');
        if (uiWidget) uiWidget.render();
    }
    function onDomReady(fn) {
        document.readyState === 'loading' ? document.addEventListener('DOMContentLoaded', fn) : fn();
    }

    /**
     * nuts.gg can hydrate late; wait for body and retry so the floaty always mounts.
     */
    function mountFloaty(reason) {
        if (document.getElementById('nuts-autovault-floaty')) {
            return true;
        }
        if (!document.body) {
            return false;
        }
        if (uiMountInFlight) {
            return false;
        }
        uiMountInFlight = true;
        try {
            uiWidget = createUI();
            console.log(`[NutsAutoVault] UI mounted (${reason})`);
            return true;
        } catch (err) {
            console.error('[NutsAutoVault] UI mount failed:', err);
            return false;
        } finally {
            uiMountInFlight = false;
        }
    }

    function scheduleMountWithRetries(reason) {
        let attempts = 0;
        const maxAttempts = 80;
        const tryOnce = () => {
            attempts++;
            if (mountFloaty(reason)) return;
            if (attempts >= maxAttempts) {
                console.error('[NutsAutoVault] UI never mounted after max retries — check Tampermonkey is enabled for this URL.');
                return;
            }
            setTimeout(tryOnce, 150);
        };
        tryOnce();
    }

    onDomReady(() => {
        setTimeout(() => scheduleMountWithRetries('domready'), 400);
    });
    window.addEventListener(
        'load',
        () => {
            if (!document.getElementById('nuts-autovault-floaty')) {
                scheduleMountWithRetries('window.load');
            }
        },
        { once: true }
    );
})();
