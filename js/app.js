import { state, loadCache, sync, insertMany, upsert, events } from './store.js';
import { hasConfig, importConfigFromUrl } from './config.js';
import { MODULES } from './modules/index.js';
import { dashboardView } from './views/dashboard.js';
import { menuView } from './views/menu.js';
import { settingsView } from './views/settings.js';
import { ICONS } from './icons.js';
import { toast } from './ui.js';
import { hydratePhotos } from './photos.js';
import { esc } from './utils.js';

const header = document.getElementById('app_header');
const main = document.getElementById('app');
const bottomNav = document.getElementById('bottom_nav');
const ROUTES = [
  [/^#\/m\/(\w+)(?:\/([\w-]+))?$/, menuView],
  [/^#\/settings$/, settingsView],
  [/.*/, dashboardView],
];
const NAV = [
  { kind: 'home', label: '홈', icon: 'home', href: '#/' },
  ...MODULES.map((m) => ({ kind: m.kind, label: m.label, icon: m.nav, href: `#/m/${m.kind}` })),
];

let currentHash = '';
let currentView = null;

function render() {
  const hash = location.hash || '#/';
  const [re, view] = ROUTES.find(([r]) => r.test(hash));
  currentView = view(...hash.match(re).slice(1));

  header.innerHTML = `
    ${currentView.back ? `<button type="button" class="icon_btn" data-nav="back" aria-label="뒤로">${ICONS.back}</button>` : ''}
    <h1 class="app_header_title${currentView.brand ? ' is_brand' : ''}">${esc(currentView.title)}</h1>
    <button type="button" class="icon_btn" data-nav="sync" aria-label="새로고침">${ICONS.sync}</button>
    ${currentView.onMenu ? `<button type="button" class="icon_btn" data-nav="menu" aria-label="설정">${ICONS.more}</button>` : ''}
    ${currentView.back || currentView.onMenu ? '' : `<a class="icon_btn" href="#/settings" aria-label="앱 설정">${ICONS.settings}</a>`}`;

  bottomNav.innerHTML = NAV.map((n) => {
    const active = currentView.nav === n.kind;
    return `<a class="bottom_nav_item${active ? ' is_active' : ''}" href="${n.href}"${active ? ' aria-current="page"' : ''}>${ICONS[n.icon]}<span>${n.label}</span></a>`;
  }).join('');

  // 화면마다 새 컨테이너를 만들어 이벤트 리스너가 쌓이지 않게 한다
  const page = document.createElement('div');
  page.className = 'page';
  page.innerHTML = currentView.html;
  main.replaceChildren(page);
  currentView.mount?.(page);
  hydratePhotos(page);

  if (hash !== currentHash) {
    window.scrollTo(0, 0);
    currentHash = hash;
  }
}

/** 모듈에 정의된 기본 카테고리 중 시트에 없는 것을 등록 (동시 호출 시 한 번만 실행) */
let ensuring = null;
function ensureCategories() {
  ensuring ??= addMissingCategories().finally(() => { ensuring = null; });
  return ensuring;
}

async function addMissingCategories() {
  const kinds = new Set(state.ledgers.map((l) => l.kind));
  const find = (c) => state.categories.find((x) => x.kind === c.kind && x.flow === c.flow && x.name === c.name);
  const defaults = MODULES
    .filter((m) => kinds.has(m.kind) && m.categories)
    .flatMap((m) => ['in', 'out'].flatMap((flow) => (m.categories[flow] || [])
      .map(([name, tag], i) => ({ kind: m.kind, flow, name, tag, sort: i + 1 }))));
  const missing = defaults.filter((c) => !find(c));
  if (missing.length) await insertMany('categories', missing);
  // 기본 카테고리의 합계 처리 방식(tag)이 바뀌었으면 시트에도 반영 (예: 환급·환불 → refund)
  for (const c of defaults) {
    const saved = find(c);
    if (saved && saved.tag !== c.tag) await upsert('categories', { ...saved, tag: c.tag });
  }
}

async function doSync(notify) {
  if (!hasConfig()) {
    if (notify) toast('설정에서 API 주소와 토큰을 먼저 입력해주세요', true);
    return;
  }
  header.querySelector('[data-nav=sync]')?.classList.add('is_spin');
  try {
    await sync();
    if (notify) toast('최신 데이터로 갱신했어요');
    // 모듈별 후처리 (예: 가계부가 폰에서 자동 전송된 은행 문자를 분류해서 넣기 — 넣은 건수 알림이 보이도록 마지막에)
    await Promise.all(MODULES.map((m) => m.onSync?.()));
  } catch (err) {
    toast(err.message, true);
  } finally {
    header.querySelector('[data-nav=sync]')?.classList.remove('is_spin');
  }
}

header.addEventListener('click', (e) => {
  const nav = e.target.closest('[data-nav]')?.dataset.nav;
  if (nav === 'back') location.hash = typeof currentView.back === 'string' ? currentView.back : '#/';
  if (nav === 'sync') doSync(true);
  if (nav === 'menu') currentView.onMenu();
});

// 수입 금액(.secret)은 가려져 있다가 처음 누르면 화면 전체에서 보이게 (새로 열면 다시 가려짐). 링크·내역 열기는 막는다
document.addEventListener('click', (e) => {
  const root = document.documentElement;
  if (root.classList.contains('is_secret_shown') || !e.target.closest('.secret')) return;
  e.preventDefault();
  e.stopPropagation();
  root.classList.add('is_secret_shown');
}, true);

events.addEventListener('change', render);
// 동기화하거나 새 장부를 만들면 해당 종류의 카테고리를 바로 준비
events.addEventListener('change', () => { if (hasConfig()) ensureCategories().catch((err) => toast(err.message, true)); });
window.addEventListener('hashchange', render);

// 예전 주소(#/ledger/:id)로 열면 홈으로
if (location.hash.startsWith('#/ledger/')) history.replaceState(null, '', '#/');

// 다른 앱에서 '공유 → 우리셋'로 보낸 글 (manifest의 share_target)
const params = new URLSearchParams(location.search);
const sharedText = ['shared_title', 'shared_text', 'shared_url'].map((k) => params.get(k)).filter(Boolean).join('\n');
if (sharedText) history.replaceState(null, '', `${location.pathname}#/`);

importConfigFromUrl();
loadCache();
render();
doSync(false).then(() => {
  if (sharedText) MODULES.find((m) => m.onShare)?.onShare(sharedText);
});

// 새 버전이 설치되면 알려주고, 앱으로 돌아올 때마다 새 버전이 있는지 확인한다
if ('serviceWorker' in navigator) {
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.register('./sw.js').then((reg) => {
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') reg.update(); });
  });
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (hadController) showUpdateBar(); });
}

function showUpdateBar() {
  if (document.querySelector('.update_bar')) return;
  const bar = document.createElement('div');
  bar.className = 'update_bar';
  bar.setAttribute('role', 'status');
  bar.innerHTML = '<span>새 버전이 있어요</span><button type="button" class="update_bar_btn">새로고침</button>';
  bar.querySelector('button').addEventListener('click', () => location.reload());
  document.body.append(bar);
}
