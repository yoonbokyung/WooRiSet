const WEEK = ['일', '월', '화', '수', '목', '금', '토'];

export const pad = (n) => String(n).padStart(2, '0');

export function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export const thisMonth = () => todayStr().slice(0, 7);

/** 'YYYY-MM' 기준 n개월 이동 */
export function addMonths(month, n) {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(y, m - 1 + n, 1);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
}

export const splitMonths = (v) => String(v || '').split(',').map((s) => s.trim()).filter(Boolean);

export const fmtDate = (s) => String(s || '').replaceAll('-', '.');

export function fmtMonth(month) {
  const [y, m] = month.split('-');
  return `${y}년 ${Number(m)}월`;
}

export function fmtDay(date) {
  const [y, m, d] = date.split('-').map(Number);
  return `${m}월 ${d}일 (${WEEK[new Date(y, m - 1, d).getDay()]})`;
}

export const won = (n) => `${Math.round(Number(n) || 0).toLocaleString('ko-KR')}원`;

/** 만원 단위로 떨어지면 '50만원', 아니면 '12,345원' */
export function manwon(n) {
  const v = Number(n) || 0;
  return v !== 0 && v % 10000 === 0 ? `${(v / 10000).toLocaleString('ko-KR')}만원` : won(v);
}

export const sum = (list, fn = (x) => x) => list.reduce((acc, x) => acc + (Number(fn(x)) || 0), 0);

export const parseAmount = (v) => Number(String(v).replace(/[^\d]/g, '')) || 0;

export function parseJson(v, fallback = {}) {
  try {
    return JSON.parse(v) || fallback;
  } catch {
    return fallback;
  }
}

/** 두 날짜('YYYY-MM-DD') 사이 일수 */
export function daysBetween(from, to) {
  const [fy, fm, fd] = from.split('-').map(Number);
  const [ty, tm, td] = to.split('-').map(Number);
  return Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / 86400000);
}

export const byDateDesc = (a, b) => b.date.localeCompare(a.date) || String(b.created_at).localeCompare(String(a.created_at));

export function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
