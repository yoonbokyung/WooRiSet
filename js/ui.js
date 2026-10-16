import { ICONS } from './icons.js';
import { esc } from './utils.js';

let toastTimer;

export function toast(message, isError = false) {
  let el = document.querySelector('.toast');
  if (!el) {
    el = document.createElement('div');
    el.className = 'toast';
    el.setAttribute('role', 'status');
    document.body.append(el);
  }
  el.textContent = message;
  el.classList.toggle('is_error', isError);
  requestAnimationFrame(() => el.classList.add('is_show'));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('is_show'), 2200);
}

/**
 * 하단 시트(모달)
 * onMount(body, close) 에서 이벤트를 연결하고, 닫힐 때 onClose가 호출된다.
 */
export function openSheet({ title, body, onMount, onClose }) {
  const wrap = document.createElement('div');
  wrap.className = 'sheet';
  wrap.innerHTML = `
    <div class="sheet_panel" role="dialog" aria-modal="true" aria-label="${esc(title)}">
      <div class="sheet_head">
        <h2 class="sheet_title">${esc(title)}</h2>
        <button type="button" class="icon_btn" data-close aria-label="닫기">${ICONS.close}</button>
      </div>
      <div class="sheet_body">${body}</div>
    </div>`;

  const isTop = () => [...document.querySelectorAll('.sheet')].pop() === wrap;
  const onKey = (e) => { if (e.key === 'Escape' && isTop()) close(); };
  let closed = false;
  function close() {
    if (closed) return;
    closed = true;
    wrap.classList.remove('is_open');
    document.removeEventListener('keydown', onKey);
    setTimeout(() => wrap.remove(), 300);
    onClose?.();
  }

  wrap.addEventListener('click', (e) => {
    if (e.target === wrap || e.target.closest('[data-close]')) close();
  });
  document.addEventListener('keydown', onKey);
  document.body.append(wrap);
  requestAnimationFrame(() => wrap.classList.add('is_open'));
  onMount?.(wrap.querySelector('.sheet_body'), close);
  return close;
}

export function confirmSheet(message, okLabel = '삭제') {
  return new Promise((resolve) => {
    let result = false;
    openSheet({
      title: '확인',
      body: `<p class="confirm_text">${esc(message)}</p>
        <div class="btn_row">
          <button type="button" class="btn btn_sub" data-close>취소</button>
          <button type="button" class="btn btn_danger" data-ok>${esc(okLabel)}</button>
        </div>`,
      onMount(body, close) {
        body.querySelector('[data-ok]').addEventListener('click', () => { result = true; close(); });
      },
      onClose: () => resolve(result),
    });
  });
}

/** 버튼을 잠근 채 비동기 작업을 실행하고, 실패하면 토스트로 알린다. 성공 여부를 반환 */
export async function runTask(button, task) {
  if (button) button.disabled = true;
  try {
    await task();
    return true;
  } catch (err) {
    toast(err.message || '오류가 발생했어요', true);
    return false;
  } finally {
    if (button) button.disabled = false;
  }
}

/** 금액 입력칸: 입력하는 동안 천 단위 콤마 표시 */
export function bindAmountInput(input, parse) {
  const format = (v) => { input.value = v ? Number(v).toLocaleString('ko-KR') : ''; };
  input.addEventListener('input', () => format(parse(input.value)));
  return format;
}
