import { state, tagOf, refresh, setting } from '../store.js';
import { COUPANG_TYPE } from '../coupang.js';
import { esc, thisMonth, addMonths, won, sum, parseJson } from '../utils.js';

/**
 * 리포트 — 가계부 데이터를 다른 각도로 본다 (장부 없이 menu()가 직접 그린다)
 *   고정 지출 : 매달 반복되는 출금을 찾아 월 고정비로 묶는다
 *   육아비   : 은행 육아 지출 + 쿠팡 육아 상품
 *   통장 잔액 : 은행 문자에 찍힌 잔액(ref 마지막 칸)으로 월말 잔액 추이를 그린다
 */

const KIND = 'report';
const TABS = [['fixed', '고정 지출'], ['baby', '육아비'], ['balance', '통장 잔액']];
const RANGES = [[1, '1년'], [3, '3년'], [0, '전체']];
const view = { tab: 'fixed', range: 3 };

const householdEntries = () => {
  const ledger = state.ledgers.find((l) => l.kind === 'household');
  return ledger ? state.entries.filter((e) => e.ledger_id === ledger.id) : [];
};
const tagOfEntry = (e) => tagOf('household', e.category);
const signed = (v) => `${v > 0 ? '▲' : '▼'} ${won(Math.abs(v))}`;
/** 잔액 축·표용 짧은 금액: 1.2억, 650만 */
const short = (v) => (!v ? '0' : Math.abs(v) >= 1e8 ? `${(v / 1e8).toFixed(1).replace(/\.0$/, '')}억` : `${Math.round(v / 1e4).toLocaleString('ko-KR')}만`);
const median = (list) => list.slice().sort((a, b) => a - b)[Math.floor(list.length / 2)];

/* ---------- 고정 지출 ---------- */

// 금액이 매달 달라 '고정'으로 보기 어려운 것은 뺀다
const FIXED_SKIP = ['카드대금', '현금 인출'];
const FIXED_MIN_HITS = 4; // 지난 6개월 중 이만큼 나가면 고정
const FIXED_SPREAD = 0.3; // 달마다 금액이 중앙값에서 이 비율 넘게 흔들리면 고정이 아님 (페이 결제 등)

/** 거래처 이름에서 회차·날짜 같은 숫자를 지워 같은 출금끼리 묶는다 (라이프PL115 → 라이프PL) */
const payeeOf = (e) => String(e.memo || '').replace(/[\d\s,.\-_()]+/g, '').trim() || e.category;

function fixedCosts() {
  const now = thisMonth();
  const recent = Array.from({ length: 6 }, (_, i) => addMonths(now, i - 6)); // 이번 달 제외 지난 6개월
  const quiet = recent.slice(3); // 최근 3개월
  const before = Array.from({ length: 9 }, (_, i) => addMonths(now, i - 12)); // 그 전 9개월
  const groups = new Map();
  householdEntries()
    .filter((e) => e.flow === 'out' && !['transfer', 'asset'].includes(tagOfEntry(e)) && !FIXED_SKIP.includes(e.category))
    .forEach((e) => {
      const key = `${e.category}|${payeeOf(e)}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(e);
    });

  const items = [];
  const stopped = [];
  groups.forEach((list, key) => {
    const [category, name] = key.split('|');
    const byMonth = new Map();
    list.forEach((e) => byMonth.set(e.date.slice(0, 7), (byMonth.get(e.date.slice(0, 7)) || 0) + Number(e.amount)));
    const hits = recent.filter((m) => byMonth.has(m));
    const first = list.reduce((min, e) => (e.date < min ? e.date : min), list[0].date);
    const amounts = hits.map((m) => byMonth.get(m));
    const mid = median(amounts);
    const steady = amounts.filter((v) => Math.abs(v - mid) <= mid * FIXED_SPREAD).length >= FIXED_MIN_HITS;
    // 화면에는 숫자를 지운 키 대신 가장 최근 거래처 이름을 그대로 보여준다
    const latest = list.reduce((a, e) => (e.date > a.date ? e : a), list[0]);
    if (hits.length >= FIXED_MIN_HITS && steady) {
      const amount = byMonth.get(hits[hits.length - 1]);
      items.push({
        name: latest.memo || name,
        category,
        saving: tagOfEntry(list[0]) === 'saving',
        amount,
        change: amount - byMonth.get(hits[0]),
        hits: hits.length,
        day: median(list.filter((e) => recent.includes(e.date.slice(0, 7))).map((e) => Number(e.date.slice(8)))),
        isNew: first >= `${recent[0]}-01`,
      });
    } else if (latest.date < `${quiet[0]}-01` && before.filter((m) => byMonth.has(m)).length >= 3) {
      stopped.push({ name: latest.memo || name, category, amount: byMonth.get(latest.date.slice(0, 7)), last: latest.date });
    }
  });
  const byAmount = (a, b) => b.amount - a.amount;
  return { costs: items.filter((i) => !i.saving).sort(byAmount), savings: items.filter((i) => i.saving).sort(byAmount), stopped: stopped.sort(byAmount) };
}

const fixedRow = (i) => `
  <li class="report_row">
    <div class="report_row_body">
      <p class="report_row_name">${esc(i.name)}${i.isNew ? ' <span class="badge">새로 생김</span>' : ''}</p>
      <p class="report_row_sub">${esc(i.category)} · 매월 ${i.day}일쯤 · 6개월 중 ${i.hits}번</p>
    </div>
    <div class="report_row_value">
      <strong>${won(i.amount)}</strong>
      ${i.change ? `<span class="report_change ${i.change > 0 ? 'is_up' : 'is_down'}">6개월 사이 ${signed(i.change)}</span>` : ''}
    </div>
  </li>`;

function fixedHtml() {
  const { costs, savings, stopped } = fixedCosts();
  if (!costs.length && !savings.length) return '<p class="empty">매달 반복되는 출금을 아직 찾지 못했어요</p>';
  return `
    <section class="card">
      <p class="hero_label">매달 고정으로 나가는 돈</p>
      <p class="hero_value">${won(sum(costs, (i) => i.amount))}</p>
      <p class="hero_sub">고정 저축 ${won(sum(savings, (i) => i.amount))}은 따로 · 지난 6개월 중 ${FIXED_MIN_HITS}번 이상 비슷한 금액으로 나간 출금 기준 (카드대금·현금 인출 제외)</p>
    </section>
    ${costs.length ? `
      <section class="card">
        <h2 class="card_title">고정 지출 <span class="field_hint">${costs.length}개</span></h2>
        <ul class="report_list">${costs.map(fixedRow).join('')}</ul>
      </section>` : ''}
    ${savings.length ? `
      <section class="card">
        <h2 class="card_title">고정 저축·투자 <span class="field_hint">${savings.length}개</span></h2>
        <ul class="report_list">${savings.map(fixedRow).join('')}</ul>
      </section>` : ''}
    ${stopped.length ? `
      <section class="card">
        <h2 class="card_title">최근 멈춘 정기 출금 <span class="field_hint">최근 3개월 안 나감</span></h2>
        <ul class="report_list">${stopped.map((i) => `
          <li class="report_row">
            <div class="report_row_body">
              <p class="report_row_name">${esc(i.name)}</p>
              <p class="report_row_sub">${esc(i.category)} · 마지막 ${i.last.replaceAll('-', '.')}</p>
            </div>
            <div class="report_row_value"><strong>${won(i.amount)}</strong></div>
          </li>`).join('')}</ul>
      </section>` : ''}`;
}

/* ---------- 육아비 ---------- */

const BABY_GROUPS = [
  [/기저귀|하기스|물티슈|건티슈/, '기저귀·물티슈'],
  [/분유|이유식|퓨레|치즈|요거트|곡물바|간식|젤리|츄러스|김$|과자/, '분유·이유식·간식'],
  [/우주복|롬퍼|바디수트|내의|레깅스|점퍼|모자|비니|양말|신발|운동화|턱받이|실내복|상하|원피스|장갑|옷/, '옷·신발'],
  [/장난감|토이|놀이|사운드북|팝업북|책|퍼즐|인형|딸랑이|모빌|킥보드|붕붕카|보행기|카드|비지북|스티커/, '장난감·책'],
  [/젖병|젖꼭지|노리개|치발기|컵|식기|용기|조리|분유포트|칫솔|세척/, '수유·식사 용품'],
];
const babyGroupOf = (title) => (BABY_GROUPS.find(([re]) => re.test(title)) || [null, '기타 육아용품'])[1];

function babyItems() {
  const bank = householdEntries()
    .filter((e) => e.flow === 'out' && e.category === '육아')
    .map((e) => ({ date: e.date, amount: Number(e.amount), group: '계좌 결제 (가게·병원 등)', title: e.memo }));
  const coupang = state.records
    .filter((r) => r.type === COUPANG_TYPE)
    .map((r) => ({ ...parseJson(r.data, {}), date: r.date, title: r.title }))
    .filter((r) => r.category === '육아')
    .map((r) => ({ date: r.date, amount: Number(r.amount), qty: Number(r.qty) || 1, group: babyGroupOf(r.title), title: r.title, coupang: true }));
  return [...bank, ...coupang];
}

/** rows: [이름, 금액, 표시 문구] → 가로 막대 (common .cat_bars) */
const bars = (rows) => {
  const max = Math.max(...rows.map((r) => r[1]), 1);
  return rows.map(([name, value, label]) => `
    <li>
      <div class="cat_bar_head"><span class="cat_bar_name">${esc(name)}</span><span class="cat_bar_value">${label || won(value)}</span></div>
      <div class="cat_bar_track"><div class="cat_bar_fill" style="width:${((value / max) * 100).toFixed(1)}%"></div></div>
    </li>`).join('');
};

function babyHtml() {
  const items = babyItems();
  if (!items.length) return '<p class="empty">육아 지출이 아직 없어요</p>';
  const now = thisMonth();
  const year = now.slice(0, 4);
  const thisYear = items.filter((i) => i.date.startsWith(year));
  const lastYearSame = items.filter((i) => i.date.startsWith(String(year - 1)) && i.date.slice(5, 7) <= now.slice(5));
  const total = sum(thisYear, (i) => i.amount);
  const diff = total - sum(lastYearSame, (i) => i.amount);
  const months = Array.from({ length: 12 }, (_, i) => addMonths(now, i - 11));
  const monthly = months.map((m) => [`${m.slice(2, 4)}.${m.slice(5)}`, sum(items.filter((i) => i.date.startsWith(m)), (i) => i.amount)]);
  const groups = new Map();
  thisYear.forEach((i) => groups.set(i.group, (groups.get(i.group) || 0) + i.amount));

  // 자주 산 상품: 쿠팡 상품명이 같은 것끼리, 단가(금액 ÷ 수량) 변화도 본다
  const products = new Map();
  items.filter((i) => i.coupang).sort((a, b) => a.date.localeCompare(b.date)).forEach((i) => {
    if (!products.has(i.title)) products.set(i.title, []);
    products.get(i.title).push(i);
  });
  const top = [...products].filter(([, list]) => list.length >= 2).sort((a, b) => b[1].length - a[1].length).slice(0, 5);
  const unit = (i) => Math.round(i.amount / i.qty);

  return `
    <section class="card">
      <p class="hero_label">${year}년 육아비</p>
      <p class="hero_value">${won(total)}</p>
      <p class="hero_sub">월평균 ${won(Math.round(total / Number(now.slice(5))))}${lastYearSame.length ? ` · 작년 같은 기간보다 ${won(Math.abs(diff))} ${diff >= 0 ? '더 썼어요' : '덜 썼어요'}` : ''}</p>
      <p class="hero_sub">은행 육아 지출 + 쿠팡 육아 상품 (쿠팡은 주문한 달 기준)</p>
    </section>
    <section class="card">
      <h2 class="card_title">최근 12개월</h2>
      <ul class="cat_bars">${bars(monthly)}</ul>
    </section>
    ${groups.size ? `
      <section class="card">
        <h2 class="card_title">${year}년 항목별</h2>
        <ul class="cat_bars">${bars([...groups].sort((a, b) => b[1] - a[1]).map(([name, value]) => [name, value, `${won(value)} · ${Math.round((value / total) * 100)}%`]))}</ul>
      </section>` : ''}
    ${top.length ? `
      <section class="card">
        <h2 class="card_title">자주 산 육아용품 <span class="field_hint">쿠팡</span></h2>
        <ul class="report_list">${top.map(([title, list]) => {
          const change = unit(list[list.length - 1]) - unit(list[0]);
          return `
            <li class="report_row">
              <div class="report_row_body">
                <p class="report_row_name">${esc(title)}</p>
                <p class="report_row_sub">${list.length}번 구매 · 마지막 ${list[list.length - 1].date.replaceAll('-', '.')}</p>
              </div>
              <div class="report_row_value">
                <strong>${won(unit(list[list.length - 1]))}</strong>
                ${change ? `<span class="report_change ${change > 0 ? 'is_up' : 'is_down'}">처음보다 ${signed(change)}</span>` : '<span class="report_change">가격 그대로</span>'}
              </div>
            </li>`;
        }).join('')}</ul>
      </section>` : ''}`;
}

/* ---------- 통장 잔액 ---------- */

/** 은행 문자 ref 'kb|계좌|시각|금액|잔액1,234' → 통장별 [{ t, bal }] (받은 순서) */
function balancePoints() {
  const byAccount = new Map();
  householdEntries().forEach((e) => {
    const p = String(e.ref || '').split('|');
    if (p[0] !== 'kb' || p.length !== 5 || !p[4].startsWith('잔액')) return;
    // 예전 ref는 받은 시각(ms), 지금 ref는 'YYYY-MM-DD HH:MM'
    const t = /^\d{13}$/.test(p[2]) ? Number(p[2]) : Date.parse(`${p[2].replace(' ', 'T')}:00+09:00`);
    const account = e.account || p[1];
    if (!byAccount.has(account)) byAccount.set(account, []);
    byAccount.get(account).push({ t, month: e.date.slice(0, 7), bal: Number(p[4].replace(/[^\d-]/g, '')) });
  });
  const order = parseJson(setting('bank_accounts'), []).map((a) => a.name);
  return [...byAccount]
    .map(([name, list]) => [name, list.sort((a, b) => a.t - b.t)])
    .sort((a, b) => (order.indexOf(a[0]) + 1 || 99) - (order.indexOf(b[0]) + 1 || 99));
}

/** 통장별 월말 잔액 (문자가 없는 달은 직전 잔액 유지) */
function monthlyBalances(points) {
  const start = points.map(([, list]) => list[0].month).sort()[0];
  const months = [];
  for (let m = start; m <= thisMonth(); m = addMonths(m, 1)) months.push(m);
  const series = points.map(([name, list], index) => {
    const last = new Map(list.map((p) => [p.month, p.bal]));
    let bal = null;
    return { name, index, values: months.map((m) => (last.has(m) ? (bal = last.get(m)) : bal)), latest: list[list.length - 1] };
  });
  return { months, series };
}

const CHART = { w: 340, h: 180, left: 45, right: 10, top: 10, bottom: 25 };

function chartSvg(months, series) {
  const all = series.flatMap((s) => s.values).filter((v) => v !== null);
  // 축은 보기 좋은 단위로 올림 (마이너스통장이면 아래로도 연다)
  const nice = (v) => {
    const unit = 10 ** Math.floor(Math.log10(Math.abs(v) || 1));
    return Math.ceil(Math.abs(v) / unit) * unit * Math.sign(v);
  };
  const top = nice(Math.max(...all, 1));
  const bottom = Math.min(...all) < 0 ? -nice(-Math.min(...all)) : 0;
  const x = (i) => CHART.left + (i / Math.max(months.length - 1, 1)) * (CHART.w - CHART.left - CHART.right);
  const y = (v) => CHART.top + (1 - (v - bottom) / (top - bottom)) * (CHART.h - CHART.top - CHART.bottom);
  // 음수 구간이 좁으면 그 눈금 글자는 0과 겹치므로 생략
  const ticks = [...(bottom && -bottom / (top - bottom) > 0.2 ? [bottom] : []), 0, top / 2, top];
  const jan = months.map((m, i) => [m, i]).filter(([m]) => m.endsWith('-01'));
  const years = jan.length ? jan : [[months[0], 0]];
  const step = Math.ceil(years.length / 6);
  const path = (s) => s.values.map((v, i) => (v === null ? null : `${x(i).toFixed(1)},${y(v).toFixed(1)}`)).filter(Boolean).join(' ');
  return `
    <svg class="balance_svg" viewBox="0 0 ${CHART.w} ${CHART.h}" role="img" aria-label="통장별 월말 잔액 추이">
      ${ticks.map((v) => `<line class="balance_grid" x1="${CHART.left}" x2="${CHART.w - CHART.right}" y1="${y(v)}" y2="${y(v)}"/><text class="balance_axis" x="${CHART.left - 5}" y="${y(v) + 4}" text-anchor="end">${short(v)}</text>`).join('')}
      ${years.filter((_, i) => i % step === 0).map(([m, i]) => `<text class="balance_axis" x="${x(i)}" y="${CHART.h - 5}" text-anchor="middle">${m.slice(2, 4)}년</text>`).join('')}
      ${series.map((s) => `<polyline class="balance_line is_acc${(s.index % 2) + 1}" points="${path(s)}"/>`).join('')}
      ${series.map((s) => {
        const i = s.values.length - 1;
        return s.values[i] === null ? '' : `<circle class="balance_dot is_acc${(s.index % 2) + 1}" cx="${x(i)}" cy="${y(s.values[i])}" r="4"/>`;
      }).join('')}
      <line class="balance_cross" y1="${CHART.top}" y2="${CHART.h - CHART.bottom}" x1="0" x2="0" visibility="hidden"/>
      <rect class="balance_hit" x="${CHART.left}" y="0" width="${CHART.w - CHART.left - CHART.right}" height="${CHART.h}" fill="transparent"/>
    </svg>`;
}

function balanceHtml() {
  const points = balancePoints();
  if (!points.length) return '<p class="empty">잔액이 들어 있는 은행 문자 내역이 없어요</p>';
  const all = monthlyBalances(points);
  const from = view.range ? Math.max(all.months.length - view.range * 12, 0) : 0;
  const months = all.months.slice(from);
  const series = all.series.map((s) => ({ ...s, values: s.values.slice(from) }));
  const yearAgo = (s) => s.values[s.values.length - 13];
  const total = sum(all.series, (s) => s.latest.bal);
  const yearEnds = all.months.filter((m) => m.endsWith('-12') || m === thisMonth()).reverse();

  return `
    <section class="card">
      <p class="hero_label">국민은행 통장 잔액 합계</p>
      <p class="hero_value">${won(total)}</p>
      <div class="stat_grid">
        ${all.series.map((s) => `
          <div class="stat_item">
            <p class="stat_label"><span class="account_tag is_acc${(s.index % 2) + 1}">${esc(s.name)}</span></p>
            <p class="stat_value">${won(s.latest.bal)}</p>
            <p class="stat_sub">${yearAgo(s) !== undefined && yearAgo(s) !== null ? `1년 전보다 ${signed(s.latest.bal - yearAgo(s))}` : `${s.latest.month.replace('-', '.')} 기준`}</p>
          </div>`).join('')}
      </div>
    </section>
    <section class="card">
      <h2 class="card_title">월말 잔액 추이</h2>
      <div class="chip_row report_range">
        ${RANGES.map(([value, label]) => `<button type="button" class="chip${view.range === value ? ' is_active' : ''}" data-range="${value}" aria-pressed="${view.range === value}">${label}</button>`).join('')}
      </div>
      <div class="balance_chart" data-months='${JSON.stringify(months)}' data-series='${esc(JSON.stringify(series.map((s) => ({ name: s.name, index: s.index, values: s.values }))))}'>
        ${chartSvg(months, series)}
        <div class="balance_tip" hidden></div>
      </div>
      <ul class="balance_legend">
        ${series.map((s) => `<li class="balance_legend_item is_acc${(s.index % 2) + 1}">${esc(s.name)} <strong>${short(s.values[s.values.length - 1] || 0)}</strong></li>`).join('')}
      </ul>
      <details class="import_details">
        <summary>연말 잔액 표로 보기</summary>
        <table class="year_table">
          <thead><tr><th scope="col">연도</th>${all.series.map((s) => `<th scope="col">${esc(s.name)}</th>`).join('')}<th scope="col">합계</th></tr></thead>
          <tbody>
            ${yearEnds.map((m) => {
              const i = all.months.indexOf(m);
              const values = all.series.map((s) => s.values[i] || 0);
              return `<tr><th scope="row">${m === thisMonth() ? '지금' : m.slice(0, 4)}</th>${values.map((v) => `<td>${short(v)}</td>`).join('')}<td>${short(sum(values, (v) => v))}</td></tr>`;
            }).join('')}
          </tbody>
        </table>
      </details>
      <p class="field_hint report_note">국민은행 입출금 문자에 찍힌 잔액이에요. 문자가 없는 달은 직전 잔액으로 이어 그려요.</p>
    </section>`;
}

/** 그래프 위를 누르거나 움직이면 그 달 잔액을 보여준다 */
function bindChart(el) {
  const box = el.querySelector('.balance_chart');
  if (!box) return;
  const months = JSON.parse(box.dataset.months);
  const series = JSON.parse(box.dataset.series);
  const svg = box.querySelector('svg');
  const cross = svg.querySelector('.balance_cross');
  const tip = box.querySelector('.balance_tip');
  const plotW = CHART.w - CHART.left - CHART.right;
  const show = (e) => {
    const rect = svg.getBoundingClientRect();
    const vx = ((e.clientX - rect.left) / rect.width) * CHART.w;
    const i = Math.min(Math.max(Math.round(((vx - CHART.left) / plotW) * (months.length - 1)), 0), months.length - 1);
    const cx = CHART.left + (i / Math.max(months.length - 1, 1)) * plotW;
    cross.setAttribute('x1', cx);
    cross.setAttribute('x2', cx);
    cross.setAttribute('visibility', 'visible');
    tip.innerHTML = `<strong>${months[i].replace('-', '.')}</strong>${series.map((s) => `<span class="balance_tip_row is_acc${(s.index % 2) + 1}">${esc(s.name)} ${s.values[i] === null ? '-' : won(s.values[i])}</span>`).join('')}`;
    tip.hidden = false;
    // 말풍선은 막대 위치를 따라가되 양 끝에서 잘리지 않게 25~75% 안에 둔다 (위치 이동은 transform)
    const ratio = Math.min(Math.max(cx / CHART.w, 0.25), 0.75);
    tip.style.transform = `translateX(${(ratio * box.clientWidth).toFixed(0)}px) translateX(-50%)`;
  };
  const hide = () => {
    cross.setAttribute('visibility', 'hidden');
    tip.hidden = true;
  };
  const hit = svg.querySelector('.balance_hit');
  hit.addEventListener('pointermove', show);
  hit.addEventListener('pointerdown', show);
  hit.addEventListener('pointerleave', hide);
}

/* ---------- 메뉴 ---------- */

function menu() {
  const body = { fixed: fixedHtml, baby: babyHtml, balance: balanceHtml }[view.tab]();
  return {
    html: `
      <div class="chip_row report_tabs" role="tablist">
        ${TABS.map(([key, label]) => `<button type="button" class="chip${view.tab === key ? ' is_active' : ''}" role="tab" data-tab="${key}" aria-selected="${view.tab === key}">${label}</button>`).join('')}
      </div>
      ${body}`,
    mount(el) {
      bindChart(el);
      el.addEventListener('click', (e) => {
        const target = e.target.closest('[data-tab],[data-range]');
        if (!target) return;
        if (target.dataset.tab) view.tab = target.dataset.tab;
        if (target.dataset.range) view.range = Number(target.dataset.range);
        refresh();
      });
    },
  };
}

export default {
  kind: KIND,
  label: '리포트',
  nav: 'chart',
  description: '고정 지출·육아비·통장 잔액을 한눈에 봐요',
  widget: () => '',
  menu,
};
