import { upsert, remove, categoriesOf } from './store.js';
import { getConfig } from './config.js';
import { openSheet, runTask, confirmSheet, toast, bindAmountInput } from './ui.js';
import { esc, todayStr, parseAmount } from './utils.js';

/**
 * 모든 장부가 공유하는 입출금 입력 폼.
 * 장부 종류별 추가 입력이 필요하면 extra(box, ctx)를 넘긴다.
 *   ctx: { data, setAmount, getCategory, onChange(fn) }
 *   반환: { read() } → 저장할 추가 필드 객체 (검증 실패 시 { error })
 */
export function openEntryForm({ ledger, entry = null, defaults = {}, extra = null }) {
  const data = { flow: 'out', date: todayStr(), category: '', amount: '', memo: '', months: '', ...defaults, ...(entry || {}) };

  openSheet({
    title: entry ? '내역 수정' : '내역 추가',
    body: `
      <form class="form" novalidate>
        <div class="segment" role="group" aria-label="구분">
          <button type="button" class="segment_btn" data-flow="in">수입</button>
          <button type="button" class="segment_btn" data-flow="out">지출</button>
        </div>
        <div class="field_row">
          <label class="field"><span class="field_label">날짜</span><input class="field_input" type="date" name="date"></label>
          <label class="field"><span class="field_label">카테고리</span><select class="field_input" name="category"></select></label>
        </div>
        <label class="field"><span class="field_label">금액 (원)</span><input class="field_input" name="amount" inputmode="numeric" placeholder="0"></label>
        <div class="field_extra"></div>
        <label class="field"><span class="field_label">메모</span><input class="field_input" name="memo" maxlength="100"></label>
        <div class="btn_row">
          ${entry ? '<button type="button" class="btn btn_danger" data-delete>삭제</button>' : ''}
          <button type="submit" class="btn">저장</button>
        </div>
      </form>`,
    onMount(body, close) {
      const form = body.querySelector('form');
      const f = form.elements;
      let flow = data.flow;
      const setAmount = bindAmountInput(f.amount, parseAmount);

      const renderFlow = () => {
        form.querySelectorAll('[data-flow]').forEach((b) => {
          const on = b.dataset.flow === flow;
          b.classList.toggle('is_active', on);
          b.setAttribute('aria-pressed', on);
        });
        const names = categoriesOf(ledger.kind, flow).map((c) => c.name);
        // 시트에서 지워진 카테고리로 저장된 내역도 그대로 수정할 수 있게 유지
        if (flow === data.flow && data.category && !names.includes(data.category)) names.unshift(data.category);
        const current = f.category.value;
        f.category.innerHTML = names.map((n) => `<option value="${esc(n)}">${esc(n)}</option>`).join('');
        if (names.includes(current)) f.category.value = current;
        else if (names.includes(data.category)) f.category.value = data.category;
      };
      const emit = () => form.dispatchEvent(new Event('entry_change'));

      form.addEventListener('click', (e) => {
        const b = e.target.closest('[data-flow]');
        if (!b) return;
        flow = b.dataset.flow;
        renderFlow();
        emit();
      });
      f.category.addEventListener('change', emit);

      f.date.value = data.date;
      f.memo.value = data.memo;
      setAmount(data.amount);
      renderFlow();

      const ext = extra?.(form.querySelector('.field_extra'), {
        data,
        setAmount,
        getCategory: () => f.category.value,
        onChange: (fn) => form.addEventListener('entry_change', fn),
      });

      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const amount = parseAmount(f.amount.value);
        if (!f.date.value) return toast('날짜를 선택해주세요', true);
        if (!f.category.value) return toast('카테고리를 선택해주세요', true);
        if (!amount) return toast('금액을 입력해주세요', true);
        const extraData = ext?.read() || {};
        if (extraData.error) return toast(extraData.error, true);

        const row = {
          ...(entry || {}),
          ledger_id: ledger.id,
          flow,
          date: f.date.value,
          category: f.category.value,
          amount,
          memo: f.memo.value.trim(),
          months: '',
          by: entry?.by || getConfig().userName,
          account: data.account || '',
          ...extraData,
        };
        if (await runTask(e.submitter, () => upsert('entries', row))) {
          close();
          toast('저장했어요');
        }
      });

      form.querySelector('[data-delete]')?.addEventListener('click', async (e) => {
        if (!(await confirmSheet('이 내역을 삭제할까요?'))) return;
        if (await runTask(e.target, () => remove('entries', entry.id))) {
          close();
          toast('삭제했어요');
        }
      });
    },
  });
}
