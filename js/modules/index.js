/**
 * 메뉴(기록 종류) 레지스트리 — 배열 순서대로 하단 메뉴와 홈 대시보드에 표시된다.
 *
 * 새 메뉴를 추가하려면 모듈 파일을 만들고 여기에 등록한다.
 * 모듈 인터페이스:
 *   kind        : ledgers 시트의 kind 값 (영문)
 *   label       : 메뉴 이름
 *   nav         : 하단 메뉴·위젯 아이콘 (icons.js 키)
 *   description : 메뉴 설명
 *   defaultName : 처음 만들 때 기본 이름
 *   widget(ledgers) → 홈 대시보드 카드 HTML (해당 종류의 장부 목록을 받는다)
 *   view(ledger)    → { html, mount(el) } 장부 상세 화면
 *   menu(ledgers)   → (선택) 메뉴 첫 화면을 직접 그릴 때. 없으면 장부 전환 칩 + view
 *   settings(ledger)→ (선택) 헤더 ⋮ 메뉴. 없으면 이름 변경·삭제 기본 시트
 *   categories      → (선택) 금액 장부의 기본 카테고리 { in: [[이름, tag]], out: [...] }
 *   onSync()        → (선택) 동기화가 끝날 때마다 실행 (예: 받은 문자함 처리)
 *   onShare(text)   → (선택) 다른 앱에서 '공유'로 글을 받았을 때
 */
import household from './household.js';
import rent from './rent.js';
import travel from './travel.js';

export const MODULES = [household, rent, travel];

export const getModule = (kind) => MODULES.find((m) => m.kind === kind);
