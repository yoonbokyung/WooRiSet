import { state, byLedger, refresh, tagOf, setting, saveSetting, insertMany, removeMany, notesFor } from '../store.js';
import { getConfig } from '../config.js';
import { openEntryForm } from '../forms.js';
import { openSheet, runTask, toast } from '../ui.js';
import { extractSms, splitSmsText, parseKbSms, classify, applyPayrollDeductions, refKey, KB_SENDER } from '../sms_rules.js';
import { buildCoupangRecords, COUPANG_TYPE } from '../coupang.js';
import { ICONS } from '../icons.js';
import { esc, pad, todayStr, thisMonth, addMonths, fmtMonth, fmtDay, fmtDate, won, sum, byDateDesc, parseJson } from '../utils.js';

const KIND = 'household';
const TOP_CATEGORIES = 3;
const TREND_MONTHS = 6;
const IMPORT_CHUNK = 500;
const viewMonth = new Map(); // 장부별로 보고 있는 월
const viewAccount = new Map(); // 장부별 계좌 필터
const viewMode = new Map(); // 장부별 보기 방식 (month | year)
const viewYear = new Map(); // 장부별로 보고 있는 해

const monthOf = (ledgerId) => viewMonth.get(ledgerId) || thisMonth();

/**
 * 카테고리 tag
 * - transfer : 내 계좌·가족 간 이동 → 수입·지출에서 제외
 * - asset    : 목돈(집·차·가족 간 큰돈) → 생활 수입·지출에서 제외
 * - saving   : 저축·투자 → 지출과 따로 집계
 * - refund   : 환급·환불(보험금·결제 취소) → 수입이 아니라 이미 쓴 돈이 돌아온 것이므로 생활 지출에서 뺀다
 */
const tagOfEntry = (e) => tagOf(KIND, e.category);

/** 월세 메뉴의 월세 입금 (가계부에는 중복 방지를 위해 넣지 않고 합계에만 더한다) */
function rentEntriesOf(month) {
  const rentLedgers = new Set(state.ledgers.filter((l) => l.kind === 'rent').map((l) => l.id));
  return state.entries.filter((e) => rentLedgers.has(e.ledger_id) && e.flow === 'in' && e.date.startsWith(month) && tagOf('rent', e.category) === 'rent');
}

/** 쿠팡 결제가 들어 있는 덩어리 내역: 생활비 이체 + 설정한 카드(coupang_card)의 카드대금 */
function isCoupangPool(e) {
  if (e.flow !== 'out') return false;
  if (e.category === '생활비 이체') return true;
  const card = setting('coupang_card');
  return e.category === '카드대금' && (!card || String(e.memo).includes(card));
}

/**
 * 쿠팡 주문을 같은 달(주문일 기준) 덩어리에서 떼어 실제 카테고리로 옮긴다.
 * 옮기는 금액은 그 달 덩어리 합계를 넘지 않으므로 생활 지출 총액은 그대로다.
 */
function coupangShift(ledgerId, months) {
  const delta = new Map();
  const items = [];
  let moved = 0;
  const add = (category, value) => delta.set(category, (delta.get(category) || 0) + value);
  const orders = byLedger('records', ledgerId).filter((r) => r.type === COUPANG_TYPE);
  if (!orders.length) return { delta, items, moved };
  months.forEach((m) => {
    const list = orders.filter((r) => r.date.startsWith(m)).map((r) => ({ ...r, ...parseJson(r.data, {}) }));
    if (!list.length) return;
    const pool = byLedger('entries', ledgerId).filter((e) => e.date.startsWith(m) && isCoupangPool(e));
    const poolTotal = sum(pool, (e) => e.amount);
    const total = sum(list, (o) => o.amount);
    const take = Math.min(total, poolTotal);
    if (!take) return;
    list.forEach((o) => add(o.category, (o.amount * take) / total));
    pool.forEach((e) => add(e.category, (-e.amount * take) / poolTotal));
    items.push(...list);
    moved += take;
  });
  return { delta, items, moved };
}

function summarize(ledgerId, month, account = '') {
  const list = byLedger('entries', ledgerId)
    .filter((e) => e.date.startsWith(month) && (!account || e.account === account))
    .sort(byDateDesc);
  const live = list.filter((e) => !tagOfEntry(e));
  const outs = live.filter((e) => e.flow === 'out');
  const ins = live.filter((e) => e.flow === 'in');
  const savings = list.filter((e) => tagOfEntry(e) === 'saving');
  const refunds = list.filter((e) => tagOfEntry(e) === 'refund');
  const moved = list.filter((e) => ['transfer', 'asset'].includes(tagOfEntry(e)));
  const rents = account ? [] : rentEntriesOf(month); // 계좌별로 볼 때는 월세 제외
  const cats = new Map();
  outs.forEach((e) => cats.set(e.category, (cats.get(e.category) || 0) + Number(e.amount)));
  // 계좌별로 볼 때는 덩어리가 그 계좌에 없을 수 있어 쿠팡 나누기를 하지 않는다
  const coupang = account ? null : coupangShift(ledgerId, month.length === 4 ? Array.from({ length: 12 }, (_, i) => `${month}-${pad(i + 1)}`) : [month]);
  coupang?.delta.forEach((value, category) => cats.set(category, (cats.get(category) || 0) + value));
  const spent = sum(outs, (e) => e.amount);
  const refund = sum(refunds, (e) => (e.flow === 'in' ? e.amount : -e.amount));
  return {
    list,
    outs: [...outs, ...refunds].sort(byDateDesc),
    ins: [...ins, ...rents].sort(byDateDesc),
    savings,
    moved,
    income: sum(ins, (e) => e.amount) + sum(rents, (e) => e.amount),
    salary: sum(ins.filter((e) => e.category === '급여'), (e) => e.amount),
    rent: sum(rents, (e) => e.amount),
    expense: spent - refund, // 생활 지출 = 쓴 돈 - 돌려받은 돈
    spent,
    refund,
    saving: sum(savings, (e) => (e.flow === 'out' ? e.amount : -e.amount)),
    movedTotal: sum(moved, (e) => e.amount),
    cats: [...cats].map(([name, value]) => [name, Math.round(value)]).filter(([, value]) => value > 0).sort((a, b) => b[1] - a[1]),
    coupang,
  };
}

function compareText(s, prev) {
  if (!prev.expense) return '';
  const diff = s.expense - prev.expense;
  if (diff === 0) return '지난달과 지출이 같아요';
  return `지난달보다 ${won(Math.abs(diff))} ${diff > 0 ? '더 썼어요' : '덜 썼어요'}`;
}

/** rows: [이름, 금액, data 속성(누르면 조회)] */
const bars = (rows, max, total) => rows.map(([name, value, data]) => {
  const inner = `
    <div class="cat_bar_head">
      <span class="cat_bar_name">${esc(name)}</span>
      <span class="cat_bar_value">${won(value)}${total ? ` · ${Math.round((value / total) * 100)}%` : ''}</span>
    </div>
    <div class="cat_bar_track"><div class="cat_bar_fill" style="width:${max ? ((value / max) * 100).toFixed(1) : 0}%"></div></div>`;
  return `<li>${data ? `<button type="button" class="cat_bar_btn" ${data}>${inner}</button>` : inner}</li>`;
}).join('');

/* ---------- 홈 위젯 ---------- */

const RECENT_COUNT = 5;
const signedWon = (v) => `${v < 0 ? '-' : ''}${won(Math.abs(v))}`;

/** 최근 6개월 지출 막대 (이번 달만 진하게) */
function miniChart(ledgerId, month) {
  const months = Array.from({ length: TREND_MONTHS }, (_, i) => addMonths(month, i - TREND_MONTHS + 1));
  const values = months.map((m) => summarize(ledgerId, m).expense);
  const max = Math.max(...values);
  if (!max) return '';
  return `
    <div class="mini_chart" role="img" aria-label="최근 ${TREND_MONTHS}개월 지출: ${months.map((m, i) => `${Number(m.slice(5))}월 ${won(values[i])}`).join(', ')}">
      ${months.map((m, i) => `
        <div class="mini_chart_col" title="${fmtMonth(m)} ${won(values[i])}">
          <span class="mini_chart_track"><span class="mini_chart_bar${m === month ? ' is_current' : ''}" style="height:${Math.max((values[i] / max) * 100, 2).toFixed(1)}%"></span></span>
          <span class="mini_chart_label">${Number(m.slice(5))}월</span>
        </div>`).join('')}
    </div>`;
}

function widget(ledgers) {
  if (!ledgers.length) return '';
  const ledger = ledgers[0];
  const link = `#/m/household/${esc(ledger.id)}`;
  const month = thisMonth();
  const year = month.slice(0, 4);
  const s = summarize(ledger.id, month);
  const prev = summarize(ledger.id, addMonths(month, -1));
  const left = s.income - s.expense - s.saving;

  // 올해 1월부터 이번 달까지
  const ytdMonths = Array.from({ length: Number(month.slice(5)) }, (_, i) => `${year}-${pad(i + 1)}`);
  const ytd = ytdMonths.map((m) => summarize(ledger.id, m)).reduce((acc, x) => ({
    income: acc.income + x.income, expense: acc.expense + x.expense, saving: acc.saving + x.saving,
  }), { income: 0, expense: 0, saving: 0 });
  const saveRate = ytd.income ? Math.round((ytd.saving / ytd.income) * 100) : 0;

  const recent = byLedger('entries', ledger.id)
    .filter((e) => !['transfer', 'asset'].includes(tagOfEntry(e)))
    .sort(byDateDesc)
    .slice(0, RECENT_COUNT);

  return `
    <a class="widget" href="${link}">
      <div class="widget_head"><span class="widget_icon">${ICONS.wallet}</span><strong class="widget_title">${Number(month.slice(5))}월 가계부</strong>${ICONS.next}</div>
      ${notesFor(month).map((n) => `<p class="period_note">${esc(n.label)}</p>`).join('')}
      <p class="widget_label">생활 지출</p>
      <p class="widget_value">${won(s.expense)}</p>
      ${compareText(s, prev) ? `<p class="widget_sub">${compareText(s, prev)}</p>` : ''}
      <div class="widget_stats">
        <div class="widget_stat"><span class="widget_stat_label">수입</span><span class="widget_stat_value amount_in secret">${won(s.income)}</span></div>
        <div class="widget_stat"><span class="widget_stat_label">저축</span><span class="widget_stat_value">${signedWon(s.saving)}</span></div>
        <div class="widget_stat"><span class="widget_stat_label">남은 돈</span><span class="widget_stat_value">${signedWon(left)}</span></div>
      </div>
      ${miniChart(ledger.id, month)}
      ${s.cats.length ? `<ul class="cat_bars widget_bars">${bars(s.cats.slice(0, TOP_CATEGORIES), s.cats[0][1])}</ul>` : '<p class="widget_sub">아직 이번 달 내역이 없어요</p>'}
    </a>
    ${recent.length ? `
      <a class="widget" href="${link}">
        <div class="widget_head"><span class="widget_icon">${ICONS.message}</span><strong class="widget_title">최근 내역</strong>${ICONS.next}</div>
        <ul class="recent_list">
          ${recent.map((e) => `
            <li class="recent_row">
              <span class="recent_date">${fmtDate(e.date).slice(5)}</span>
              <span class="recent_body"><span class="recent_title">${esc(e.memo || e.category)}</span><span class="recent_sub">${accountTag(e.account)}${esc(e.category)}</span></span>
              <span class="recent_amount ${e.flow === 'in' ? 'amount_in' : 'amount_out'}">${e.flow === 'in' ? '+' : '-'}${won(e.amount)}</span>
            </li>`).join('')}
        </ul>
      </a>` : ''}
    <a class="widget" href="${link}">
      <div class="widget_head"><span class="widget_icon">${ICONS.home}</span><strong class="widget_title">${year}년 한눈에</strong>${ICONS.next}</div>
      <div class="widget_stats is_grid">
        <div class="widget_stat"><span class="widget_stat_label">수입</span><span class="widget_stat_value amount_in secret">${won(ytd.income)}</span></div>
        <div class="widget_stat"><span class="widget_stat_label">생활 지출</span><span class="widget_stat_value">${won(ytd.expense)}</span></div>
        <div class="widget_stat"><span class="widget_stat_label">저축</span><span class="widget_stat_value">${signedWon(ytd.saving)}</span></div>
        <div class="widget_stat"><span class="widget_stat_label">저축률</span><span class="widget_stat_value">${saveRate}%</span></div>
      </div>
      <p class="widget_sub">월평균 생활 지출 ${won(Math.round(ytd.expense / ytdMonths.length))}</p>
    </a>`;
}

/* ---------- 상세 화면 ---------- */

/** 통장 이름 라벨 — 문자 가져오기에 설정한 계좌 순서대로 색을 나눈다 */
function accountTag(name) {
  if (!name) return '';
  const index = Math.max(parseJson(setting('bank_accounts'), []).findIndex((a) => a.name === name), 0);
  return `<span class="account_tag is_acc${(index % 2) + 1}">${esc(name)}</span>`;
}

function entryItem(e) {
  const isRent = e.ledger_id && state.ledgers.find((l) => l.id === e.ledger_id)?.kind === 'rent';
  const sub = [isRent ? '월세 메뉴' : '', e.memo, e.by].filter(Boolean).join(' · ');
  const account = isRent ? '' : accountTag(e.account);
  const tag = isRent ? '' : tagOfEntry(e);
  return `
    <li class="list_row">
      <button type="button" class="list_item${['transfer', 'asset'].includes(tag) ? ' is_excluded' : ''}" data-entry="${esc(e.id)}">
        <span class="list_item_body">
          <span class="list_item_title">${esc(e.category)}</span>
          ${sub || account ? `<span class="list_item_sub">${account}${esc(sub)}</span>` : ''}
        </span>
        <span class="list_item_amount ${e.flow === 'in' ? 'amount_in' : 'amount_out'}">${e.flow === 'in' ? '+' : '-'}${won(e.amount)}</span>
      </button>
    </li>`;
}

function groupedList(list, empty) {
  const days = new Map();
  list.forEach((e) => {
    if (!days.has(e.date)) days.set(e.date, []);
    days.get(e.date).push(e);
  });
  const groups = [...days].map(([date, items]) => {
    const spent = sum(items.filter((e) => e.flow === 'out' && !tagOfEntry(e)), (e) => e.amount);
    return `
      <li class="day_group">
        <div class="day_group_head"><span>${fmtDay(date)}</span><span>${spent ? `-${won(spent)}` : ''}</span></div>
        <ul>${items.map(entryItem).join('')}</ul>
      </li>`;
  }).join('');
  return groups ? `<ul>${groups}</ul>` : `<p class="empty">${empty}</p>`;
}

/** 요약 숫자를 누르면 해당 내역만 모아 보여준다 */
function openDrill(s, key, monthLabel) {
  const [kind, name] = key.split(':');
  const pick = {
    expense: ['생활 지출', s.outs],
    income: ['수입', s.ins],
    saving: ['저축·투자', s.savings],
    moved: ['계좌 이동·목돈', s.moved],
    cat: [name, s.outs.filter((e) => e.category === name)],
  }[kind];
  if (!pick) return;
  const [title, list] = pick;
  const net = sum(list, (e) => (e.flow === 'in' ? e.amount : -e.amount));
  const orders = kind === 'cat' ? (s.coupang?.items || []).filter((o) => o.category === name) : [];
  const taken = kind === 'cat' ? -Math.round(Math.min(s.coupang?.delta.get(name) || 0, 0)) : 0;
  openSheet({
    title: `${monthLabel} ${title}`,
    body: `
      ${list.length || !orders.length ? `
        <p class="drill_total">${list.length}건 · ${net < 0 ? '-' : '+'}${won(Math.abs(net))}</p>
        ${taken ? `<p class="drill_note">이 중 쿠팡 주문 ${won(taken)}은 실제 카테고리로 나눠 보여줘요</p>` : ''}
        ${groupedList(list, '해당하는 내역이 없어요')}` : ''}
      ${orders.length ? `
        <p class="drill_note">쿠팡 주문 ${orders.length}건 · ${won(sum(orders, (o) => o.amount))} (카드대금·생활비 이체에서 옮김)</p>
        <ul>
          ${orders.sort(byDateDesc).map((o) => `
            <li class="coupang_item">
              <span class="coupang_item_date">${fmtDate(o.date).slice(5)}</span>
              <span class="coupang_item_name">${esc(o.title)}</span>
              <span class="coupang_item_amount">${won(o.amount)}</span>
            </li>`).join('')}
        </ul>` : ''}`,
    onMount(body, close) {
      body.addEventListener('click', (e) => {
        const id = e.target.closest('[data-entry]')?.dataset.entry;
        if (!id) return;
        const entry = state.entries.find((x) => x.id === id);
        close();
        openEntryForm({ ledger: state.ledgers.find((l) => l.id === entry.ledger_id), entry });
      });
    },
  });
}

const statButton = (key, label, value, sub = '', valueClass = '') => `
  <button type="button" class="stat_item is_link" data-drill="${key}">
    <span class="stat_label">${label}</span>
    <span class="stat_value${valueClass}">${value}</span>
    ${sub ? `<span class="stat_sub">${sub}</span>` : ''}
  </button>`;

/** 월별 ↔ 연도별 전환 */
const modeToggle = (mode) => `
  <div class="segment" role="group" aria-label="보기 방식">
    ${[['month', '월별'], ['year', '연도별']].map(([key, label]) => `<button type="button" class="segment_btn${key === mode ? ' is_active' : ''}" data-mode="${key}" aria-pressed="${key === mode}">${label}</button>`).join('')}
  </div>`;

function view(ledger) {
  if (viewMode.get(ledger.id) === 'year') return yearView(ledger);
  const month = monthOf(ledger.id);
  const accounts = [...new Set(byLedger('entries', ledger.id).map((e) => e.account).filter(Boolean))].sort();
  const account = accounts.includes(viewAccount.get(ledger.id)) ? viewAccount.get(ledger.id) : '';
  const s = summarize(ledger.id, month, account);
  const prev = summarize(ledger.id, addMonths(month, -1), account);
  const left = s.income - s.expense - s.saving;
  const monthLabel = `${Number(month.slice(5))}월`;
  const signed = (v) => `${v < 0 ? '-' : ''}${won(Math.abs(v))}`;

  return {
    html: `
      ${modeToggle('month')}
      <div class="month_nav">
        <button type="button" class="icon_btn" data-step="-1" aria-label="이전 달">${ICONS.back}</button>
        <button type="button" class="month_nav_label" data-action="pick_month" aria-label="${fmtMonth(month)}, 년·월 직접 선택">${fmtMonth(month)}<span class="month_nav_caret" aria-hidden="true">▾</span></button>
        <button type="button" class="icon_btn" data-step="1" aria-label="다음 달"${month >= thisMonth() ? ' disabled' : ''}>${ICONS.next}</button>
      </div>
      ${notesFor(month).map((n) => `<p class="period_note">${esc(n.label)} <span class="period_note_range">${fmtDate(n.from)}${n.to && n.to !== n.from ? ` ~ ${fmtDate(n.to)}` : ''}</span></p>`).join('')}
      ${accounts.length ? `
        <div class="chip_row">
          ${['', ...accounts].map((a) => `<button type="button" class="chip${a === account ? ' is_active' : ''}" data-account="${esc(a)}" aria-pressed="${a === account}">${esc(a || '전체')}</button>`).join('')}
        </div>` : ''}
      <section class="card">
        <button type="button" class="hero_link" data-drill="expense">
          <span class="hero_label">${monthLabel} 생활 지출</span>
          <span class="hero_value">${won(s.expense)}</span>
        </button>
        ${s.refund ? `<p class="hero_sub">쓴 돈 ${won(s.spent)} - 환급·환불 ${won(s.refund)}</p>` : ''}
        <p class="hero_sub">${compareText(s, prev)}</p>
        <div class="stat_grid">
          ${statButton('income', '수입', won(s.income), `<span class="secret">급여 ${won(s.salary)}${s.rent ? ` · 월세 ${won(s.rent)}` : ''}</span>`, ' amount_in secret')}
          ${statButton('saving', '저축·투자', signed(s.saving))}
          <div class="stat_item"><p class="stat_label">남은 돈</p><p class="stat_value">${signed(left)}</p><p class="stat_sub">수입 - 지출 - 저축</p></div>
          <div class="stat_item"><p class="stat_label">저축률</p><p class="stat_value">${month < thisMonth() ? `${rateOf(s)}%` : '-'}</p><p class="stat_sub">${month < thisMonth() ? '저축 ÷ 수입' : '달이 끝나면 계산해요'}</p></div>
        </div>
        ${s.movedTotal ? `<button type="button" class="moved_note" data-drill="moved"><span>계좌 이동·목돈 <strong>${won(s.movedTotal)}</strong>은 합계에서 뺐어요</span>${ICONS.next}</button>` : ''}
      </section>
      ${s.cats.length ? `
        <section class="card">
          <h2 class="card_title">카테고리별 지출 <span class="field_hint">누르면 내역 보기</span></h2>
          ${s.coupang?.moved ? `<p class="card_desc">쿠팡 주문 ${won(Math.round(s.coupang.moved))}을 카드대금·생활비 이체에서 실제 카테고리로 나눴어요</p>` : ''}
          <ul class="cat_bars">${bars(s.cats.map(([name, value]) => [name, value, `data-drill="cat:${esc(name)}"`]), s.cats[0][1], s.spent)}</ul>
        </section>` : ''}
      <section class="card">
        <h2 class="card_title">내역 <span class="field_hint">${s.list.length}건</span></h2>
        ${groupedList(s.list, '이 달의 내역이 없어요<br>오른쪽 아래 + 버튼으로 추가해보세요')}
      </section>
      <section class="card">
        <h2 class="card_title">은행 문자로 채우기</h2>
        <p class="card_desc">문자를 붙여넣거나 백업 파일을 올리면 자동으로 분류해서 넣어요. 폰에 자동 전송을 설정하면 문자가 올 때마다 저절로 들어와요.</p>
        <button type="button" class="btn btn_sub" data-action="import">${ICONS.message}<span>문자 내역 가져오기</span></button>
      </section>
      <section class="card">
        <h2 class="card_title">쿠팡 주문으로 나누기</h2>
        <p class="card_desc">카드대금·생활비 이체에 섞인 쿠팡 결제를 상품별 실제 카테고리(육아·식비·생필품 등)로 나눠 보여줘요. 지출 총액은 그대로예요.</p>
        <button type="button" class="btn btn_sub" data-action="coupang">${ICONS.wallet}<span>쿠팡 주문 가져오기</span></button>
      </section>
      <button type="button" class="fab" data-action="add" aria-label="내역 추가">${ICONS.plus}</button>`,
    mount(el) {
      el.addEventListener('click', (e) => {
        const target = e.target.closest('[data-step],[data-action],[data-entry],[data-account],[data-drill],[data-jump],[data-mode]');
        if (!target) return;
        const { step, action, entry, drill, jump, mode } = target.dataset;
        if (mode) {
          viewMode.set(ledger.id, mode);
          viewYear.set(ledger.id, month.slice(0, 4));
          refresh();
        }
        if (step || jump) {
          const next = jump || addMonths(month, Number(step));
          if (next > thisMonth()) return; // 미래 달로는 가지 않는다
          viewMonth.set(ledger.id, next);
          refresh();
        }
        if (target.dataset.account !== undefined) {
          viewAccount.set(ledger.id, target.dataset.account);
          refresh();
        }
        if (drill) openDrill(s, drill, monthLabel);
        if (action === 'add') openEntryForm({ ledger, defaults: { date: month === thisMonth() ? todayStr() : `${month}-01`, account } });
        if (action === 'import') openSmsImport(ledger);
        if (action === 'coupang') openCoupangImport(ledger);
        if (action === 'pick_month') openMonthPicker(ledger, month, account);
        if (entry) openEntryForm({ ledger, entry: state.entries.find((x) => x.id === entry) });
      });
    },
  };
}

/* ---------- 연도별 통계 ---------- */

/** 만원 단위로 줄인 금액 (연도 비교표용) */
const manShort = (v) => `${v < 0 ? '-' : ''}${Math.round(Math.abs(v) / 10000).toLocaleString('ko-KR')}만`;
const rateOf = (x) => (x.income ? Math.round((x.saving / x.income) * 100) : 0);

/** 내역이 있는 해(와 올해), 최근 해가 앞 */
function yearsOf(ledgerId) {
  const now = thisMonth();
  const years = new Set(byLedger('entries', ledgerId).map((e) => e.date.slice(0, 7)).filter((m) => m <= now).map((m) => m.slice(0, 4)));
  years.add(now.slice(0, 4));
  return [...years].sort().reverse();
}

function yearView(ledger) {
  const now = thisMonth();
  const years = yearsOf(ledger.id);
  const year = years.includes(viewYear.get(ledger.id)) ? viewYear.get(ledger.id) : years[0];
  const index = years.indexOf(year);
  const s = summarize(ledger.id, year);
  const left = s.income - s.expense - s.saving;
  const yearLabel = `${year}년`;
  const signed = (v) => `${v < 0 ? '-' : ''}${won(Math.abs(v))}`;

  const months = Array.from({ length: 12 }, (_, i) => `${year}-${pad(i + 1)}`).filter((m) => m <= now);
  const monthly = months.map((m) => [`${Number(m.slice(5))}월`, summarize(ledger.id, m).expense, `data-jump="${m}" aria-label="${fmtMonth(m)}로 이동"`]);
  const monthMax = Math.max(...monthly.map((r) => r[1]));
  const activeMonths = monthly.filter((r) => r[1]).length; // 월평균은 지출이 있는 달로 나눈다
  // 올해는 아직 안 끝났으니 작년 같은 기간(1월~이번 달)과 비교
  const isThisYear = year === now.slice(0, 4);
  const prevExpense = sum(months, (m) => summarize(ledger.id, `${year - 1}${m.slice(4)}`).expense);
  const prevLabel = isThisYear ? '작년 같은 기간' : '작년';
  const diff = s.expense - prevExpense;
  const yearly = years.map((y) => [y, summarize(ledger.id, y)]);

  return {
    html: `
      ${modeToggle('year')}
      <div class="month_nav">
        <button type="button" class="icon_btn" data-year="${years[index + 1] || ''}" aria-label="이전 해"${years[index + 1] ? '' : ' disabled'}>${ICONS.back}</button>
        <p class="month_nav_label">${yearLabel}</p>
        <button type="button" class="icon_btn" data-year="${years[index - 1] || ''}" aria-label="다음 해"${index > 0 ? '' : ' disabled'}>${ICONS.next}</button>
      </div>
      <section class="card">
        <button type="button" class="hero_link" data-drill="expense">
          <span class="hero_label">${yearLabel} 생활 지출</span>
          <span class="hero_value">${won(s.expense)}</span>
        </button>
        ${activeMonths ? `<p class="hero_sub">월평균 ${won(Math.round(s.expense / activeMonths))} · ${activeMonths}개월</p>` : ''}
        ${prevExpense ? `<p class="hero_sub">${diff === 0 ? `${prevLabel}과 지출이 같아요` : `${prevLabel}보다 ${won(Math.abs(diff))} ${diff > 0 ? '더 썼어요' : '덜 썼어요'}`}</p>` : ''}
        <div class="stat_grid">
          ${statButton('income', '수입', won(s.income), `<span class="secret">급여 ${won(s.salary)}${s.rent ? ` · 월세 ${won(s.rent)}` : ''}</span>`, ' amount_in secret')}
          ${statButton('saving', '저축·투자', signed(s.saving))}
          <div class="stat_item"><p class="stat_label">남은 돈</p><p class="stat_value">${signed(left)}</p><p class="stat_sub">수입 - 지출 - 저축</p></div>
          <div class="stat_item"><p class="stat_label">저축률</p><p class="stat_value">${rateOf(s)}%</p><p class="stat_sub">저축 ÷ 수입</p></div>
        </div>
      </section>
      ${monthMax ? `
        <section class="card">
          <h2 class="card_title">월별 지출 <span class="field_hint">누르면 그 달로 이동</span></h2>
          <ul class="cat_bars">${bars(monthly, monthMax)}</ul>
        </section>` : ''}
      ${s.cats.length ? `
        <section class="card">
          <h2 class="card_title">카테고리별 지출 <span class="field_hint">누르면 내역 보기</span></h2>
          ${s.coupang?.moved ? `<p class="card_desc">쿠팡 주문 ${won(Math.round(s.coupang.moved))}을 카드대금·생활비 이체에서 실제 카테고리로 나눴어요</p>` : ''}
          <ul class="cat_bars">${bars(s.cats.map(([name, value]) => [name, value, `data-drill="cat:${esc(name)}"`]), s.cats[0][1], s.spent)}</ul>
        </section>` : ''}
      ${yearly.length > 1 ? `
        <section class="card">
          <h2 class="card_title">연도별 비교 <span class="field_hint">단위 만원</span></h2>
          <table class="year_table">
            <thead><tr><th scope="col">연도</th><th scope="col">수입</th><th scope="col">생활 지출</th><th scope="col">저축</th><th scope="col">저축률</th></tr></thead>
            <tbody>
              ${yearly.map(([y, x]) => `
                <tr${y === year ? ' class="is_active"' : ''}>
                  <th scope="row"><button type="button" class="year_table_btn" data-year="${y}">${y}</button></th>
                  <td class="amount_in secret">${manShort(x.income)}</td>
                  <td>${manShort(x.expense)}</td>
                  <td>${manShort(x.saving)}</td>
                  <td>${rateOf(x)}%</td>
                </tr>`).join('')}
            </tbody>
          </table>
        </section>` : ''}`,
    mount(el) {
      el.addEventListener('click', (e) => {
        const target = e.target.closest('[data-mode],[data-year],[data-jump],[data-drill]');
        if (!target) return;
        const { mode, jump, drill } = target.dataset;
        if (mode) {
          viewMode.set(ledger.id, mode);
          refresh();
        }
        if (target.dataset.year) {
          viewYear.set(ledger.id, target.dataset.year);
          refresh();
        }
        if (jump) {
          viewMode.set(ledger.id, 'month');
          viewMonth.set(ledger.id, jump);
          refresh();
        }
        if (drill) openDrill(s, drill, yearLabel);
      });
    },
  };
}

/** 년·월 직접 선택: 내역이 있는 달(과 이번 달)만 고를 수 있다 */
function openMonthPicker(ledger, month, account) {
  const now = thisMonth();
  const have = new Set(byLedger('entries', ledger.id)
    .filter((e) => !account || e.account === account)
    .map((e) => e.date.slice(0, 7))
    .filter((m) => m <= now));
  have.add(now);
  const years = [...new Set([...have].map((m) => m.slice(0, 4)))].sort().reverse();
  openSheet({
    title: '년·월 선택',
    body: years.map((y) => `
      <div class="month_pick_year">
        <p class="month_pick_label">${y}년</p>
        <div class="month_pick_grid">
          ${Array.from({ length: 12 }, (_, i) => {
            const m = `${y}-${pad(i + 1)}`;
            return `<button type="button" class="month_pick_btn${m === month ? ' is_active' : ''}" data-pick="${m}"${have.has(m) ? '' : ' disabled'}>${i + 1}월</button>`;
          }).join('')}
        </div>
      </div>`).join(''),
    onMount(body, close) {
      body.querySelector('.is_active')?.scrollIntoView({ block: 'center' });
      body.addEventListener('click', (e) => {
        const picked = e.target.closest('[data-pick]:not(:disabled)')?.dataset.pick;
        if (!picked) return;
        viewMonth.set(ledger.id, picked);
        close();
        refresh();
      });
    },
  });
}

/* ---------- 은행 문자 → 가계부 내역 ---------- */

const normalizeName = (s) => String(s || '').replace(/주식회사|\(주\)|㈜|주\)|\s/g, '');

/** 월세 장부에 이미 있는 입금(임차인 이름·계약 소재지 단어)인지 */
function rentMatcher() {
  const contracts = state.contracts;
  const tenants = contracts.map((c) => normalizeName(c.tenant)).filter((t) => t.length >= 2);
  const words = contracts.flatMap((c) => String(c.address || '').split(/\s+/))
    .filter((w) => w.length >= 3 && !/\d/.test(w) && !/[시도군구읍면동리호]$/.test(w));
  return (tx) => {
    const who = normalizeName(tx.who);
    if (who.length < 2) return false;
    return tenants.some((t) => t.startsWith(who) || who.startsWith(t)) || words.some((w) => who.includes(w));
  };
}

/** 문자 목록 [{ date(받은 시각 ms), body }] → 새로 넣을 가계부 내역과 통계 */
function buildEntries(ledger, messages, { accounts, members } = {}) {
  const ctx = {
    accounts: accounts || parseJson(setting('bank_accounts'), []),
    members: members || parseJson(setting('family_members'), []),
    custom: parseJson(setting('sms_rules'), []),
    isRent: rentMatcher(),
  };
  const known = new Set(state.entries.flatMap((e) => [e.ref, refKey(e.ref, e.date)]).filter(Boolean));
  const stats = { rent: 0, dup: 0, other: 0, byAccount: new Map(), byCategory: new Map() };
  const fresh = [];
  messages.forEach((m) => {
    const tx = parseKbSms(m.body, m.date, ctx.accounts);
    if (!tx) { stats.other += 1; return; }
    if (known.has(tx.ref) || known.has(refKey(tx.ref, tx.date))) { stats.dup += 1; return; }
    const c = classify(tx, ctx);
    if (!c) { stats.rent += 1; return; }
    known.add(tx.ref).add(refKey(tx.ref, tx.date));
    fresh.push({ ledger_id: ledger.id, date: tx.date, flow: c.flow, category: c.category, amount: tx.amount, months: '', memo: tx.who || tx.kind, by: '', account: tx.account, ref: tx.ref });
    stats.byAccount.set(tx.account, (stats.byAccount.get(tx.account) || 0) + 1);
    stats.byCategory.set(c.category, (stats.byCategory.get(c.category) || 0) + 1);
  });
  const before = fresh.length;
  applyPayrollDeductions(fresh, parseJson(setting('payroll_deductions'), []), byLedger('entries', ledger.id));
  stats.deducted = fresh.length - before;
  return { fresh, stats };
}

async function saveRows(table, fresh, onProgress) {
  let saved = 0;
  for (let i = 0; i < fresh.length; i += IMPORT_CHUNK) {
    onProgress?.(Math.min(i + IMPORT_CHUNK, fresh.length), fresh.length);
    saved += (await insertMany(table, fresh.slice(i, i + IMPORT_CHUNK))).length;
  }
  return saved;
}

const showProgress = (box, n, total) => {
  box.innerHTML = `<div class="import_progress"><p>저장 중 ${n}/${total}</p><div class="cat_bar_track"><div class="cat_bar_fill" style="width:${Math.round((n / total) * 100)}%"></div></div></div>`;
};

/** 폰 자동 전송으로 받은 문자함을 분류해서 넣고 비운다 (동기화할 때마다) */
let processing = false;
async function processInbox() {
  const ledger = state.ledgers.find((l) => l.kind === KIND);
  if (processing || !ledger || !state.inbox.length) return;
  processing = true;
  try {
    const inbox = state.inbox.slice();
    const { fresh } = buildEntries(ledger, inbox.map((r) => ({ date: Date.parse(r.received_at) || Date.now(), body: r.text })));
    const saved = fresh.length ? await saveRows('entries', fresh) : 0;
    await removeMany('inbox', inbox.map((r) => r.id));
    if (saved) toast(`은행 문자 ${saved}건을 가계부에 넣었어요`);
  } catch (err) {
    toast(err.message, true);
  } finally {
    processing = false;
  }
}

/** 다른 앱에서 '공유'로 받은 글 (설치된 앱일 때) */
function onShare(text) {
  const ledger = state.ledgers.find((l) => l.kind === KIND);
  if (!ledger) return toast('가계부를 먼저 만들어주세요', true);
  location.hash = `#/m/household/${ledger.id}`;
  openSmsImport(ledger, text);
}

function autoGuideHtml() {
  const { apiUrl, token } = getConfig();
  const row = (label, value) => `<dt>${label}</dt><dd><code class="copy_value" data-copy="${esc(value)}">${esc(value)}</code></dd>`;
  return `
    <details class="import_details">
      <summary>폰에서 문자 자동으로 넣기 (안드로이드)</summary>
      <ol class="guide_list">
        <li>플레이스토어에서 <strong>MacroDroid</strong> 설치 → <strong>매크로 추가</strong></li>
        <li><strong>트리거</strong>: 수신 SMS → 발신자 <strong>특정 번호</strong> <code>16449999</code></li>
        <li><strong>액션</strong>: HTTP 요청 → 방식 <strong>POST</strong>, 본문 유형 <strong>application/x-www-form-urlencoded</strong></li>
        <li>아래 값을 누르면 복사돼요. URL과 파라미터 3개를 넣어주세요. <code>text</code> 값은 매직 텍스트에서 <strong>SMS 메시지</strong>를 고르세요.</li>
      </ol>
      <dl class="info_list guide_values">
        ${row('URL', apiUrl)}
        ${row('token', token)}
        ${row('action', 'ingestSms')}
        <dt>text</dt><dd><code>[sms_message]</code></dd>
      </dl>
      <p class="field_hint">폰 설정 → 배터리 → MacroDroid를 <strong>제한 없음</strong>으로 바꿔야 끊기지 않아요. 받은 문자는 앱을 열 때 자동으로 분류돼요.</p>
    </details>`;
}

function openSmsImport(ledger, sharedText = '') {
  const saved = parseJson(setting('bank_accounts'), []);
  const members = parseJson(setting('family_members'), []);
  const rows = Array.from({ length: 3 }, (_, i) => saved[i] || { prefix: '', name: '' });
  let closeSheet;
  let busy = false;

  openSheet({
    title: '은행 문자 가져오기',
    body: `
      <div class="import_body">
        <form class="form" data-form="paste" novalidate>
          <label class="field">
            <span class="field_label">문자 붙여넣기 (여러 개도 한꺼번에)</span>
            <textarea class="field_input field_textarea" name="text" placeholder="[KB]10/15 15:10&#10;123456**789&#10;거래처&#10;출금&#10;10,000&#10;잔액1,000,000">${esc(sharedText)}</textarea>
          </label>
          <p class="field_hint">KB국민은행(1644-9999) 입출금 문자를 길게 눌러 복사하거나, 문자 앱에서 <strong>공유 → 우리셋</strong>를 고르세요.</p>
          <button type="submit" class="btn btn_sub">붙여넣은 문자 확인</button>
        </form>
        <div class="import_or"><span>또는</span></div>
        <label class="import_pick">
          <input type="file" accept=".xml,text/xml" class="blind" name="xml">
          <span class="import_pick_icon">${ICONS.message}</span>
          <strong>문자 백업 파일(XML) 고르기</strong>
          <span class="field_hint">SMS Backup &amp; Restore로 내보낸 파일. 다른 문자는 읽지 않아요</span>
        </label>
        ${autoGuideHtml()}
        <details class="import_details">
          <summary>계좌·가족 설정</summary>
          <div class="form">
            <div class="field">
              <span class="field_label">계좌 (계좌번호 앞자리 → 통장 이름)</span>
              ${rows.map((r, i) => `
                <div class="field_row">
                  <input class="field_input" name="prefix_${i}" inputmode="numeric" maxlength="6" placeholder="앞자리 4자리" value="${esc(r.prefix)}" aria-label="계좌 ${i + 1} 앞자리">
                  <input class="field_input" name="account_${i}" maxlength="10" placeholder="통장 이름" value="${esc(r.name)}" aria-label="계좌 ${i + 1} 이름">
                </div>`).join('')}
            </div>
            <label class="field">
              <span class="field_label">가족 이름 (서로·본인 계좌 간 이동은 합계에서 제외)</span>
              <input class="field_input" name="members" placeholder="쉼표로 구분" value="${esc(members.join(', '))}">
            </label>
          </div>
        </details>
      </div>`,
    onMount(body, close) {
      closeSheet = close;
      const box = body.querySelector('.import_body');
      body.querySelector('input[type=file]').addEventListener('change', async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        const options = readOptions(box);
        if (!options) return;
        box.innerHTML = '<div class="import_progress"><p>문자 읽는 중…</p></div>';
        analyze(box, extractSms(await file.text(), KB_SENDER), options);
      });
      body.querySelector('[data-form=paste]').addEventListener('submit', (e) => {
        e.preventDefault();
        const chunks = splitSmsText(e.target.elements.text.value);
        if (!chunks.length) return toast('[KB]로 시작하는 은행 문자를 붙여넣어주세요', true);
        const options = readOptions(box);
        if (options) analyze(box, chunks.map((text) => ({ date: Date.now(), body: text })), options);
      });
      body.addEventListener('click', async (e) => {
        const value = e.target.closest('[data-copy]')?.dataset.copy;
        if (!value) return;
        try {
          await navigator.clipboard.writeText(value);
          toast('복사했어요');
        } catch {
          toast('복사하지 못했어요. 길게 눌러 복사해주세요', true);
        }
      });
      if (sharedText) body.querySelector('[data-form=paste]').requestSubmit();
    },
    onClose: () => { if (busy) toast('가져오기는 계속 진행 중이에요'); },
  });

  function readOptions(box) {
    const accounts = rows.map((_, i) => ({ prefix: box.querySelector(`[name=prefix_${i}]`).value.trim(), name: box.querySelector(`[name=account_${i}]`).value.trim() }))
      .filter((a) => a.prefix && a.name);
    const family = box.querySelector('[name=members]').value.split(',').map((s) => s.trim()).filter(Boolean);
    if (!accounts.length) {
      box.querySelector('.import_details:last-of-type').open = true;
      toast('계좌 앞자리와 이름을 입력해주세요', true);
      return null;
    }
    return { accounts, members: family };
  }

  function analyze(box, messages, options) {
    const { fresh, stats } = buildEntries(ledger, messages, options);
    if (!fresh.length) {
      box.innerHTML = `<p class="empty">새로 넣을 내역이 없어요${stats.dup ? `<br>(이미 있는 내역 ${stats.dup}건)` : ''}${stats.other ? `<br>(등록한 계좌가 아니거나 읽을 수 없는 문자 ${stats.other}건)` : ''}</p>`;
      return;
    }
    const dates = fresh.map((r) => r.date).sort();
    const unknown = stats.byCategory.get('미분류') || 0;
    box.innerHTML = `
      <dl class="info_list import_summary">
        <dt>기간</dt><dd>${fmtDate(dates[0])}${dates[0] !== dates[dates.length - 1] ? ` ~ ${fmtDate(dates[dates.length - 1])}` : ''}</dd>
        <dt>새 내역</dt><dd>${fresh.length.toLocaleString('ko-KR')}건</dd>
        ${[...stats.byAccount].map(([a, n]) => `<dt>${esc(a)}</dt><dd>${n.toLocaleString('ko-KR')}건</dd>`).join('')}
        ${stats.dup ? `<dt>이미 있는 내역</dt><dd>${stats.dup.toLocaleString('ko-KR')}건 건너뜀</dd>` : ''}
        ${stats.rent ? `<dt>월세 입금</dt><dd>${stats.rent}건 (월세 메뉴에 있어 제외)</dd>` : ''}
        ${stats.deducted ? `<dt>급여 공제 반영</dt><dd>${stats.deducted}개월 (급여에 더하고 지출로 추가)</dd>` : ''}
        <dt>분류 못 한 내역</dt><dd>${unknown.toLocaleString('ko-KR')}건 → '미분류'</dd>
      </dl>
      ${fresh.length <= 5 ? `<ul class="import_preview">${fresh.map((r) => `<li>${fmtDate(r.date).slice(5)} ${esc(r.category)} <strong class="${r.flow === 'in' ? 'amount_in' : 'amount_out'}">${r.flow === 'in' ? '+' : '-'}${won(r.amount)}</strong> <span>${esc(r.memo)}</span></li>`).join('')}</ul>` : ''}
      <button type="button" class="btn" data-start>${fresh.length.toLocaleString('ko-KR')}건 넣기</button>`;

    box.querySelector('[data-start]').addEventListener('click', async (e) => {
      busy = true;
      let saved = 0;
      const ok = await runTask(e.target, async () => {
        await saveSetting('bank_accounts', JSON.stringify(options.accounts));
        await saveSetting('family_members', JSON.stringify(options.members));
        saved = await saveRows('entries', fresh, (n, total) => showProgress(box, n, total));
      });
      busy = false;
      if (ok) {
        closeSheet();
        toast(`${saved.toLocaleString('ko-KR')}건을 넣었어요`);
      }
    });
  }
}

/* ---------- 쿠팡 주문 → 실제 카테고리 ---------- */

function openCoupangImport(ledger) {
  const known = new Set(byLedger('records', ledger.id).filter((r) => r.type === COUPANG_TYPE).map((r) => parseJson(r.data, {}).key).filter(Boolean));
  let closeSheet;
  let busy = false;

  openSheet({
    title: '쿠팡 주문 가져오기',
    body: `
      <div class="import_body">
        <p class="card_desc">쿠팡 결제는 이미 카드대금·생활비 이체로 잡혀 있어서 지출에 더하지 않아요. 주문한 달의 그 금액에서 떼어 상품별 카테고리로 나눠 보여줘요.</p>
        <label class="field">
          <span class="field_label">쿠팡 결제 카드 (카드대금 내역 이름에 들어간 말)</span>
          <input class="field_input" name="card" maxlength="20" placeholder="예) OO카드" value="${esc(setting('coupang_card'))}">
          <span class="field_hint">비워두면 모든 카드대금에서 나눠요. 생활비 이체는 항상 포함해요</span>
        </label>
        <label class="import_pick">
          <input type="file" accept=".csv,text/csv" class="blind" name="csv">
          <span class="import_pick_icon">${ICONS.wallet}</span>
          <strong>쿠팡 주문내역 파일(CSV) 고르기</strong>
          <span class="field_hint">이미 넣은 주문은 건너뛰어요</span>
        </label>
      </div>`,
    onMount(body, close) {
      closeSheet = close;
      const box = body.querySelector('.import_body');
      body.querySelector('input[type=file]').addEventListener('change', async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        const card = box.querySelector('[name=card]').value.trim();
        const result = buildCoupangRecords(await file.text(), ledger.id, known);
        if (!result) return toast('쿠팡 주문내역 CSV가 아니에요', true);
        analyze(box, result, card);
      });
    },
    onClose: () => { if (busy) toast('가져오기는 계속 진행 중이에요'); },
  });

  function analyze(box, { fresh, stats }, card) {
    if (!fresh.length) {
      box.innerHTML = `<p class="empty">새로 넣을 주문이 없어요${stats.dup ? `<br>(이미 있는 주문 상품 ${stats.dup}건)` : ''}</p>`;
      return;
    }
    const dates = fresh.map((r) => r.date).sort();
    box.innerHTML = `
      <dl class="info_list import_summary">
        <dt>기간</dt><dd>${fmtDate(dates[0])} ~ ${fmtDate(dates[dates.length - 1])}</dd>
        <dt>새 주문 상품</dt><dd>${fresh.length.toLocaleString('ko-KR')}건</dd>
        ${[...stats.byCategory].sort((a, b) => b[1][1] - a[1][1]).map(([name, [n, amount]]) => `<dt>${esc(name)}</dt><dd>${n}건 · ${won(amount)}</dd>`).join('')}
        ${stats.dup ? `<dt>이미 있는 상품</dt><dd>${stats.dup.toLocaleString('ko-KR')}건 건너뜀</dd>` : ''}
        ${stats.canceled ? `<dt>전부 취소·반품</dt><dd>${stats.canceled}건 제외</dd>` : ''}
        <dt>나눌 덩어리</dt><dd>${card ? `카드대금(${esc(card)})` : '모든 카드대금'} + 생활비 이체</dd>
      </dl>
      <button type="button" class="btn" data-start>${fresh.length.toLocaleString('ko-KR')}건 넣기</button>`;

    box.querySelector('[data-start]').addEventListener('click', async (e) => {
      busy = true;
      let saved = 0;
      const ok = await runTask(e.target, async () => {
        if (card !== setting('coupang_card')) await saveSetting('coupang_card', card);
        saved = await saveRows('records', fresh, (n, total) => showProgress(box, n, total));
      });
      busy = false;
      if (ok) {
        closeSheet();
        refresh();
        toast(`쿠팡 주문 ${saved.toLocaleString('ko-KR')}건을 넣었어요`);
      }
    });
  }
}

export default {
  kind: KIND,
  label: '가계부',
  nav: 'wallet',
  defaultName: '우리집 생활비',
  description: '월별 수입·지출·저축과 카테고리별 소비를 관리해요',
  categories: {
    in: [
      ['급여', ''], ['정부지원', ''], ['금융수입', ''], ['환급·환불', 'refund'], ['가족·지인 입금', ''], ['현금 입금', ''], ['부수입', ''], ['기타수입', ''],
      ['저축 해지', 'saving'], ['목돈 입금', 'asset'], ['내 계좌 이동', 'transfer'],
    ],
    out: [
      ['식비', ''], ['외식', ''], ['생필품', ''], ['쇼핑', ''], ['카드대금', ''], ['주거·관리비', ''], ['공과금', ''], ['통신비', ''], ['보험', ''], ['대출·할부', ''],
      ['교통', ''], ['의료', ''], ['교육', ''], ['육아', ''], ['용돈', ''], ['생활비 이체', ''], ['경조사·송금', ''], ['여가', ''], ['현금 인출', ''], ['수수료', ''], ['기타', ''], ['미분류', ''],
      ['저축·투자', 'saving'], ['목돈 지출', 'asset'], ['내 계좌 이동', 'transfer'],
    ],
  },
  widget,
  view,
  onSync: processInbox,
  onShare,
};
