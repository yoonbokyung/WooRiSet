import { call } from './api.js';

const CACHE_KEY = 'hl_cache';
const TABLES = ['ledgers', 'contracts', 'categories', 'entries', 'records', 'settings', 'inbox'];

export const state = { ledgers: [], contracts: [], categories: [], entries: [], records: [], settings: [], inbox: [], syncedAt: 0 };
export const events = new EventTarget();

/** 화면 다시 그리기 요청 */
export const refresh = () => events.dispatchEvent(new Event('change'));

function saveCache() {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(state));
  } catch {
    /* 저장할 수 없는 환경 */
  }
}

function commit() {
  saveCache();
  refresh();
}

/** 마지막으로 불러온 데이터를 먼저 보여줘서 오프라인에서도 조회 가능 */
export function loadCache() {
  try {
    const saved = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null');
    if (saved) Object.assign(state, saved);
  } catch {
    /* 캐시 없음 */
  }
}

export function clearCache() {
  try {
    localStorage.removeItem(CACHE_KEY);
  } catch {
    /* 저장할 수 없는 환경 */
  }
  TABLES.forEach((t) => { state[t] = []; });
  state.syncedAt = 0;
  refresh();
}

export async function sync() {
  const data = await call('bootstrap');
  TABLES.forEach((t) => { state[t] = data[t] || []; });
  state.syncedAt = Date.now();
  commit();
}

export async function upsert(table, row) {
  const saved = await call('upsert', { table, row });
  const list = state[table];
  const i = list.findIndex((r) => r.id === saved.id);
  if (i >= 0) list[i] = saved;
  else list.push(saved);
  commit();
  return saved;
}

export async function insertMany(table, rows) {
  const saved = await call('insertMany', { table, rows });
  state[table].push(...saved);
  commit();
  return saved;
}

export async function removeMany(table, ids) {
  if (!ids.length) return;
  await call('removeMany', { table, ids });
  const gone = new Set(ids);
  state[table] = state[table].filter((r) => !gone.has(r.id));
  commit();
}

export async function remove(table, id) {
  await call('remove', { table, id });
  state[table] = state[table].filter((r) => r.id !== id);
  if (table === 'ledgers') ['contracts', 'entries', 'records'].forEach((t) => { state[t] = state[t].filter((r) => r.ledger_id !== id); });
  commit();
}

export const byLedger = (table, ledgerId) => state[table].filter((r) => r.ledger_id === ledgerId);

export const categoriesOf = (kind, flow) => state.categories.filter((c) => c.kind === kind && c.flow === flow).sort((a, b) => a.sort - b.sort);

export const tagOf = (kind, name) => state.categories.find((c) => c.kind === kind && c.name === name)?.tag || '';

export const setting = (key) => state.settings.find((s) => s.id === key)?.value || '';

export const saveSetting = (key, value) => upsert('settings', { id: key, value });

/** 기간 메모 [{ from: 'YYYY-MM', to: 'YYYY-MM', label }] — 휴직·이사 등 특별한 기간 표시 */
export function periodNotes() {
  try {
    const list = JSON.parse(setting('period_notes') || '[]');
    return Array.isArray(list) ? list.filter((n) => n.from && n.label) : [];
  } catch {
    return [];
  }
}

export const notesFor = (month) => periodNotes().filter((n) => month >= n.from && month <= (n.to || n.from));
