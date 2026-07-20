﻿// ATCash Simulator - node simulator.js

const https = require('https');
const http  = require('http');
const fs    = require('fs');
const path  = require('path');
const { execSync } = require('child_process');

const PORT      = 44333;
let _dir = __dirname;
try { const {isSea} = require('node:sea'); if(isSea()) _dir = require('path').dirname(process.execPath); } catch(e) {}
if (process.resourcesPath && __dirname.includes('app.asar')) _dir = process.resourcesPath;
if (process.env.APP_DIR) _dir = process.env.APP_DIR;
const CERT_FILE = path.join(_dir, 'cert.pem');
const KEY_FILE  = path.join(_dir, 'key.pem');

// ---------------------------------------------------------------------------
// Estado
// ---------------------------------------------------------------------------
const state = {
  transactionUuid: null,
  startTime:       null,
  requestedAmount: 0,
  insertedAmount:  0,
  insertedItems:   [],
  finalStatus:     null,
  finalErrors:     [],
  finalOutput:     0,
  returnScenario:  'recycler_full_no_error',
  lastChange:      0,
  log:             [],
};

let _currentPath = null;
const _skipLog = ['/v2/heartbeat','/state','/log','/insert-denom','/undo-denom'];

function addLog(msg) {
  const ts = new Date().toTimeString().slice(0, 8);
  const entry = '[' + ts + '] ' + msg;
  state.log.unshift(entry);
  if (state.log.length > 300) state.log.pop();
  console.log(entry);
}

function resetTransaction() {
  state.transactionUuid = null;
  state.startTime       = null;
  state.requestedAmount = 0;
  state.insertedAmount  = 0;
  state.insertedItems   = [];
  state.finalStatus     = null;
  state.finalErrors     = [];
  state.finalOutput     = 0;
}

function fmt(cents) {
  return (cents / 100).toFixed(2) + 'EUR';
}

// ---------------------------------------------------------------------------
// Helpers HTTP
// ---------------------------------------------------------------------------
function parseBody(req) {
  return new Promise(resolve => {
    let b = '';
    req.on('data', c => b += c);
    req.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve({}); } });
  });
}

function send(res, obj, code) {
  code = code || 200;
  const json = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(json) });
  res.end(json);
  if (_currentPath && _skipLog.indexOf(_currentPath) < 0) {
    var _sl = json.length > 180 ? json.slice(0, 177) + ' [...]'  : json;
    var _tsl = new Date().toTimeString().slice(0, 8);
    state.log.unshift('[' + _tsl + '] << ' + _currentPath + '  ' + _sl);
    if (state.log.length > 300) state.log.pop();
  }
}

function parseQuery(url) {
  const i = url.indexOf('?');
  if (i < 0) return {};
  return Object.fromEntries(new URLSearchParams(url.slice(i + 1)));
}

function randomUuid() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
}

// ---------------------------------------------------------------------------
// Denominacoes
// ---------------------------------------------------------------------------
const DENOMS = [
  { v: 1,     label: '1c',   type: 'coin' },
  { v: 2,     label: '2c',   type: 'coin' },
  { v: 5,     label: '5c',   type: 'coin' },
  { v: 10,    label: '10c',  type: 'coin' },
  { v: 20,    label: '20c',  type: 'coin' },
  { v: 50,    label: '50c',  type: 'coin' },
  { v: 100,   label: '1€',   type: 'coin' },
  { v: 200,   label: '2€',   type: 'coin' },
  { v: 500,   label: '5€',   type: 'bill' },
  { v: 1000,  label: '10€',  type: 'bill' },
  { v: 2000,  label: '20€',  type: 'bill' },
  { v: 5000,  label: '50€',  type: 'bill' },
  { v: 10000, label: '100€', type: 'bill' },
  { v: 20000, label: '200€', type: 'bill' },
  { v: 50000, label: '500€', type: 'bill' },
];

// ---------------------------------------------------------------------------
// Cenarios de devolucao/erro
// ---------------------------------------------------------------------------
const RETURN_SCENARIOS = [
  { id: 'recycler_full_no_error',   label: 'Reciclador Cheio (sem erro)',     sub: 'errors=[] — BUG ZSMPOS-8689',   css: 'danger',  tag: 'BUG' },
  { id: 'recycler_full_with_error', label: 'Reciclador Cheio (DeviceIsFull)', sub: 'errors=["DeviceIsFull"]',            css: 'warning', tag: null  },
  { id: 'cashbox_full',             label: 'Cashbox Cheia',                   sub: 'errors=["CashboxIsFull"]',           css: 'warning', tag: null  },
  { id: 'not_enough_money',         label: 'Sem Dinheiro (Hopper)',            sub: 'errors=["HopperNotEnoughMoney"]',    css: 'warning', tag: null  },
  { id: 'no_exact_money',           label: 'Sem Troco Exato',                 sub: 'errors=["NOTEXACTMONEY"]',           css: 'warning', tag: null  },
  { id: 'hopper_jammed',            label: 'Hopper Encravado',                sub: 'errors=["HopperJammed"]',            css: 'warning', tag: null  },
  { id: 'nv_jammed',                label: 'NV Encravado',                    sub: 'errors=["NVJammed"]',                css: 'warning', tag: null  },
  { id: 'machine_locked',           label: 'Bloqueada pelo Admin',             sub: 'errors=["MachineLockedByAdmin"]',    css: 'gray',    tag: null  },
  { id: 'incomplete',               label: 'Op. Incompleta',                  sub: 'errors=["ImcompleteOperation"]',     css: 'gray',    tag: null  },
];

// ---------------------------------------------------------------------------
// Aplicar cenario de devolucao
// ---------------------------------------------------------------------------
function applyReturnScenario(scenarioId, insertedAmount) {
  state.finalStatus = 'COMPLETED_WITH_ERRORS';
  state.finalOutput = 0;
  switch (scenarioId) {
    case 'recycler_full_no_error':   state.finalErrors = [];                      state.finalOutput = insertedAmount; break;
    case 'recycler_full_with_error': state.finalErrors = ['DeviceIsFull'];         state.finalOutput = insertedAmount; break;
    case 'cashbox_full':             state.finalErrors = ['CashboxIsFull'];        state.finalOutput = insertedAmount; break;
    case 'not_enough_money':         state.finalErrors = ['HopperNotEnoughMoney']; break;
    case 'no_exact_money':           state.finalErrors = ['NOTEXACTMONEY'];        break;
    case 'hopper_jammed':            state.finalErrors = ['HopperJammed'];         state.finalOutput = insertedAmount; break;
    case 'nv_jammed':                state.finalErrors = ['NVJammed'];             state.finalOutput = insertedAmount; break;
    case 'machine_locked':           state.finalErrors = ['MachineLockedByAdmin']; break;
    case 'incomplete':               state.finalErrors = ['ImcompleteOperation'];  state.finalOutput = insertedAmount; break;
    default:                         state.finalErrors = [];                       state.finalOutput = insertedAmount;
  }
}

// ---------------------------------------------------------------------------
// operationStatus
// ---------------------------------------------------------------------------
function buildOperationStatus(txUuid) {
  const amt = state.insertedAmount;
  const req = state.requestedAmount;

  const makeItems = function(items) {
    return items.map(function(i) {
      return { count: 1, currency: 'EUR', denomination: i.denomination, currencyType: i.currencyType, uuid: randomUuid() };
    });
  };

  if (state.finalStatus) {
    const st = state.finalStatus;
    addLog('STATUS -> ' + st + ' errors=[' + state.finalErrors + '] output=' + fmt(state.finalOutput));
    const outputItems = state.finalOutput > 0
      ? [{ count: 1, currency: 'EUR', denomination: state.finalOutput, currencyType: 'bill', uuid: randomUuid() }]
      : [];
    return {
      status: st, operationId: txUuid, requestedImport: req,
      totalInput: st === 'COMPLETED' ? amt : 0,
      totalOutput: state.finalOutput, totalFloated: 0,
      errors: state.finalErrors,
      input: st === 'COMPLETED' ? makeItems(state.insertedItems) : [],
      output: outputItems, floated: [],
    };
  }

  addLog('STATUS -> STARTED input=' + fmt(amt) + '/' + fmt(req));
  return {
    status: 'STARTED', operationId: txUuid, requestedImport: req,
    totalInput: amt, totalOutput: 0, totalFloated: 0, errors: [],
    input: makeItems(state.insertedItems), output: [], floated: [],
  };
}

// ---------------------------------------------------------------------------
// Levels simulados
// ---------------------------------------------------------------------------
const levelsData = {
  hopper: [
    { count: 50, currency: 'EUR', denomination: 1   },
    { count: 50, currency: 'EUR', denomination: 2   },
    { count: 50, currency: 'EUR', denomination: 5   },
    { count: 50, currency: 'EUR', denomination: 10  },
    { count: 30, currency: 'EUR', denomination: 20  },
    { count: 30, currency: 'EUR', denomination: 50  },
    { count: 20, currency: 'EUR', denomination: 100 },
    { count: 20, currency: 'EUR', denomination: 200 },
  ],
  hopperCashbox: [],
  nv: [
    { count: 10, currency: 'EUR', denomination: 500   },
    { count: 10, currency: 'EUR', denomination: 1000  },
    { count: 5,  currency: 'EUR', denomination: 2000  },
    { count: 5,  currency: 'EUR', denomination: 5000  },
    { count: 3,  currency: 'EUR', denomination: 10000 },
    { count: 2,  currency: 'EUR', denomination: 20000 },
    { count: 1,  currency: 'EUR', denomination: 50000 },
  ],
  nvCashbox: [], isOutOfService: false,
};

// ---------------------------------------------------------------------------
// Dashboard HTML  AliceSim-inspired UI
// ---------------------------------------------------------------------------
function buildDashboard() {
  var dj = JSON.stringify(DENOMS);
  var sj = JSON.stringify(RETURN_SCENARIOS);

  var css = ''
+ '*{box-sizing:border-box;margin:0;padding:0}\n'
+ ':root{\n'
+ '  --bg:#eef0f4;--surface:#fff;--border:#dde1e8;--border2:#c2c8d4;\n'
+ '  --text:#1a1d23;--muted:#6b7280;--faint:#9ca3af;\n'
+ '  --green:#16a34a;--green-bg:#f0fdf4;--green-bd:#bbf7d0;\n'
+ '  --red:#dc2626;--red-bg:#fef2f2;--red-bd:#fecaca;\n'
+ '  --blue:#2563eb;--blue-bg:#eff6ff;\n'
+ '  --purple:#7c3aed;--purple-bg:#f5f3ff;--purple-bd:#ddd6fe;\n'
+ '  --sh:0 1px 3px rgba(0,0,0,.08),0 1px 2px rgba(0,0,0,.05);\n'
+ '  --r:7px;\n'
+ '}\n'
+ '@media(prefers-color-scheme:dark){:root{\n'
+ '  --bg:#0f1117;--surface:#1c2030;--border:#2a2f3e;--border2:#3a4155;\n'
+ '  --text:#eef0f7;--muted:#8892a4;--faint:#4b5568;\n'
+ '  --green-bg:#052e16;--green-bd:#166534;\n'
+ '  --red-bg:#3b0a0a;--red-bd:#991b1b;\n'
+ '  --blue-bg:#1e3a5f;\n'
+ '  --purple-bg:#2e1065;--purple-bd:#5b21b6;\n'
+ '  --sh:0 1px 4px rgba(0,0,0,.4);\n'
+ '}}\n'
+ ':root[data-theme="light"]{\n'
+ '  --bg:#eef0f4;--surface:#fff;--border:#dde1e8;--border2:#c2c8d4;\n'
+ '  --text:#1a1d23;--muted:#6b7280;--faint:#9ca3af;\n'
+ '  --green-bg:#f0fdf4;--green-bd:#bbf7d0;--red-bg:#fef2f2;--red-bd:#fecaca;\n'
+ '  --blue-bg:#eff6ff;--purple-bg:#f5f3ff;--purple-bd:#ddd6fe;\n'
+ '  --sh:0 1px 3px rgba(0,0,0,.08),0 1px 2px rgba(0,0,0,.05);\n'
+ '}\n'
+ ':root[data-theme="dark"]{\n'
+ '  --bg:#0f1117;--surface:#1c2030;--border:#2a2f3e;--border2:#3a4155;\n'
+ '  --text:#eef0f7;--muted:#8892a4;--faint:#4b5568;\n'
+ '  --green-bg:#052e16;--green-bd:#166534;--red-bg:#3b0a0a;--red-bd:#991b1b;\n'
+ '  --blue-bg:#1e3a5f;--purple-bg:#2e1065;--purple-bd:#5b21b6;\n'
+ '  --sh:0 1px 4px rgba(0,0,0,.4);\n'
+ '}\n'
+ 'body{font-family:"Segoe UI",system-ui,sans-serif;background:var(--bg);color:var(--text);font-size:15px;min-height:100vh}\n'
+ '.hdr{background:var(--surface);border-bottom:1px solid var(--border);display:flex;align-items:center;padding:0 16px;height:42px;gap:10px;box-shadow:var(--sh);position:sticky;top:0;z-index:10}\n'
+ '.hdr-logo{display:flex;align-items:center;gap:8px;font-weight:700;font-size:.92em}\n'
+ '.hdr-sep{width:1px;height:18px;background:var(--border)}\n'
+ '.hdr-btn{background:none;border:1px solid var(--border);border-radius:4px;padding:3px 10px;font-size:.78em;cursor:pointer;color:var(--muted);transition:.12s}\n'
+ '.hdr-btn:hover{border-color:var(--border2);color:var(--text)}\n'
+ '.hdr-right{margin-left:auto;font-size:.75em;color:var(--faint);font-family:"Consolas","Courier New",monospace}\n'
+ '.hdr-right b{color:var(--muted)}\n'
+ '.app{display:grid;grid-template-columns:112px 1fr;height:calc(100vh - 42px);overflow:hidden}\n'
+ '.sidebar{background:var(--surface);border-right:1px solid var(--border);padding:14px 8px;display:flex;flex-direction:column;gap:6px;height:100%;overflow-y:auto}\n'
+ '.sb-btn{padding:11px 6px;border:1px solid var(--border);border-radius:var(--r);font-size:.74em;font-weight:700;cursor:pointer;text-align:center;background:var(--surface);color:var(--text);transition:.15s;line-height:1.4;white-space:pre-line}\n'
+ '.sb-btn:hover:not(:disabled){border-color:var(--border2);background:var(--bg)}\n'
+ '.sb-btn.ok{background:var(--green);color:#fff;border-color:var(--green)}\n'
+ '.sb-btn.ok:hover:not(:disabled){background:#15803d}\n'
+ '.sb-btn.ret{border-color:var(--purple);color:var(--purple)}\n'
+ '.sb-btn.ret:hover:not(:disabled){background:var(--purple-bg)}\n'
+ '.sb-btn:disabled{opacity:.35;cursor:default}\n'
+ '.sb-div{height:1px;background:var(--border);margin:2px 0}\n'
+ '.main{padding:14px;display:flex;flex-direction:column;gap:11px;flex:1;min-height:0;overflow:hidden}\n'
+ '.top-row{display:grid;grid-template-columns:195px 1fr;gap:11px}\n'
+ '.panel{background:var(--surface);border:1px solid var(--border);border-radius:var(--r);padding:13px 15px;box-shadow:var(--sh)}\n'
+ '.ptitle{font-size:.67em;font-weight:700;text-transform:uppercase;letter-spacing:.09em;color:var(--faint);margin-bottom:11px}\n'
+ '.ds-row{display:flex;align-items:center;gap:8px;margin-bottom:7px;font-size:.82em}\n'
+ '.ds-row:last-child{margin-bottom:0}\n'
+ '.ds-lbl{min-width:40px;font-weight:600}\n'
+ '.badge{border-radius:4px;padding:2px 8px;font-size:.7em;font-weight:700;border:1px solid}\n'
+ '.b-ok{background:var(--green-bg);color:var(--green);border-color:var(--green-bd)}\n'
+ '.b-err{background:var(--red-bg);color:var(--red);border-color:var(--red-bd)}\n'
+ '.b-idle{background:var(--bg);color:var(--faint);border-color:var(--border)}\n'
+ '.sc-sel{width:100%;padding:6px 8px;border:1px solid var(--border);border-radius:5px;font-size:.8em;background:var(--bg);color:var(--text);margin-bottom:8px}\n'
+ '.sc-row{display:flex;gap:6px}\n'
+ '.sc-info{flex-shrink:0;padding:5px 11px;border:1px solid var(--border);border-radius:5px;font-size:.78em;cursor:pointer;background:var(--surface);color:var(--muted)}\n'
+ '.sc-info:hover{background:var(--bg)}\n'
+ '.sc-apply{flex:1;padding:5px;border-radius:5px;font-size:.78em;font-weight:700;cursor:pointer;background:var(--purple);color:#fff;border:none;transition:.12s}\n'
+ '.sc-apply:hover{background:#6d28d9}\n'
+ '.sc-apply:disabled{opacity:.35;cursor:default}\n'
+ '.tx-boxes{display:grid;grid-template-columns:1fr 1fr 1fr 1fr;gap:8px;margin-bottom:8px}\n'
+ '.txb{background:var(--bg);border:1px solid var(--border);border-radius:6px;padding:8px 10px}\n'
+ '.txb-lbl{font-size:.62em;text-transform:uppercase;letter-spacing:.07em;color:var(--faint);margin-bottom:3px}\n'
+ '.txb-val{font-size:1.05em;font-weight:700;font-variant-numeric:tabular-nums}\n'
+ '.txb.c-blue .txb-val{color:var(--blue)}\n'
+ '.txb.c-green .txb-val{color:var(--green)}\n'
+ '.txb.c-red .txb-val{color:var(--red)}\n'
+ '.pbar{height:5px;background:var(--border);border-radius:3px;overflow:hidden;margin-bottom:3px}\n'
+ '.pfill{height:100%;background:var(--green);border-radius:3px;transition:width .3s;max-width:100%}\n'
+ '#tx-idle{color:var(--faint);font-size:.82em;font-style:italic;text-align:center;padding:6px 0}\n'
+ '#tx-active{display:none}\n'
+ '.sv-hdr{display:flex;align-items:center;justify-content:space-between;margin-bottom:12px}\n'
+ '.sv-hint{font-size:.7em;color:var(--faint)}\n'
+ '.dg{display:grid;gap:7px;margin-bottom:7px}\n'
+ '.dg.coins{grid-template-columns:repeat(8,1fr)}\n'
+ '.dg.bills{grid-template-columns:repeat(7,1fr)}\n'
+ '.dc{display:flex;flex-direction:column;align-items:center;gap:3px;padding:9px 4px 7px;border:1px solid var(--border);border-radius:8px;background:var(--surface);transition:.12s}\n'
+ '.dc.coin{border-top:2px solid #d4af3760}\n'
+ '.dc.bill{border-top:2px solid #16a34a50}\n'
+ '.dc:not(.off):hover{box-shadow:0 2px 8px rgba(0,0,0,.1);border-top-width:2px}\n'
+ '.dc.off{opacity:.38}\n'
+ '.dc-icon{width:52px;height:52px;display:flex;align-items:center;justify-content:center}\n'
+ '.dc-lbl{font-size:.72em;font-weight:700;margin-top:1px}\n'
+ '.dc-ctrl{display:flex;align-items:center;gap:3px;margin-top:3px}\n'
+ '.dc-pm{width:20px;height:20px;border:1px solid var(--border);border-radius:4px;background:var(--bg);color:var(--text);cursor:pointer;font-size:.9em;font-weight:700;display:flex;align-items:center;justify-content:center;padding:0;line-height:1;transition:.1s}\n'
+ '.dc-pm:hover:not(:disabled){background:var(--border)}\n'
+ '.dc-pm:disabled{opacity:.3;cursor:default}\n'
+ '.dc-spin{width:38px;height:20px;border:1px solid var(--border);border-radius:4px;text-align:center;font-size:.8em;font-variant-numeric:tabular-nums;background:var(--bg);color:var(--text);padding:0}\n'
+ '.dc-sub{display:flex;flex-direction:column;align-items:center;gap:1px}\n'
+ '.dc-rnd{font-size:.63em;color:var(--blue);cursor:pointer;background:none;border:none;text-decoration:underline;padding:0;line-height:1.3}\n'
+ '.dc-rnd:disabled{opacity:.3;cursor:default}\n'
+ '.dc-ins{font-size:.65em;color:var(--faint)}\n'
+ '.dc-ins b{color:var(--text)}\n'
+ '.dc-click{display:flex;flex-direction:column;align-items:center;gap:2px;background:none;border:none;cursor:pointer;padding:4px;border-radius:6px;transition:.12s;width:100%}\n'
+ '.dc-click:hover{background:var(--bg)}\n'
+ '.dc-click:active{transform:scale(.94)}\n'
+ '.dc-click:disabled{opacity:.35;cursor:default;transform:none}\n'
+ '.dc-counts{display:flex;flex-direction:column;align-items:center;gap:1px;margin-top:3px;width:100%}\n'
+ '.dc-cnt-row{display:flex;justify-content:space-between;align-items:center;width:100%;padding:0 3px}\n'
+ '.dc-cnt-lbl{font-size:.6em;color:var(--faint)}\n'
+ '.dc-cnt-val{font-size:.64em;font-weight:700;color:var(--muted);font-variant-numeric:tabular-nums}\n'
+ '.dc-cnt-val.ins{color:var(--green)}\n'
+ '.sv-act{display:flex;justify-content:flex-end;align-items:center;gap:8px;margin-top:6px}\n'
+ '.btn-reset{padding:6px 13px;border:1px solid var(--border);border-radius:5px;font-size:.78em;cursor:pointer;background:var(--surface);color:var(--muted);transition:.12s}\n'
+ '.btn-reset:hover{background:var(--bg)}\n'
+ '.btn-sim{padding:7px 20px;border-radius:5px;font-size:.82em;font-weight:700;cursor:pointer;background:var(--green);color:#fff;border:none;transition:.12s}\n'
+ '.btn-sim:hover:not(:disabled){background:#15803d}\n'
+ '.btn-sim:disabled{opacity:.35;cursor:default}\n'
+ '.bot-row{display:grid;grid-template-columns:195px 1fr;gap:11px;flex-shrink:0}\n'
+ '#svPanel{flex:1;min-height:0;overflow-y:auto}\n'

+ '.simv-row{display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-bottom:1px solid var(--border);font-size:.84em}\n'
+ '.simv-row:last-child{border-bottom:none}\n'
+ '.simv-lbl{font-weight:600}\n'
+ '.simv-val{font-weight:700;font-variant-numeric:tabular-nums;color:var(--muted)}\n'
+ '.simv-row.tot .simv-val{color:var(--blue);font-size:1.05em}\n'
+ '.log-box{font-family:"Consolas","Courier New",monospace;font-size:.72em;height:130px;overflow-y:auto;padding:7px 9px;background:var(--bg);border:1px solid var(--border);border-radius:5px;color:var(--muted)}\n'
+ '.le{padding:1px 0;border-bottom:1px solid transparent}\n'
+ '.le.req{color:#60a5fa}\n'
+ '.le.res{color:#6ee7b7}\n'
+ '.le.req{color:#60a5fa}\n'
+ '.le.res{color:#6ee7b7}\n'
+ '.info-ov{position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:100;display:none;align-items:center;justify-content:center}\n'
+ '.info-ov.open{display:flex}\n'
+ '.info-box{background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:20px 24px;max-width:420px;width:90%;box-shadow:0 8px 32px rgba(0,0,0,.2)}\n'
+ '.info-box h3{font-size:.9em;font-weight:700;margin-bottom:10px}\n'
+ '.info-box p{font-size:.8em;line-height:1.6;color:var(--muted);margin-bottom:6px}\n'
+ '.info-close{margin-top:12px;padding:7px 16px;border-radius:5px;border:1px solid var(--border);background:var(--bg);color:var(--text);font-size:.8em;cursor:pointer}\n'
+ '::-webkit-scrollbar{width:5px;height:5px}\n'
+ '::-webkit-scrollbar-track{background:transparent}\n'
+ '::-webkit-scrollbar-thumb{background:var(--border);border-radius:3px}\n';

  var body = ''
+ '<div class="info-ov" id="infoOv">\n'
+ '  <div class="info-box">\n'
+ '    <h3 id="infoTitle"></h3>\n'
+ '    <p id="infoDesc"></p>\n'
+ '    <p id="infoNote" style="font-size:.75em;background:var(--red-bg);border:1px solid var(--red-bd);border-radius:5px;padding:8px 10px;color:var(--red);display:none"></p>\n'
+ '    <button class="info-close" onclick="document.getElementById(\'infoOv\').classList.remove(\'open\')">Fechar</button>\n'
+ '  </div>\n'
+ '</div>\n'
+ '<header class="hdr">\n'
+ '  <div class="hdr-logo">\n'
+ '    <svg width="22" height="22" viewBox="0 0 22 22" fill="none"><rect width="22" height="22" rx="5" fill="#16a34a"/><path d="M5 14l4-4 3 3 5-6" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>\n'
+ '    ATCash Simulator\n'
+ '  </div>\n'
+ '  <div class="hdr-sep"></div>\n'
+ '  <button class="hdr-btn" onclick="toggleTheme()">Tema</button>\n'
+ '  <div class="hdr-right">Running in <b>https://127.0.0.1:' + PORT + '</b></div>\n'
+ '</header>\n'
+ '<div class="app">\n'
+ '  <aside class="sidebar">\n'
+ '    <button class="sb-btn ok" id="sbFin" onclick="doFinalize(\'complete\')" disabled>Finalizar\nPagamento</button>\n'
+ '    <button class="sb-btn ret" id="sbRet" onclick="doFinalize(\'return\')"   disabled>Devolver\nDinheiro</button>\n'
+ '    <div class="sb-div"></div>\n'
+ '    <button class="sb-btn" id="sbCan" onclick="doCancel()" disabled>Cancelar</button>\n'
+ '  </aside>\n'
+ '  <main class="main">\n'
+ '    <div class="top-row">\n'
+ '      <div class="panel">\n'
+ '        <div class="ptitle">Device Status</div>\n'
+ '        <div class="ds-row"><span class="ds-lbl">Coins</span><span class="badge b-ok">OK</span></div>\n'
+ '        <div class="ds-row"><span class="ds-lbl">Bills</span><span class="badge b-ok">OK</span></div>\n'
+ '        <div class="ds-row"><span class="ds-lbl">API</span><span class="badge b-idle" id="dsApi">IDLE</span></div>\n'
+ '      </div>\n'
+ '      <div class="panel">\n'
+ '        <div class="ptitle">Error or Warning Simulation</div>\n'
+ '        <select class="sc-sel" id="scSel" onchange="selScenario(this.value)"></select>\n'
+ '        <div class="sc-row">\n'
+ '          <button class="sc-info" onclick="showInfo()">Info</button>\n'
+ '          <button class="sc-apply" id="scApply" onclick="doFinalize(\'return\')" disabled>Simular Erro</button>\n'
+ '        </div>\n'
+ '      </div>\n'
+ '    </div>\n'
+ '    <div class="panel">\n'
+ '      <div class="ptitle">Transacao Activa</div>\n'
+ '      <div id="tx-idle">Aguardando chamada POST /v2/pay do ZSRest...</div>\n'
+ '      <div id="tx-active">\n'
+ '        <div class="tx-boxes">\n'
+ '          <div class="txb"><div class="txb-lbl">UUID</div><div class="txb-val" style="font-size:.75em;font-family:monospace" id="txUuid">—</div></div>\n'
+ '          <div class="txb c-blue"><div class="txb-lbl">Pedido</div><div class="txb-val" id="txReq">0,00€</div></div>\n'
+ '          <div class="txb c-green"><div class="txb-lbl">Inserido</div><div class="txb-val" id="txIns">0,00€</div></div>\n'
+ '          <div class="txb c-red"><div class="txb-lbl">Em Falta</div><div class="txb-val" id="txDif">0,00€</div></div>\n'
+ '        </div>\n'
+ '        <div class="pbar"><div class="pfill" id="pfill" style="width:0%"></div></div>\n'
+ '      </div>\n'
+ '    </div>\n'
+ '    <div class="panel" id="svPanel">\n'
+ '      <div class="sv-hdr"><span class="ptitle" style="margin-bottom:0">Select Values</span><span class="sv-hint">Spinner = qtd. a inserir &mdash; clica &#9658; Simulate para aplicar</span></div>\n'
+ '      <div class="dg coins" id="dgCoins"></div>\n'
+ '      <div class="dg bills" id="dgBills"></div>\n'
+ '      <div class="sv-act">\n'
+ '        <button class="btn-reset" onclick="resetSpinners()">Reset Values</button>\n'
+ '        <button class="btn-sim" id="btnSim" onclick="doSimulate()" disabled>&#9658; Simulate</button>\n'
+ '      </div>\n'
+ '    </div>\n'
+ '    <div class="bot-row">\n'
+ '      <div class="panel">\n'
+ '        <div class="ptitle">Simulation Values</div>\n'
+ '        <div class="simv-row"><span class="simv-lbl">Coins</span><span class="simv-val" id="svC">0,00€</span></div>\n'
+ '        <div class="simv-row"><span class="simv-lbl">Bills</span><span class="simv-val" id="svB">0,00€</span></div>\n'
+ '        <div class="simv-row tot"><span class="simv-lbl">Total</span><span class="simv-val" id="svT">0,00€</span></div>\n'
+ '        <div class="simv-row" style="margin-top:10px;border-top:1px solid var(--border);padding-top:8px"><span class="simv-lbl">Troco Devolvido</span><span class="simv-val" id="svChg" style="color:var(--green)">-</span></div>\n'
+ '      </div>\n'
+ '      <div class="panel" style="display:flex;flex-direction:column"><div class="ptitle" style="flex-shrink:0">API Log</div><div class="log-box" id="logBox"></div></div>\n'
+ '    </div>\n'
+ '  </main>\n'
+ '</div>\n';

  var js = ''
+ 'var DENOMS=' + dj + ';\n'
+ 'var SCENARIOS=' + sj + ';\n'
+ 'var curSc="recycler_full_no_error";\n'
+ 'var txActive=false;\n'
+ '\n'
+ 'function coinSvg(d){\n'
+ '  var outer,inner,stroke;\n'
+ '  if(d<=5){outer="#cd7f32";inner="#e8a560";stroke="#7a4a1e";}\n'
+ '  else if(d<=50){outer="#c9a227";inner="#f5d060";stroke="#8a6e0a";}\n'
+ '  else{outer="#b0b0b0";inner="#d4af37";stroke="#7a7a7a";}\n'
+ '  var lbl=d<100?d+"c":(d/100)+"€";\n'
+ '  return \'<svg viewBox="0 0 52 52" width="48" height="48" xmlns="http://www.w3.org/2000/svg">\'\n'
+ '    +\'<defs><radialGradient id="cg\'+d+\'" cx="35%" cy="30%" r="65%"><stop offset="0%" stop-color="\'+inner+\'"/><stop offset="100%" stop-color="\'+outer+\'"/></radialGradient></defs>\'\n'
+ '    +\'<circle cx="26" cy="26" r="24" fill="url(#cg\'+d+\')" stroke="\'+stroke+\'" stroke-width="2"/>\'\n'
+ '    +\'<circle cx="26" cy="26" r="17" fill="none" stroke="\'+stroke+\'" stroke-width=".8" stroke-dasharray="3,2" opacity=".5"/>\'\n'
+ '    +\'<text x="26" y="31" text-anchor="middle" fill="\'+stroke+\'" font-size="11" font-weight="800" font-family="Segoe UI,sans-serif">\'+lbl+\'</text>\'\n'
+ '    +\'</svg>\';\n'
+ '}\n'
+ '\n'
+ 'function billSvg(d){\n'
+ '  var map={500:"#9aada8",1000:"#d4826a",2000:"#6daed4",5000:"#d4a050",10000:"#6dc47a",20000:"#c4b030",50000:"#a070c8"};\n'
+ '  var c=map[d]||"#aaa";\n'
+ '  var lbl=(d/100)+"€";\n'
+ '  return \'<svg viewBox="0 0 86 52" width="78" height="48" xmlns="http://www.w3.org/2000/svg">\'\n'
+ '    +\'<rect x="1" y="1" width="84" height="50" rx="5" fill="\'+c+\'" opacity=".2" stroke="\'+c+\'" stroke-width="2"/>\'\n'
+ '    +\'<rect x="7" y="7" width="72" height="38" rx="3" fill="none" stroke="\'+c+\'" stroke-width="1" opacity=".55"/>\'\n'
+ '    +\'<circle cx="16" cy="16" r="7" fill="\'+c+\'" opacity=".38"/>\'\n'
+ '    +\'<text x="43" y="32" text-anchor="middle" fill="\'+c+\'" font-size="17" font-weight="800" font-family="Segoe UI,sans-serif">\'+lbl+\'</text>\'\n'
+ '    +\'</svg>\';\n'
+ '}\n'
+ '\n'
+ 'function buildGrid(){\n'
+ '  renderGrid("dgCoins",DENOMS.filter(function(d){return d.type==="coin";}),coinSvg);\n'
+ '  renderGrid("dgBills",DENOMS.filter(function(d){return d.type==="bill";}),billSvg);\n'
+ '}\n'
+ '\n'
+ 'function renderGrid(id,items,iconFn){\n'
+ '  var g=document.getElementById(id);\n'
+ '  items.forEach(function(d){\n'
+ '    var cell=document.createElement("div");\n'
+ '    cell.className="dc "+d.type;\n'
+ '    cell.id="cell"+d.v;\n'
+ '    cell.innerHTML=`<button class="dc-click" id="btn${d.v}" onclick="insertOne(${d.v},\'${d.type}\')" disabled><div class="dc-icon">${iconFn(d.v)}</div><span class="dc-lbl">${d.label}</span></button><div class="dc-ctrl"><button class="dc-pm" id="dm${d.v}" onclick="adj(${d.v},-1)" disabled>-</button><input class="dc-spin" type="number" id="sp${d.v}" value="0" min="0" max="99"/><button class="dc-pm" id="dp${d.v}" onclick="adj(${d.v},1)" disabled>+</button></div><div class="dc-counts"><div class="dc-cnt-row"><span class="dc-cnt-lbl">Recycler</span><span class="dc-cnt-val" id="rc${d.v}">-</span></div><div class="dc-cnt-row"><span class="dc-cnt-lbl">Vault</span><span class="dc-cnt-val" id="vc${d.v}">-</span></div><div class="dc-cnt-row"><span class="dc-cnt-lbl">Inserido</span><span class="dc-cnt-val ins" id="ins${d.v}">0</span></div></div>`;\n'
+ '    g.appendChild(cell);\n'
+ '  });\n'
+ '}\n'
+ '\n'
+ 'function buildScenarios(){\n'
+ '  var sel=document.getElementById("scSel");\n'
+ '  SCENARIOS.forEach(function(s){\n'
+ '    var o=document.createElement("option");\n'
+ '    o.value=s.id;\n'
+ '    o.textContent=s.label+(s.tag?" ["+s.tag+"]":"");\n'
+ '    sel.appendChild(o);\n'
+ '  });\n'
+ '  sel.value=curSc;\n'
+ '}\n'
+ '\n'
+ 'function selScenario(id){\n'
+ '  curSc=id;\n'
+ '  fetch("/set-scenario",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({scenario:id})});\n'
+ '}\n'
+ '\n'
+ 'function showInfo(){\n'
+ '  var s=SCENARIOS.find(function(x){return x.id===curSc;});\n'
+ '  if(!s)return;\n'
+ '  document.getElementById("infoTitle").textContent=s.label+(s.tag?" ["+s.tag+"]":"");\n'
+ '  document.getElementById("infoDesc").textContent=s.sub;\n'
+ '  var note=document.getElementById("infoNote");\n'
+ '  if(s.id==="recycler_full_no_error"){\n'
+ '    note.textContent="Este cenario reproduz o bug ZSMPOS-8689: errors=[] e a venda era concluida na mesma. O fix bloqueia a venda mesmo sem erros no array.";\n'
+ '    note.style.display="block";\n'
+ '  } else { note.style.display="none"; }\n'
+ '  document.getElementById("infoOv").classList.add("open");\n'
+ '}\n'
+ '\n'
+ 'function insertOne(v,type){\n'
+ '  fetch(\'/insert-denom\',{method:\'POST\',headers:{\'Content-Type\':\'application/json\'},body:JSON.stringify({denomination:v,currencyType:type})}).then(function(){refreshState();});\n'
+ '}\n'
+ '\n'
+ 'function adj(v,d){\n'
+ '  var sp=document.getElementById("sp"+v);\n'
+ '  sp.value=Math.max(0,Math.min(99,(parseInt(sp.value)||0)+d));\n'
+ '}\n'
+ 'function rnd(v){document.getElementById("sp"+v).value=Math.floor(Math.random()*5)+1;}\n'
+ 'function resetSpinners(){DENOMS.forEach(function(d){var s=document.getElementById("sp"+d.v);if(s)s.value=0;});}\n'
+ '\n'
+ 'function doSimulate(){\n'
+ '  if(!txActive)return;\n'
+ '  var reqs=[];\n'
+ '  DENOMS.forEach(function(d){\n'
+ '    var n=parseInt(document.getElementById("sp"+d.v).value)||0;\n'
+ '    for(var i=0;i<n;i++){\n'
+ '      reqs.push(fetch("/insert-denom",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({denomination:d.v,currencyType:d.type})}));\n'
+ '    }\n'
+ '  });\n'
+ '  Promise.all(reqs).then(function(){resetSpinners();refreshState();});\n'
+ '}\n'
+ '\n'
+ 'function doFinalize(action){\n'
+ '  fetch("/finalize",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({action:action,scenario:curSc})})\n'
+ '    .then(function(){refreshState();});\n'
+ '}\n'
+ 'function doCancel(){fetch("/v2/operationCancel").then(function(){refreshState();});}\n'
+ '\n'
+ 'function fmtE(c){return (c/100).toFixed(2).replace(".",",")+"€";}\n'
+ '\n'
+ 'function refreshState(){\n'
+ '  fetch("/state").then(function(r){return r.json();}).then(function(s){\n'
+ '    txActive=s.txActive;\n'
+ '    var done=txActive&&!!s.finalStatus;\n'
+ '    var api=document.getElementById("dsApi");\n'
+ '    api.textContent=txActive?(s.finalStatus||"STARTED"):"IDLE";\n'
+ '    api.className="badge "+(txActive&&s.finalStatus&&s.finalStatus!=="COMPLETED"?"b-err":txActive?"b-ok":"b-idle");\n'
+ '    document.getElementById("tx-idle").style.display=txActive?"none":"block";\n'
+ '    document.getElementById("tx-active").style.display=txActive?"block":"none";\n'
+ '    if(txActive){\n'
+ '      var ins=s.insertedAmount,req=s.requestedAmount,dif=Math.max(0,req-ins);\n'
+ '      document.getElementById("txUuid").textContent=(s.transactionUuid||"").slice(0,13)+"...";\n'
+ '      document.getElementById("txReq").textContent=fmtE(req);\n'
+ '      document.getElementById("txIns").textContent=fmtE(ins);\n'
+ '      document.getElementById("txDif").textContent=fmtE(dif);\n'
+ '      document.getElementById("pfill").style.width=(req>0?Math.min(100,ins/req*100):0)+"%";\n'
+ '      var dc={};\n'
+ '      (s.insertedItems||[]).forEach(function(i){dc[i.denomination]=(dc[i.denomination]||0)+1;});\n'
+ '      DENOMS.forEach(function(d){var el=document.getElementById("ins"+d.v);if(el)el.textContent=dc[d.v]||0;});\n'
+ '      if(s.levels){DENOMS.forEach(function(d){\n'
+ '        var lv=s.levels[d.v];\n'
+ '        var re=document.getElementById(\'rc\'+d.v);if(re)re.textContent=lv?lv.recycler:\'\u2014\';\n'
+ '        var ve=document.getElementById(\'vc\'+d.v);if(ve)ve.textContent=lv?lv.vault:\'\u2014\';\n'
+ '      });}\n'
+ '      var coins=0,bills=0;\n'
+ '      (s.insertedItems||[]).forEach(function(i){if(i.currencyType==="coin")coins+=i.denomination;else bills+=i.denomination;});\n'
+ '      document.getElementById("svC").textContent=fmtE(coins);\n'
+ '      document.getElementById("svB").textContent=fmtE(bills);\n'
+ '      document.getElementById("svT").textContent=fmtE(coins+bills);\n'
+ '      var chgEl=document.getElementById("svChg");if(chgEl)chgEl.textContent=s.finalStatus==="COMPLETED"&&s.lastChange>0?fmtE(s.lastChange):"-";\n'
+ '    } else {\n'
+ '      var chgEl=document.getElementById("svChg");if(chgEl)chgEl.textContent="-";\n'
+ '      ["svC","svB","svT"].forEach(function(id){document.getElementById(id).textContent="0,00€";});\n'
+ '      DENOMS.forEach(function(d){var el=document.getElementById("ins"+d.v);if(el)el.textContent=0;});\n'
+ '    }\n'
+ '    var canAct=txActive&&!done;\n'
+ '    document.getElementById("sbFin").disabled=!canAct;\n'
+ '    document.getElementById("sbRet").disabled=!txActive;\n'
+ '    document.getElementById("sbCan").disabled=!txActive;\n'
+ '    document.getElementById("scApply").disabled=!txActive;\n'
+ '    document.getElementById("btnSim").disabled=!canAct;\n'
+ '    DENOMS.forEach(function(d){\n'
+ '      ["dm","dp","rnd"].forEach(function(p){var el=document.getElementById(p+d.v);if(el)el.disabled=!canAct;});\n'
+ '      var sp=document.getElementById("sp"+d.v);if(sp)sp.disabled=!canAct;\n'
+ '      var bt=document.getElementById("btn"+d.v);if(bt)bt.disabled=!canAct;\n'
+ '      var c=document.getElementById("cell"+d.v);if(c)c.classList.toggle("off",!canAct);\n'
+ '    });\n'
+ '    var sbFin=document.getElementById("sbFin");\n'
+ '    if(canAct&&s.insertedAmount>0)sbFin.classList.add("ok");else sbFin.classList.remove("ok");\n'
+ '  });\n'
+ '}\n'
+ '\n'
+ 'function refreshLog(){\n'
+ '  fetch("/log").then(function(r){return r.json();}).then(function(e){\n'
+ '    document.getElementById("logBox").innerHTML=e.map(function(x){\n'
+ '      var cl=x.indexOf("] >> ")>0?"le req":x.indexOf("] << ")>0?"le res":"le";\n'
+ '      return `<div class="${cl}">${escHtml(x)}</div>`;\n'
+ '    }).join("");\n'
+ '  });\n'
+ '}\n'
+ '\n'
+ 'function toggleTheme(){\n'
+ '  var r=document.documentElement,cur=r.getAttribute("data-theme");\n'
+ '  var next=cur==="dark"?"light":"dark";\n'
+ '  r.setAttribute("data-theme",next);\n'
+ '  localStorage.setItem("theme",next);\n'
+ '}\n'
+ '(function(){var s=localStorage.getItem("theme");if(s)document.documentElement.setAttribute("data-theme",s);})();\n'
+ '\n'
+ 'function escHtml(s){return s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");}\n'
+ 'try{buildGrid();}catch(e){var eg=document.getElementById("dgCoins");if(eg)eg.innerHTML="<div style=color:red;padding:8px>buildGrid ERROR: "+e.message+"</div>";console.error("buildGrid error:",e);}\n'
+ 'buildScenarios();\n'
+ 'refreshState();\n'
+ 'refreshLog();\n'
+ 'setInterval(refreshState,900);\n'
+ 'setInterval(refreshLog,1800);\n';

  return '<!DOCTYPE html>\n<html lang="pt">\n<head>\n<meta charset="UTF-8">\n<title>ATCash Simulator</title>\n<style>\n'
    + css + '\n</style>\n</head>\n<body>\n' + body + '<script>\n' + js + '</script>\n</body>\n</html>';
}

function buildLevelsMap() {
  var m = {};
  (levelsData.hopper || []).forEach(function(e) { m[e.denomination] = { recycler: e.count, vault: 0 }; });
  (levelsData.nv || []).forEach(function(e) { m[e.denomination] = { recycler: e.count, vault: 0 }; });
  (levelsData.hopperCashbox || []).forEach(function(e) { if (m[e.denomination]) m[e.denomination].vault = e.count; });
  (levelsData.nvCashbox || []).forEach(function(e) { if (m[e.denomination]) m[e.denomination].vault = e.count; });
  return m;
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------
async function router(req, res) {
  const url    = req.url || '/';
  const method = req.method || 'GET';
  const p      = url.split('?')[0];
  const query  = parseQuery(url);

  _currentPath = p;
  if (method !== 'OPTIONS' && _skipLog.indexOf(p) < 0) {
    var _tsr = new Date().toTimeString().slice(0, 8);
    state.log.unshift('[' + _tsr + '] >> ' + method + ' ' + p);
    if (state.log.length > 300) state.log.pop();
  }
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  if (p === '/' && method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(buildDashboard());
  }

  if (p === '/state' && method === 'GET')
    return send(res, {
      txActive:        !!state.transactionUuid,
      transactionUuid: state.transactionUuid,
      requestedAmount: state.requestedAmount,
      insertedAmount:  state.insertedAmount,
      insertedItems:   state.insertedItems,
      finalStatus:     state.finalStatus,
      lastChange:      state.lastChange,
      levels:          buildLevelsMap(),
    });

  if (p === '/log' && method === 'GET')
    return send(res, state.log);

  if (p === '/set-scenario' && method === 'POST') {
    const body = await parseBody(req);
    state.returnScenario = body.scenario || state.returnScenario;
    addLog('>>> Cenario: ' + state.returnScenario);
    return send(res, { ok: true });
  }

  if (p === '/insert-denom' && method === 'POST') {
    const body = await parseBody(req);
    if (state.transactionUuid && !state.finalStatus) {
      const d = parseInt(body.denomination || 0);
      const t = body.currencyType || 'coin';
      state.insertedAmount += d;
      state.insertedItems.push({ denomination: d, currencyType: t });
      addLog('INSERIDO ' + fmt(d) + ' (' + t + ') total=' + fmt(state.insertedAmount) + '/' + fmt(state.requestedAmount));
    }
    return send(res, { ok: true });
  }

  if (p === '/undo-denom' && method === 'POST') {
    if (state.insertedItems.length > 0 && !state.finalStatus) {
      const last = state.insertedItems.pop();
      state.insertedAmount -= last.denomination;
      addLog('REMOVIDO ' + fmt(last.denomination) + ' total=' + fmt(state.insertedAmount));
    }
    return send(res, { ok: true });
  }

  if (p === '/finalize' && method === 'POST') {
    const body = await parseBody(req);
    if (state.transactionUuid && !state.finalStatus) {
      if (body.action === 'complete') {
        const troco = Math.max(0, state.insertedAmount - state.requestedAmount);
        state.finalStatus = 'COMPLETED';
        state.finalErrors = [];
        state.finalOutput = troco;
        state.lastChange   = troco;
        addLog('CONCLUIDO input=' + fmt(state.insertedAmount) + ' troco=' + fmt(troco));
      } else {
        applyReturnScenario(body.scenario || state.returnScenario, state.insertedAmount);
        addLog('DEVOLVIDO cenario=' + (body.scenario || state.returnScenario) + ' output=' + fmt(state.finalOutput));
      }
    }
    return send(res, { ok: true });
  }

  // --- ATCash v2 ---
  if (p === '/v2/login' && method === 'POST') {
    addLog('LOGIN');
    return send(res, { userId: 1, userName: 'admin', accessToken: 'sim-token-' + Date.now() });
  }

  if (p === '/v2/pay' && method === 'POST') {
    const body = await parseBody(req);
    resetTransaction();
    state.transactionUuid = randomUuid();
    state.startTime       = Date.now();
    state.requestedAmount = parseInt(body.amount || 0);
    addLog('PAY ' + fmt(state.requestedAmount) + ' uuid=' + state.transactionUuid.slice(0, 8));
    return send(res, { code: 100, data: state.transactionUuid });
  }

  if (p === '/v2/operationStatus' && method === 'GET') {
    if (!state.transactionUuid) {
      return send(res, {
        cashStatus: {
          billsCashbox: 0, billsStored: 1000, coinsCashbox: 0, coinsStored: 5000,
          collectableBillValue: 0, collectableCoinValue: 0, totalCollectableCash: 0, totalSystemCash: 150000,
          operationStatus: { status: 'NOT_STARTED', operationId: '', requestedImport: 0,
            totalInput: 0, totalOutput: 0, totalFloated: 0, errors: [], input: [], output: [], floated: [] },
        }
      });
    }
    const txUuid = query.uuid || state.transactionUuid;
    return send(res, {
      cashStatus: {
        billsCashbox: 0, billsStored: 1000, coinsCashbox: 0, coinsStored: 5000,
        collectableBillValue: 0, collectableCoinValue: 0, totalCollectableCash: 0, totalSystemCash: 150000,
        operationStatus: buildOperationStatus(txUuid),
      }
    });
  }

  if (p === '/v2/operationCancel' && method === 'GET') {
    addLog('CANCEL');
    resetTransaction();
    return send(res, { code: 100, data: 'OK' });
  }

  if (p === '/v2/levels'              && method === 'GET')  { addLog('LEVELS');         return send(res, levelsData); }
  if (p === '/v2/empty'               && method === 'GET')  { addLog('EMPTY');          return send(res, { code: 100, data: randomUuid() }); }
  if (p === '/v2/collectCash'         && method === 'GET')  { addLog('COLLECT');        return send(res, { code: 100, data: 'OK' }); }
  if (p === '/v2/heartbeat'           && method === 'GET')  {                           return send(res, { status: 'ok' }); }
  if (p === '/v2/reports'             && method === 'GET')  { addLog('REPORTS');        return send(res, []); }
  if (p === '/v2/alerts'              && method === 'GET')  { addLog('ALERTS');         return send(res, []); }
  if (p === '/v2/cashboxReset'        && method === 'GET')  { addLog('CASHBOX RESET');  return send(res, { code: 100, data: 'OK' }); }
  if (p === '/v2/charging'            && method === 'GET')  { addLog('CHARGING');       return send(res, { code: 100, data: randomUuid() }); }
  if (p === '/v2/supplier'            && method === 'GET')  { addLog('GET SUPPLIER');   return send(res, []); }
  if (p === '/v2/supplier'            && method === 'POST') { addLog('CREATE SUPPLIER');return send(res, { code: 100, data: randomUuid() }); }

  if (p === '/v2/entryCash' && method === 'POST') {
    const body = await parseBody(req);
    addLog('ENTRY CASH action=' + body.action);
    resetTransaction();
    state.transactionUuid = randomUuid();
    state.startTime = Date.now();
    return send(res, { code: 100, data: state.transactionUuid });
  }
  if (p === '/v2/payOut' && method === 'POST') {
    const body = await parseBody(req);
    resetTransaction();
    state.transactionUuid = randomUuid();
    state.requestedAmount = parseInt(body.amount || 0);
    state.finalStatus = 'COMPLETED';
    state.finalOutput = state.requestedAmount;
    addLog('PAYOUT ' + fmt(state.requestedAmount));
    return send(res, { code: 100, data: state.transactionUuid });
  }
  if (p === '/v2/changeCash'          && method === 'POST') { const b=await parseBody(req); addLog('CHANGE '+b.action); return send(res,{code:100,data:randomUuid()}); }
  if (p === '/v2/cashboxDenomination' && method === 'POST') { addLog('CASHBOX DENOM'); return send(res,{code:100,data:randomUuid()}); }

  addLog('404 ' + method + ' ' + p);
  send(res, { error: 'Not found' }, 404);
}

// ---------------------------------------------------------------------------
// SSL + Start
// ---------------------------------------------------------------------------
function generateCert() {
  if (fs.existsSync(CERT_FILE) && fs.existsSync(KEY_FILE)) return true;
  const candidates = [
    'C:\\Program Files\\Git\\usr\\bin\\openssl.exe',
    'C:\\Program Files\\Git\\mingw64\\bin\\openssl.exe',
    'openssl',
  ];
  for (const openssl of candidates) {
    try {
      execSync(
        '"' + openssl + '" req -x509 -newkey rsa:2048 -keyout "' + KEY_FILE + '" -out "' + CERT_FILE + '" ' +
        '-days 3650 -nodes -subj "/CN=ATCash Simulator" ' +
        '-addext "subjectAltName=IP:127.0.0.1,DNS:localhost"',
        { stdio: 'pipe' }
      );
      console.log('Certificado SSL gerado.');
      return true;
    } catch(e) { /* tentar proximo */ }
  }
  return false;
}

const hasCert = generateCert();

if (hasCert) {
  const opts = { key: fs.readFileSync(KEY_FILE), cert: fs.readFileSync(CERT_FILE) };
  https.createServer(opts, router).listen(PORT, function() {
    console.log('\nATCash Simulator em https://127.0.0.1:' + PORT + '/');
    console.log('Abre o URL acima no browser para a interface.');
    console.log('Ctrl+C para parar.\n');
    addLog('Simulador iniciado em https://127.0.0.1:' + PORT + '/');
  });
} else {
  http.createServer(router).listen(PORT, function() {
    console.log('\nATCash Simulator em http://127.0.0.1:' + PORT + '/');
    console.log('AVISO: SSL nao disponivel. Instala Git for Windows.\n');
    addLog('Simulador iniciado (sem SSL)');
  });
}
