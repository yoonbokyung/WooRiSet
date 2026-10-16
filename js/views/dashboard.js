import { state, setting } from '../store.js';
import { hasConfig } from '../config.js';
import { MODULES } from '../modules/index.js';

const WEEK = ['일', '월', '화', '수', '목', '금', '토'];

export const familyName = () => setting('family_name') || '우리집';

function greeting() {
  const h = new Date().getHours();
  if (h >= 5 && h < 11) return '좋은 아침이에요';
  if (h >= 11 && h < 17) return '오늘도 힘내요';
  if (h >= 17 && h < 22) return '오늘 하루도 수고했어요';
  return '편안한 밤 보내요';
}

export function dashboardView() {
  const now = new Date();
  const hello = `
    <section class="dash_hello">
      <p class="dash_date">${now.getMonth() + 1}월 ${now.getDate()}일 ${WEEK[now.getDay()]}요일</p>
      <p class="dash_greeting">${greeting()}</p>
    </section>`;

  if (!hasConfig()) {
    return {
      title: familyName(),
      brand: true,
      nav: 'home',
      html: `${hello}
        <section class="card">
          <h2 class="card_title">구글 시트 연결이 필요해요</h2>
          <p class="card_desc">연결하면 가계부·월세·여행 기록을 불러올 수 있어요.</p>
          <a class="btn" href="#/settings">연결 설정하기</a>
        </section>`,
    };
  }

  const widgets = MODULES.map((m) => m.widget(state.ledgers.filter((l) => l.kind === m.kind))).join('');
  return {
    title: familyName(),
    brand: true,
    nav: 'home',
    html: `${hello}${widgets || '<p class="empty">아래 메뉴에서 기록을 시작해보세요</p>'}`,
  };
}
