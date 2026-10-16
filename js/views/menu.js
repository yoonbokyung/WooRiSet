import { state, upsert, remove } from '../store.js';
import { getModule } from '../modules/index.js';
import { openSheet, runTask, confirmSheet, toast } from '../ui.js';
import { esc } from '../utils.js';

const ledgersOf = (kind) => state.ledgers.filter((l) => l.kind === kind).sort((a, b) => a.sort - b.sort || String(a.created_at).localeCompare(String(b.created_at)));

/**
 * #/m/:kind      → 메뉴 첫 화면
 * #/m/:kind/:id  → 특정 장부(여행 상세 등)
 */
export function menuView(kind, id) {
  const mod = getModule(kind);
  if (!mod) return { title: '메뉴', back: '#/', html: '<p class="empty">없는 메뉴예요</p>' };
  const ledgers = ledgersOf(kind);

  // 여행처럼 첫 화면을 직접 그리는 메뉴
  if (mod.menu) {
    if (!id) return { title: mod.label, nav: kind, ...mod.menu(ledgers) };
    const ledger = ledgers.find((l) => l.id === id);
    if (!ledger) return { title: mod.label, nav: kind, back: `#/m/${kind}`, html: '<p class="empty">기록을 찾을 수 없어요. 새로고침해보세요.</p>' };
    const v = mod.view(ledger);
    return { title: ledger.name, nav: kind, back: `#/m/${kind}`, html: v.html, mount: v.mount, onMenu: () => (mod.settings || openLedgerSettings)(ledger) };
  }

  if (!ledgers.length) {
    return {
      title: mod.label,
      nav: kind,
      html: `
        <section class="card">
          <h2 class="card_title">${esc(mod.label)} 시작하기</h2>
          <p class="card_desc">${esc(mod.description)}</p>
          <button type="button" class="btn" data-action="create">만들기</button>
        </section>`,
      mount(el) {
        el.querySelector('[data-action=create]').addEventListener('click', () => openCreate(mod));
      },
    };
  }

  // 같은 종류가 여러 개면(월세 집 여러 곳 등) 칩으로 전환
  const ledger = ledgers.find((l) => l.id === id) || ledgers[0];
  const v = mod.view(ledger);
  const chips = `
    <div class="chip_row ledger_switch">
      ${ledgers.map((l) => `<a class="chip${l.id === ledger.id ? ' is_active' : ''}" href="#/m/${kind}/${esc(l.id)}" aria-current="${l.id === ledger.id}">${esc(l.name)}</a>`).join('')}
      <button type="button" class="chip" data-action="create">+ 추가</button>
    </div>`;
  return {
    title: mod.label,
    nav: kind,
    html: chips + v.html,
    mount(el) {
      el.querySelector('.ledger_switch [data-action=create]').addEventListener('click', () => openCreate(mod));
      v.mount?.(el);
    },
    onMenu: () => (mod.settings || openLedgerSettings)(ledger),
  };
}

function openCreate(mod) {
  openSheet({
    title: `${mod.label} 추가`,
    body: `
      <form class="form" novalidate>
        <label class="field"><span class="field_label">이름</span><input class="field_input" name="ledger_name" maxlength="30" value="${esc(mod.defaultName || mod.label)}"></label>
        <button type="submit" class="btn">만들기</button>
      </form>`,
    onMount(body, close) {
      const form = body.querySelector('form');
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const name = form.elements.ledger_name.value.trim();
        if (!name) return toast('이름을 입력해주세요', true);
        const sort = Math.max(0, ...state.ledgers.map((l) => l.sort)) + 1;
        let saved;
        if (await runTask(e.submitter, async () => { saved = await upsert('ledgers', { kind: mod.kind, name, sort }); })) {
          close();
          location.hash = `#/m/${mod.kind}/${saved.id}`;
        }
      });
    },
  });
}

function openLedgerSettings(ledger) {
  openSheet({
    title: '설정',
    body: `
      <form class="form" novalidate>
        <label class="field"><span class="field_label">이름</span><input class="field_input" name="ledger_name" maxlength="30" value="${esc(ledger.name)}"></label>
        <label class="field"><span class="field_label">메모</span><input class="field_input" name="ledger_memo" maxlength="100" value="${esc(ledger.memo)}"></label>
        <div class="btn_row">
          <button type="button" class="btn btn_danger" data-delete>삭제</button>
          <button type="submit" class="btn">저장</button>
        </div>
      </form>`,
    onMount(body, close) {
      const form = body.querySelector('form');
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const name = form.elements.ledger_name.value.trim();
        if (!name) return toast('이름을 입력해주세요', true);
        if (await runTask(e.submitter, () => upsert('ledgers', { ...ledger, name, memo: form.elements.ledger_memo.value.trim() }))) {
          close();
          toast('저장했어요');
        }
      });
      form.querySelector('[data-delete]').addEventListener('click', async (e) => {
        if (!(await confirmSheet(`'${ledger.name}'과 모든 내역이 삭제돼요. 삭제할까요?`))) return;
        if (await runTask(e.target, () => remove('ledgers', ledger.id))) {
          close();
          location.hash = `#/m/${ledger.kind}`;
          toast('삭제했어요');
        }
      });
    },
  });
}
