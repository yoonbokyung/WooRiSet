import { state, byLedger, upsert, tagOf, refresh } from '../store.js';
import { openSheet, runTask, toast, bindAmountInput } from '../ui.js';
import { openEntryForm } from '../forms.js';
import { ICONS } from '../icons.js';
import { esc, pad, todayStr, addMonths, splitMonths, fmtDate, manwon, sum, byDateDesc, parseAmount, daysBetween } from '../utils.js';

const KIND = 'rent';
const FILTERS = [['all', '전체'], ['rent', '월세'], ['etc', '보증금·지출']];
const PAGE_SIZE = 10;
const filterState = new Map(); // 장부별 내역 필터
const limitState = new Map(); // 장부별 내역 표시 개수

/* ---------- 계산 ---------- */

const contractsOf = (ledgerId) => byLedger('contracts', ledgerId).slice().sort((a, b) => a.start_date.localeCompare(b.start_date));
const contractFor = (month, contracts) => contracts.filter((c) => c.start_date.slice(0, 7) <= month).pop() || contracts[0];
const dayOf = (c) => pad(Math.min(Math.max(Number(c.due_day) || 1, 1), 28));
const isRent = (entry) => tagOf(KIND, entry.category) === 'rent';
const isDeposit = (entry) => tagOf(KIND, entry.category) === 'deposit';

/** 기간 시작월 기준 입금 기한 (후불: 다음 달 납부일, 선불: 해당 월 납부일) */
const dueDateOf = (month, c) => `${c.pay_timing === 'pre' ? month : addMonths(month, 1)}-${dayOf(c)}`;

/** '2026-09' → '2026.09.15~10.15' */
function periodLabel(month, c) {
  const end = addMonths(month, 1);
  return `${fmtDate(month)}.${dayOf(c)}~${end.slice(5)}.${dayOf(c)}`;
}

const shortMonth = (month) => `${month.slice(2, 4)}년 ${Number(month.slice(5))}월분`;

/**
 * 계약 시작월부터 월별 상태(paid / unpaid / upcoming)를 계산한다.
 * 다음 입금 예정월까지, 또는 미리 입금된 마지막 월까지 만든다.
 */
function analyze(ledger) {
  const contracts = contractsOf(ledger.id);
  if (!contracts.length) return null;

  const entries = byLedger('entries', ledger.id);
  const paid = new Map();
  entries.filter(isRent).forEach((e) => splitMonths(e.months).forEach((m) => paid.set(m, e)));

  const today = todayStr();
  const current = contracts[contracts.length - 1];
  const first = contracts[0].start_date.slice(0, 7);
  const endCap = current.status === 'ended' && current.end_date ? addMonths(current.end_date.slice(0, 7), -1) : null;
  const lastPaid = [...paid.keys()].sort().pop() || first;

  const rows = [];
  let next = null;
  for (let m = first, guard = 0; guard < 600; m = addMonths(m, 1), guard++) {
    if (endCap && m > endCap) break;
    const c = contractFor(m, contracts);
    const due = dueDateOf(m, c);
    const entry = paid.get(m);
    const status = entry ? 'paid' : due <= today ? 'unpaid' : 'upcoming';
    rows.push({ month: m, due, status, entry, contract: c, rent: Number(c.rent) || 0 });
    if (status === 'upcoming' && !next) next = rows[rows.length - 1];
    if (next && m >= lastPaid) break;
  }

  const unpaid = rows.filter((r) => r.status === 'unpaid');
  return {
    contracts,
    current,
    rows,
    unpaid,
    next,
    entries,
    unpaidAmount: sum(unpaid, (r) => r.rent),
    rentIncome: sum(entries.filter(isRent), (e) => e.amount),
    expense: sum(entries.filter((e) => e.flow === 'out' && !isDeposit(e)), (e) => e.amount),
  };
}

function contractStatus(c) {
  if (c.status === 'ended') return '종료';
  if (c.end_date && c.end_date < todayStr()) return `묵시적 갱신 중 (만료 ${fmtDate(c.end_date)})`;
  return '계약 중';
}

/* ---------- 홈 카드 ---------- */

function widget(ledgers) {
  if (!ledgers.length) return '';
  return ledgers.map((ledger) => {
    const a = analyze(ledger);
    const head = `<div class="widget_head"><span class="widget_icon">${ICONS.building}</span><strong class="widget_title">${esc(ledger.name)}</strong>${ICONS.next}</div>`;
    if (!a) return `<a class="widget" href="#/m/rent/${esc(ledger.id)}">${head}<p class="widget_sub">계약 정보를 등록해주세요</p></a>`;
    const badge = a.unpaid.length ? `<span class="badge is_danger">미납 ${a.unpaid.length}개월</span>` : '<span class="badge">미납 없음</span>';
    return `
      <a class="widget" href="#/m/rent/${esc(ledger.id)}">
        ${head}
        <div class="widget_row">
          <div>
            <p class="widget_value${a.unpaid.length ? ' is_danger' : ''}">${a.unpaid.length ? manwon(a.unpaidAmount) : a.next ? `${fmtDate(a.next.due).slice(5)} 입금 예정` : '계약 종료'}</p>
            ${!a.unpaid.length && a.next ? `<p class="widget_sub">D-${daysBetween(todayStr(), a.next.due)} · ${periodLabel(a.next.month, a.next.contract)}분</p>` : ''}
            <p class="widget_sub">월세 ${manwon(a.current.rent)} · 보증금 ${manwon(a.current.deposit)}</p>
          </div>
          ${badge}
        </div>
      </a>`;
  }).join('');
}

/* ---------- 상세 화면 ---------- */

function summaryHtml(a) {
  const alert = a.unpaid.length ? `
    <div class="alert">
      <strong>입금 확인이 필요한 기간</strong>
      ${a.unpaid.map((r) => `<span>${periodLabel(r.month, r.contract)} · ${manwon(r.rent)}</span>`).join('')}
    </div>` : '';
  return `
    <section class="card">
      <p class="hero_label">${a.unpaid.length ? `미납 ${a.unpaid.length}개월` : '월세 상태'}</p>
      <p class="hero_value${a.unpaid.length ? ' is_danger' : ''}">${a.unpaid.length ? manwon(a.unpaidAmount) : '모두 입금 완료'}</p>
      ${alert}
      <div class="stat_grid">
        <div class="stat_item">
          <p class="stat_label">다음 입금 예정</p>
          <p class="stat_value">${a.next ? fmtDate(a.next.due) : '-'}</p>
          <p class="stat_sub">${a.next ? periodLabel(a.next.month, a.next.contract) : ''}</p>
        </div>
        <div class="stat_item">
          <p class="stat_label">돌려줄 보증금</p>
          <p class="stat_value">${manwon(a.current.deposit)}</p>
        </div>
        <div class="stat_item">
          <p class="stat_label">누적 월세 수입</p>
          <p class="stat_value">${manwon(a.rentIncome)}</p>
        </div>
        <div class="stat_item">
          <p class="stat_label">누적 지출</p>
          <p class="stat_value">${manwon(a.expense)}</p>
          <p class="stat_sub">수리비·수수료 등</p>
        </div>
      </div>
    </section>`;
}

function gridHtml(a) {
  const byMonth = new Map(a.rows.map((r) => [r.month, r]));
  const firstYear = Number(a.rows[0].month.slice(0, 4));
  const lastYear = Number(a.rows[a.rows.length - 1].month.slice(0, 4));
  const label = { paid: '입금', unpaid: '미납', upcoming: '예정' };
  const years = [];
  for (let y = lastYear; y >= firstYear; y--) {
    const cells = Array.from({ length: 12 }, (_, i) => {
      const r = byMonth.get(`${y}-${pad(i + 1)}`);
      if (!r) return '<span class="rent_month is_none"></span>';
      return `<button type="button" class="rent_month is_${r.status}" data-month="${r.month}" aria-label="${y}년 ${i + 1}월분 ${label[r.status]}">${i + 1}</button>`;
    }).join('');
    years.push(`<div class="rent_year"><p class="rent_year_label">${y}</p><div class="rent_months">${cells}</div></div>`);
  }
  const day = Number(a.current.due_day) || 15;
  return `
    <section class="card">
      <h2 class="card_title">월별 입금 현황</h2>
      <ul class="rent_legend">
        <li class="rent_legend_item is_paid">입금</li>
        <li class="rent_legend_item is_unpaid">미납</li>
        <li class="rent_legend_item is_upcoming">예정</li>
      </ul>
      ${years.join('')}
      <p class="field_hint rent_grid_hint">각 칸은 해당 월 ${day}일부터 한 달 기간이에요. 칸을 누르면 입금 내역을 보거나 입력할 수 있어요.</p>
    </section>`;
}

function contractHtml(a) {
  const c = a.current;
  const rows = [
    ['소재지', c.address],
    ['임차인', c.tenant],
    ['보증금', manwon(c.deposit)],
    ['월세', manwon(c.rent)],
    ['납부일', `매월 ${c.due_day}일 ${c.pay_timing === 'pre' ? '선불' : '후불'}`],
    ['계약 기간', `${fmtDate(c.start_date)} ~ ${fmtDate(c.end_date) || '미정'}`],
    ['상태', contractStatus(c)],
    ['메모', c.memo],
    ['계약 이력', a.contracts.length > 1 ? `${a.contracts.length}건 (최초 ${fmtDate(a.contracts[0].start_date)})` : ''],
  ].filter(([, v]) => v);
  return `
    <section class="card">
      <h2 class="card_title">계약 정보 <button type="button" class="text_btn" data-action="contract">수정</button></h2>
      <dl class="info_list">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join('')}</dl>
    </section>`;
}

function entryItem(e, a) {
  const months = splitMonths(e.months);
  let period = '';
  if (isRent(e) && months.length === 1) period = periodLabel(months[0], contractFor(months[0], a.contracts));
  else if (isRent(e) && months.length > 1) period = `${months.length}개월분`;
  const sub = [fmtDate(e.date), period, e.memo, e.by].filter(Boolean).join(' · ');
  return `
    <li class="list_row">
      <button type="button" class="list_item" data-entry="${esc(e.id)}">
        <span class="list_item_body">
          <span class="list_item_title">${esc(e.category)}</span>
          <span class="list_item_sub">${esc(sub)}</span>
        </span>
        <span class="list_item_amount ${e.flow === 'in' ? 'amount_in' : 'amount_out'}">${e.flow === 'in' ? '+' : '-'}${manwon(e.amount)}</span>
      </button>
    </li>`;
}

function entriesHtml(ledger, a) {
  const filter = filterState.get(ledger.id) || 'all';
  const limit = limitState.get(ledger.id) || PAGE_SIZE;
  const list = a.entries
    .filter((e) => filter === 'all' || (filter === 'rent' ? isRent(e) : !isRent(e)))
    .sort(byDateDesc);
  return `
    <section class="card">
      <h2 class="card_title">입출금 내역 <span class="field_hint">${list.length}건</span></h2>
      <div class="chip_row rent_filter">
        ${FILTERS.map(([k, label]) => `<button type="button" class="chip${filter === k ? ' is_active' : ''}" data-filter="${k}" aria-pressed="${filter === k}">${label}</button>`).join('')}
      </div>
      ${list.length ? `<ul>${list.slice(0, limit).map((e) => entryItem(e, a)).join('')}</ul>` : '<p class="empty">내역이 없어요</p>'}
      ${list.length > limit ? `<button type="button" class="btn btn_sub rent_more" data-action="more">더보기 (${list.length - limit}건)</button>` : ''}
    </section>`;
}

function view(ledger) {
  const a = analyze(ledger);
  if (!a) {
    return {
      html: `
        <section class="card">
          <h2 class="card_title">계약 정보가 없어요</h2>
          <p class="card_desc">보증금, 월세, 납부일을 등록하면 미납 여부를 자동으로 계산해드려요.</p>
          <button type="button" class="btn" data-action="contract">계약 등록하기</button>
        </section>`,
      mount(el) {
        el.querySelector('[data-action=contract]').addEventListener('click', () => openContractForm(ledger));
      },
    };
  }

  return {
    html: `${summaryHtml(a)}${gridHtml(a)}${entriesHtml(ledger, a)}${contractHtml(a)}
      <button type="button" class="fab" data-action="add" aria-label="내역 추가">${ICONS.plus}</button>`,
    mount(el) {
      el.addEventListener('click', (e) => {
        const target = e.target.closest('[data-action],[data-month],[data-entry],[data-filter]');
        if (!target) return;
        const { action, month, entry, filter } = target.dataset;
        if (action === 'add') openRentEntry(ledger);
        if (action === 'contract') openContractForm(ledger, a.current);
        if (action === 'more') {
          limitState.set(ledger.id, (limitState.get(ledger.id) || PAGE_SIZE) + PAGE_SIZE * 2);
          refresh();
        }
        if (month) {
          const row = a.rows.find((r) => r.month === month);
          if (row.entry) openRentEntry(ledger, row.entry);
          else openRentEntry(ledger, null, [month]);
        }
        if (entry) openRentEntry(ledger, state.entries.find((x) => x.id === entry));
        if (filter) {
          filterState.set(ledger.id, filter);
          limitState.delete(ledger.id);
          refresh();
        }
      });
    },
  };
}

/* ---------- 입력 폼 ---------- */

/** 월세 카테고리일 때 '대상 기간'을 칩으로 선택하는 추가 입력 */
const monthPicker = (a) => (box, ctx) => {
  const selected = new Set(splitMonths(ctx.data.months));
  const paidByOther = new Set(a.rows.filter((r) => r.entry && r.entry.id !== ctx.data.id).map((r) => r.month));
  const candidates = a.rows.filter((r) => r.status !== 'paid').map((r) => r.month);
  let tail = a.rows[a.rows.length - 1].month;
  for (let i = 0; i < 3; i++) {
    tail = addMonths(tail, 1);
    candidates.push(tail);
  }
  const options = [...new Set([...candidates, ...selected])].filter((m) => selected.has(m) || !paidByOther.has(m)).sort();
  const rentOf = (m) => Number(contractFor(m, a.contracts).rent) || 0;
  const isRentCategory = () => tagOf(KIND, ctx.getCategory()) === 'rent';

  const draw = () => {
    if (!isRentCategory()) {
      box.innerHTML = '';
      return;
    }
    const picked = [...selected].sort();
    box.innerHTML = `
      <div class="field">
        <span class="field_label">대상 기간 (여러 개 선택 가능)</span>
        <div class="chip_row">
          ${options.map((m) => `<button type="button" class="chip${selected.has(m) ? ' is_active' : ''}" data-pick="${m}" aria-pressed="${selected.has(m)}">${shortMonth(m)}</button>`).join('')}
        </div>
        <p class="field_hint">${picked.length ? picked.map((m) => periodLabel(m, contractFor(m, a.contracts))).join(', ') : '기간을 선택해주세요'}</p>
      </div>`;
  };

  box.addEventListener('click', (e) => {
    const b = e.target.closest('[data-pick]');
    if (!b) return;
    const m = b.dataset.pick;
    if (selected.has(m)) selected.delete(m);
    else selected.add(m);
    ctx.setAmount(sum([...selected], rentOf));
    draw();
  });
  ctx.onChange(draw);
  draw();

  return {
    read() {
      if (!isRentCategory()) return { months: '' };
      if (!selected.size) return { error: '대상 기간을 선택해주세요' };
      return { months: [...selected].sort().join(',') };
    },
  };
};

function openRentEntry(ledger, entry = null, months = null) {
  const a = analyze(ledger);
  const pick = months || (a?.unpaid[0] ? [a.unpaid[0].month] : a?.next ? [a.next.month] : []);
  const rentCategory = state.categories.find((c) => c.kind === KIND && c.tag === 'rent')?.name || '월세';
  openEntryForm({
    ledger,
    entry,
    defaults: {
      flow: 'in',
      category: rentCategory,
      months: pick.join(','),
      amount: a ? sum(pick, (m) => contractFor(m, a.contracts).rent) : '',
    },
    extra: a ? monthPicker(a) : null,
  });
}

function openContractForm(ledger, contract = null, renew = false) {
  const base = contract || {};
  const c = renew
    ? { ...base, id: '', created_at: '', start_date: base.end_date || todayStr(), end_date: '', status: 'active' }
    : { due_day: 15, pay_timing: 'post', status: 'active', ...base };

  openSheet({
    title: renew ? '갱신 계약 추가' : contract ? '계약 정보 수정' : '계약 등록',
    body: `
      <form class="form" novalidate>
        ${renew ? '<p class="card_desc">보증금·월세가 바뀌면 시작일부터 새 금액으로 계산돼요.</p>' : ''}
        <label class="field"><span class="field_label">소재지</span><input class="field_input" name="address" maxlength="100"></label>
        <label class="field"><span class="field_label">임차인</span><input class="field_input" name="tenant" maxlength="50"></label>
        <div class="field_row">
          <label class="field"><span class="field_label">보증금 (원)</span><input class="field_input" name="deposit" inputmode="numeric"></label>
          <label class="field"><span class="field_label">월세 (원)</span><input class="field_input" name="rent" inputmode="numeric"></label>
        </div>
        <div class="field_row">
          <label class="field"><span class="field_label">납부일</span><input class="field_input" name="due_day" type="number" min="1" max="28" inputmode="numeric"></label>
          <label class="field"><span class="field_label">납부 방식</span>
            <select class="field_input" name="pay_timing"><option value="post">후불</option><option value="pre">선불</option></select>
          </label>
        </div>
        <div class="field_row">
          <label class="field"><span class="field_label">시작일</span><input class="field_input" name="start_date" type="date"></label>
          <label class="field"><span class="field_label">종료일</span><input class="field_input" name="end_date" type="date"></label>
        </div>
        <label class="field"><span class="field_label">상태</span>
          <select class="field_input" name="status"><option value="active">계약 중</option><option value="ended">종료 (퇴거)</option></select>
        </label>
        <label class="field"><span class="field_label">메모</span><input class="field_input" name="memo" maxlength="100"></label>
        <div class="btn_row">
          ${contract && !renew ? '<button type="button" class="btn btn_sub" data-renew>갱신 계약 추가</button>' : ''}
          <button type="submit" class="btn">저장</button>
        </div>
      </form>`,
    onMount(body, close) {
      const form = body.querySelector('form');
      const f = form.elements;
      const setDeposit = bindAmountInput(f.deposit, parseAmount);
      const setRent = bindAmountInput(f.rent, parseAmount);
      ['address', 'tenant', 'due_day', 'pay_timing', 'start_date', 'end_date', 'status', 'memo'].forEach((k) => { f[k].value = c[k] ?? ''; });
      setDeposit(c.deposit);
      setRent(c.rent);

      form.querySelector('[data-renew]')?.addEventListener('click', () => {
        close();
        openContractForm(ledger, contract, true);
      });

      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const rent = parseAmount(f.rent.value);
        const dueDay = Number(f.due_day.value);
        if (!f.start_date.value) return toast('시작일을 입력해주세요', true);
        if (!rent) return toast('월세를 입력해주세요', true);
        if (!(dueDay >= 1 && dueDay <= 28)) return toast('납부일은 1~28일 사이로 입력해주세요', true);
        const row = {
          ...c,
          ledger_id: ledger.id,
          address: f.address.value.trim(),
          tenant: f.tenant.value.trim(),
          deposit: parseAmount(f.deposit.value),
          rent,
          due_day: dueDay,
          pay_timing: f.pay_timing.value,
          start_date: f.start_date.value,
          end_date: f.end_date.value,
          status: f.status.value,
          memo: f.memo.value.trim(),
        };
        if (await runTask(e.submitter, () => upsert('contracts', row))) {
          close();
          toast('계약 정보를 저장했어요');
        }
      });
    },
  });
}

export default {
  kind: KIND,
  label: '월세',
  nav: 'building',
  defaultName: '월세',
  description: '계약 정보와 월별 입금·미납을 관리해요',
  categories: {
    in: [['월세', 'rent'], ['보증금', 'deposit'], ['기타수입', '']],
    out: [['보증금 반환', 'deposit'], ['수리비', ''], ['중개수수료', ''], ['세금', ''], ['기타', '']],
  },
  widget,
  view,
};
