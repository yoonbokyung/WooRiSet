import { state, sync, clearCache, saveSetting, periodNotes } from '../store.js';
import { getConfig, setConfig, hasConfig, shareLink } from '../config.js';
import { runTask, toast, confirmSheet } from '../ui.js';
import { esc, fmtDate } from '../utils.js';
import { familyName } from './dashboard.js';

export function settingsView() {
  const c = getConfig();
  const notes = periodNotes();
  const saveNotes = (list) => saveSetting('period_notes', JSON.stringify(list.sort((a, b) => a.from.localeCompare(b.from))));
  return {
    title: '설정',
    back: true,
    html: `
      <section class="card">
        <h2 class="card_title">구글 시트 연결</h2>
        <form class="form" data-form="config" novalidate>
          <label class="field">
            <span class="field_label">API 주소 (웹 앱 URL)</span>
            <input class="field_input" name="api_url" type="url" placeholder="https://script.google.com/macros/s/.../exec" value="${esc(c.apiUrl)}">
          </label>
          <label class="field">
            <span class="field_label">API 토큰</span>
            <input class="field_input" name="api_token" type="password" autocomplete="off" value="${esc(c.token)}">
          </label>
          <label class="field">
            <span class="field_label">내 이름 (입력자로 표시)</span>
            <input class="field_input" name="user_name" maxlength="10" placeholder="예) 엄마" value="${esc(c.userName)}">
          </label>
          <button type="submit" class="btn">저장하고 연결 확인</button>
        </form>
      </section>
      ${hasConfig() ? `
      <section class="card">
        <h2 class="card_title">우리 가족</h2>
        <form class="form" data-form="family" novalidate>
          <label class="field">
            <span class="field_label">가족 이름 (홈 화면 제목)</span>
            <input class="field_input" name="family_name" maxlength="20" placeholder="예) 행복한 우리집" value="${esc(familyName())}">
          </label>
          <button type="submit" class="btn">저장</button>
        </form>
      </section>
      <section class="card">
        <h2 class="card_title">기간 메모</h2>
        <p class="card_desc">휴직·이사처럼 특별한 기간을 적어두면 가계부의 해당 달에 표시돼요.</p>
        ${notes.length ? `<ul class="note_list">${notes.map((n, i) => `
          <li class="list_row note_row">
            <span class="list_item_body">
              <span class="list_item_title">${esc(n.label)}</span>
              <span class="list_item_sub">${fmtDate(n.from)}${n.to && n.to !== n.from ? ` ~ ${fmtDate(n.to)}` : ''}</span>
            </span>
            <button type="button" class="text_btn" data-note-delete="${i}" aria-label="${esc(n.label)} 삭제">삭제</button>
          </li>`).join('')}</ul>` : ''}
        <form class="form" data-form="note" novalidate>
          <div class="field_row">
            <label class="field"><span class="field_label">시작</span><input class="field_input" type="month" name="from"></label>
            <label class="field"><span class="field_label">끝</span><input class="field_input" type="month" name="to"></label>
          </div>
          <label class="field"><span class="field_label">내용</span><input class="field_input" name="label" maxlength="30" placeholder="예) 출산·육아휴직"></label>
          <button type="submit" class="btn btn_sub">기간 메모 추가</button>
        </form>
      </section>` : ''}
      <section class="card">
        <h2 class="card_title">데이터</h2>
        <dl class="info_list">
          <dt>마지막 동기화</dt><dd>${state.syncedAt ? new Date(state.syncedAt).toLocaleString('ko-KR') : '-'}</dd>
          <dt>기록장</dt><dd>${state.ledgers.length}개</dd>
          <dt>내역</dt><dd>${state.entries.length}건</dd>
        </dl>
        <div class="btn_row">
          ${hasConfig() ? '<button type="button" class="btn btn_sub" data-action="share">가족 공유 링크</button>' : ''}
          <button type="button" class="btn btn_sub" data-action="clear">캐시 비우기</button>
        </div>
      </section>`,
    mount(el) {
      const form = el.querySelector('[data-form=config]');
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const f = form.elements;
        const apiUrl = f.api_url.value.trim();
        if (!/^https:\/\/script\.google\.com\/.+\/exec$/.test(apiUrl)) {
          return toast(apiUrl.endsWith('/dev') ? '테스트용(/dev) 주소예요. 배포 → 배포 관리에서 /exec로 끝나는 웹 앱 URL을 넣어주세요' : '웹 앱 URL은 https://script.google.com/…/exec 형태예요', true);
        }
        if (apiUrl.includes('/a/macros/')) toast('회사(Workspace) 계정 주소예요. 외부 접근이 막혀 있으면 개인 Gmail 계정으로 배포해주세요');
        if (!f.api_token.value.trim()) return toast('API 토큰을 입력해주세요', true);
        setConfig({ apiUrl: f.api_url.value, token: f.api_token.value, userName: f.user_name.value });
        if (await runTask(e.submitter, sync)) {
          toast('연결됐어요');
          location.hash = '#/';
        }
      });

      const familyForm = el.querySelector('[data-form=family]');
      familyForm?.addEventListener('submit', async (e) => {
        e.preventDefault();
        const name = familyForm.elements.family_name.value.trim();
        if (!name) return toast('가족 이름을 입력해주세요', true);
        if (await runTask(e.submitter, () => saveSetting('family_name', name))) toast('저장했어요');
      });

      const noteForm = el.querySelector('[data-form=note]');
      noteForm?.addEventListener('submit', async (e) => {
        e.preventDefault();
        const f = noteForm.elements;
        const note = { from: f.from.value, to: f.to.value || f.from.value, label: f.label.value.trim() };
        if (!note.from || !note.label) return toast('시작 월과 내용을 입력해주세요', true);
        if (note.to < note.from) return toast('끝 월이 시작 월보다 빨라요', true);
        if (await runTask(e.submitter, () => saveNotes([...notes, note]))) toast('기간 메모를 추가했어요');
      });

      el.addEventListener('click', async (e) => {
        const del = e.target.closest('[data-note-delete]');
        if (del && (await confirmSheet('이 기간 메모를 삭제할까요?'))) {
          const index = Number(del.dataset.noteDelete);
          if (await runTask(null, () => saveNotes(notes.filter((_, i) => i !== index)))) toast('삭제했어요');
        }
        const action = e.target.closest('[data-action]')?.dataset.action;
        if (action === 'share') {
          try {
            await navigator.clipboard.writeText(shareLink());
            toast('링크를 복사했어요. 가족에게만 보내주세요');
          } catch {
            toast('복사하지 못했어요', true);
          }
        }
        if (action === 'clear' && (await confirmSheet('기기에 저장된 데이터를 지울까요? 구글 시트의 데이터는 그대로 남아요.', '비우기'))) {
          clearCache();
          toast('캐시를 비웠어요');
        }
      });
    },
  };
}
