import { state, byLedger, upsert, remove, setting, saveSetting } from '../store.js';
import { openSheet, runTask, toast, confirmSheet } from '../ui.js';
import { hydratePhotos } from '../photos.js';
import { createMap } from '../map.js';
import { readPhotos, readDrivePhotos, splitTrips, groupTrips, locatePlaces, mainArea, saveTrip } from '../trip_import.js';
import { ICONS } from '../icons.js';
import { esc, todayStr, fmtDate, fmtDay, parseJson, daysBetween } from '../utils.js';

const KIND = 'travel';

/* ---------- 계산 ---------- */

const metaOf = (ledger) => parseJson(ledger.meta);

function photosOf(ledgerId) {
  return byLedger('records', ledgerId)
    .filter((r) => r.type === 'photo')
    .map((r) => ({ ...r, d: parseJson(r.data) }))
    .sort((a, b) => `${a.date} ${a.d.time || ''}`.localeCompare(`${b.date} ${b.d.time || ''}`));
}

const sortTrips = (ledgers) => ledgers.slice().sort((a, b) => (metaOf(b).start || '').localeCompare(metaOf(a).start || ''));
const hasGps = (p) => p.d.lat !== null && p.d.lat !== undefined && p.d.lat !== '';

function nightsOf(meta) {
  return meta.start ? daysBetween(meta.start, meta.end || meta.start) : 0;
}

function rangeLabel(meta) {
  if (!meta.start) return '날짜 미정';
  const n = nightsOf(meta);
  return `${fmtDate(meta.start)}${n ? ` – ${fmtDate(meta.end).slice(5)}` : ''} · ${n ? `${n}박 ${n + 1}일` : '당일'}`;
}

function centerOf(photos) {
  const pts = photos.filter(hasGps);
  if (!pts.length) return null;
  return { lat: pts.reduce((s, p) => s + Number(p.d.lat), 0) / pts.length, lng: pts.reduce((s, p) => s + Number(p.d.lng), 0) / pts.length };
}

const coverOf = (ledger, photos) => metaOf(ledger).cover || photos[0]?.thumb_id || '';

const coverImg = (id, cls) => (id ? `<img class="${cls}" data-photo="${esc(id)}" alt="">` : `<span class="${cls} is_empty">${ICONS.image}</span>`);

/** 같은 날 연속으로 같은 장소에서 찍은 사진끼리 묶기 */
function groupByDay(photos, start) {
  const days = [];
  photos.forEach((p) => {
    let day = days[days.length - 1];
    if (!day || day.date !== p.date) {
      day = { date: p.date, index: start ? daysBetween(start, p.date) + 1 : days.length + 1, places: [] };
      days.push(day);
    }
    const label = p.d.place || (hasGps(p) ? '이름 없는 장소' : '위치 정보 없음');
    let place = day.places[day.places.length - 1];
    if (!place || place.label !== label) {
      place = { label, time: p.d.time || '', photos: [] };
      day.places.push(place);
    }
    place.photos.push(p);
  });
  return days;
}

/* ---------- 홈 위젯 ---------- */

function widget(ledgers) {
  const trips = sortTrips(ledgers);
  const head = `<div class="widget_head"><span class="widget_icon">${ICONS.plane}</span><strong class="widget_title">여행</strong>${ICONS.next}</div>`;
  if (!trips.length) {
    return `<a class="widget" href="#/m/travel">${head}<p class="widget_sub">사진을 한 번에 올리면 날짜와 장소로 여행 기록을 만들어드려요</p></a>`;
  }
  const latest = trips[0];
  const meta = metaOf(latest);
  const photos = photosOf(latest.id);
  const year = todayStr().slice(0, 4);
  const thisYear = trips.filter((t) => (metaOf(t).start || '').startsWith(year)).length;
  return `
    <a class="widget" href="#/m/travel/${esc(latest.id)}">
      ${head}
      <div class="widget_trip">
        ${coverImg(coverOf(latest, photos), 'widget_trip_cover')}
        <div class="widget_trip_body">
          <p class="widget_trip_name">${esc(latest.name)}</p>
          <p class="widget_sub">${rangeLabel(meta)}</p>
          <p class="widget_sub">올해 여행 ${thisYear}번 · 전체 ${trips.length}번</p>
        </div>
      </div>
    </a>`;
}

/* ---------- 여행 목록 (메뉴 첫 화면) ---------- */

function menu(ledgers) {
  const trips = sortTrips(ledgers);
  const all = trips.map((t) => ({ trip: t, photos: photosOf(t.id) }));
  const totalDays = trips.reduce((s, t) => s + (metaOf(t).start ? nightsOf(metaOf(t)) + 1 : 0), 0);
  const totalPhotos = all.reduce((s, x) => s + x.photos.length, 0);
  const pins = all.map((x, i) => ({ ...centerOf(x.photos), label: trips.length - i, title: x.trip.name, href: `#/m/travel/${x.trip.id}` })).filter((p) => p.lat);

  const importBtn = '<button type="button" class="btn" data-action="import">사진으로 여행 기록 만들기</button>';
  if (!trips.length) {
    return {
      html: `
        <section class="card travel_intro">
          <span class="travel_intro_icon">${ICONS.map}</span>
          <h2 class="card_title">우리 가족 여행 지도</h2>
          <p class="card_desc">여행 사진을 한꺼번에 고르면 찍은 날짜로 여행을 나누고, 사진 속 위치로 장소와 이동 경로를 그려드려요.</p>
          ${importBtn}
        </section>
        <button type="button" class="dashed_btn" data-action="new">+ 사진 없이 직접 만들기</button>`,
      mount: mountMenu,
    };
  }

  return {
    html: `
      <section class="card">
        <div class="stat_grid travel_stats">
          <div class="stat_item"><p class="stat_label">여행</p><p class="stat_value">${trips.length}번</p></div>
          <div class="stat_item"><p class="stat_label">여행한 날</p><p class="stat_value">${totalDays}일</p></div>
        </div>
        <p class="hero_sub">사진 ${totalPhotos.toLocaleString('ko-KR')}장으로 기록했어요</p>
      </section>
      ${pins.length ? '<section class="card"><h2 class="card_title">우리가 다녀온 곳</h2><div class="map" data-map="all"></div></section>' : ''}
      ${importBtn}
      <h2 class="section_label">여행 목록</h2>
      ${all.map(({ trip, photos }) => {
        const meta = metaOf(trip);
        return `
          <a class="trip_card" href="#/m/travel/${esc(trip.id)}">
            ${coverImg(coverOf(trip, photos), 'trip_card_cover')}
            <span class="trip_card_body">
              <strong class="trip_card_name">${esc(trip.name)}</strong>
              <span class="trip_card_sub">${rangeLabel(meta)}</span>
              <span class="trip_card_sub">${[meta.area, photos.length ? `사진 ${photos.length}장` : ''].filter(Boolean).map(esc).join(' · ')}</span>
            </span>
          </a>`;
      }).join('')}
      <button type="button" class="dashed_btn" data-action="new">+ 사진 없이 직접 만들기</button>`,
    mount(el) {
      mountMenu(el);
      const mapEl = el.querySelector('[data-map=all]');
      if (mapEl) createMap(mapEl, { markers: pins });
    },
  };
}

function mountMenu(el) {
  el.addEventListener('click', (e) => {
    const action = e.target.closest('[data-action]')?.dataset.action;
    if (action === 'import') openImport();
    if (action === 'new') openTripForm();
  });
}

/* ---------- 여행 상세 ---------- */

function view(ledger) {
  const meta = metaOf(ledger);
  const photos = photosOf(ledger.id);
  const days = groupByDay(photos, meta.start);
  const placeCount = new Set(photos.map((p) => p.d.place).filter(Boolean)).size;
  const route = photos.filter(hasGps).map((p) => ({ lat: Number(p.d.lat), lng: Number(p.d.lng) }));
  const pins = days.flatMap((day) => day.places
    .map((place) => place.photos.find(hasGps))
    .filter(Boolean)
    .map((p) => ({ lat: Number(p.d.lat), lng: Number(p.d.lng), label: day.index, title: `${day.index}일차 ${p.d.place || ''}` })));

  return {
    html: `
      <section class="trip_hero">
        ${coverImg(coverOf(ledger, photos), 'trip_hero_cover')}
        <div class="trip_hero_body">
          <p class="trip_hero_name">${esc(ledger.name)}</p>
          <p class="trip_hero_sub">${rangeLabel(meta)}${meta.area ? ` · ${esc(meta.area)}` : ''}</p>
        </div>
      </section>
      <section class="card">
        <div class="stat_grid travel_stats">
          <div class="stat_item"><p class="stat_label">사진</p><p class="stat_value">${photos.length}장</p></div>
          <div class="stat_item"><p class="stat_label">다녀온 장소</p><p class="stat_value">${placeCount}곳</p></div>
        </div>
        ${meta.memo ? `<p class="trip_memo">${esc(meta.memo)}</p>` : ''}
      </section>
      ${route.length ? '<section class="card"><h2 class="card_title">이동 경로</h2><div class="map" data-map="trip"></div><p class="field_hint map_hint">핀 숫자는 여행 일차예요</p></section>' : ''}
      ${days.length ? days.map((day) => `
        <section class="card">
          <h2 class="card_title">${day.index}일차 <span class="field_hint">${fmtDay(day.date)}</span></h2>
          ${day.places.map((place) => `
            <div class="place_block">
              <p class="place_name"><span class="place_label">${ICONS.pin}${esc(place.label)}</span><span class="place_time">${esc(place.time)}</span></p>
              <div class="photo_strip">
                ${place.photos.map((p) => `<button type="button" class="photo_thumb" data-photo-id="${esc(p.id)}" aria-label="${esc(place.label)} 사진 ${esc(p.d.time || '')}"><img data-photo="${esc(p.thumb_id)}" alt=""></button>`).join('')}
              </div>
            </div>`).join('')}
        </section>`).join('') : '<section class="card"><p class="empty">오른쪽 아래 + 버튼으로 사진을 올려보세요</p></section>'}
      <button type="button" class="fab" data-action="add" aria-label="사진 추가">${ICONS.plus}</button>`,
    mount(el) {
      const mapEl = el.querySelector('[data-map=trip]');
      if (mapEl) createMap(mapEl, { points: route, markers: pins });
      el.addEventListener('click', (e) => {
        const target = e.target.closest('[data-action],[data-photo-id]');
        if (!target) return;
        if (target.dataset.action === 'add') openImport(ledger);
        if (target.dataset.photoId) openPhoto(ledger, photos.find((p) => p.id === target.dataset.photoId));
      });
    },
  };
}

function openPhoto(ledger, photo) {
  const isCover = metaOf(ledger).cover === photo.thumb_id;
  openSheet({
    title: photo.d.place || fmtDate(photo.date),
    body: `
      <img class="photo_full" data-photo="${esc(photo.file_id)}" alt="${esc(photo.d.place || '여행 사진')}">
      <p class="photo_meta">${fmtDay(photo.date)} ${esc(photo.d.time || '')}${photo.d.area ? ` · ${esc(photo.d.area)}` : ''}</p>
      <form class="form photo_form" novalidate>
        <label class="field"><span class="field_label">한 줄 메모</span><input class="field_input" name="title" maxlength="60" value="${esc(photo.title)}" placeholder="예) 바다 보며 먹은 아침"></label>
        <div class="btn_row">
          <button type="button" class="btn btn_danger" data-delete>삭제</button>
          ${isCover ? '' : '<button type="button" class="btn btn_sub" data-cover>대표 사진으로</button>'}
          <button type="submit" class="btn">저장</button>
        </div>
      </form>`,
    onMount(body, close) {
      hydratePhotos(body);
      const form = body.querySelector('form');
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const { d, ...record } = photo;
        if (await runTask(e.submitter, () => upsert('records', { ...record, title: form.elements.title.value.trim() }))) {
          close();
          toast('저장했어요');
        }
      });
      form.querySelector('[data-cover]')?.addEventListener('click', async (e) => {
        const meta = { ...metaOf(ledger), cover: photo.thumb_id };
        if (await runTask(e.target, () => upsert('ledgers', { ...ledger, meta: JSON.stringify(meta) }))) {
          close();
          toast('대표 사진으로 정했어요');
        }
      });
      form.querySelector('[data-delete]').addEventListener('click', async (e) => {
        if (!(await confirmSheet('이 사진을 삭제할까요? 구글 드라이브에서도 휴지통으로 이동해요.'))) return;
        if (await runTask(e.target, () => remove('records', photo.id))) {
          close();
          toast('삭제했어요');
        }
      });
    },
  });
}

/* ---------- 여행 정보 수정 (헤더 ⋮ 메뉴) ---------- */

function openTripForm(ledger = null) {
  const meta = ledger ? metaOf(ledger) : {};
  openSheet({
    title: ledger ? '여행 정보' : '여행 만들기',
    body: `
      <form class="form" novalidate>
        <label class="field"><span class="field_label">여행 이름</span><input class="field_input" name="trip_name" maxlength="30" placeholder="예) 제주 여름휴가"></label>
        <div class="field_row">
          <label class="field"><span class="field_label">시작일</span><input class="field_input" type="date" name="start"></label>
          <label class="field"><span class="field_label">종료일</span><input class="field_input" type="date" name="end"></label>
        </div>
        <label class="field"><span class="field_label">지역</span><input class="field_input" name="area" maxlength="30" placeholder="예) 제주특별자치도"></label>
        <label class="field"><span class="field_label">메모</span><textarea class="field_input field_textarea" name="memo" maxlength="500"></textarea></label>
        <div class="btn_row">
          ${ledger ? '<button type="button" class="btn btn_danger" data-delete>여행 삭제</button>' : ''}
          <button type="submit" class="btn">저장</button>
        </div>
      </form>`,
    onMount(body, close) {
      const form = body.querySelector('form');
      const f = form.elements;
      f.trip_name.value = ledger?.name || '';
      f.start.value = meta.start || todayStr();
      f.end.value = meta.end || meta.start || todayStr();
      f.area.value = meta.area || '';
      f.memo.value = meta.memo || '';

      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const name = f.trip_name.value.trim();
        if (!name) return toast('여행 이름을 입력해주세요', true);
        if (f.end.value < f.start.value) return toast('종료일이 시작일보다 빨라요', true);
        const nextMeta = { ...meta, start: f.start.value, end: f.end.value, area: f.area.value.trim(), memo: f.memo.value.trim() };
        let saved;
        if (await runTask(e.submitter, async () => { saved = await upsert('ledgers', { ...(ledger || { kind: KIND, sort: 0 }), name, meta: JSON.stringify(nextMeta) }); })) {
          close();
          if (!ledger) location.hash = `#/m/travel/${saved.id}`;
          toast('저장했어요');
        }
      });

      form.querySelector('[data-delete]')?.addEventListener('click', async (e) => {
        if (!(await confirmSheet(`'${ledger.name}'과 사진이 모두 삭제돼요. 삭제할까요?`))) return;
        if (await runTask(e.target, () => remove('ledgers', ledger.id))) {
          close();
          location.hash = '#/m/travel';
          toast('여행을 삭제했어요');
        }
      });
    },
  });
}

/* ---------- 사진으로 여행 만들기 ---------- */

/** 이미 여행에 들어간 드라이브 원본 사진 id */
const importedSourceIds = () => new Set(state.records
  .filter((r) => r.type === 'photo')
  .map((r) => parseJson(r.data).source_id)
  .filter(Boolean));

function openImport(trip = null) {
  let closeSheet;
  let busy = false;
  openSheet({
    title: trip ? '사진 추가' : '사진으로 여행 만들기',
    body: `
      <div class="import_body">
        <label class="import_pick">
          <input type="file" accept="image/*" multiple class="blind" name="photos">
          <span class="import_pick_icon">${ICONS.camera}</span>
          <strong>이 기기에서 사진 고르기</strong>
          <span class="field_hint">여러 장을 한 번에 골라주세요. 찍은 날짜와 위치로 ${trip ? '일정에 맞춰 넣어드려요' : '여행을 나눠드려요'}.</span>
        </label>
        <div class="import_or"><span>또는</span></div>
        <form class="form import_drive" novalidate>
          <label class="field">
            <span class="field_label">구글 드라이브 폴더 (이름 또는 링크)</span>
            <input class="field_input" name="folder" placeholder="예) 여행사진" value="${esc(setting('travel_folder'))}">
          </label>
          <p class="field_hint">드라이브에 올려둔 사진을 가져와요. 폴더 안에 여행별 하위 폴더가 있으면 하위 폴더 하나가 여행 하나가 되고, 폴더 이름이 여행 이름이 돼요. 위치 정보가 지워지지 않아 폰에서는 이 방법을 추천해요.</p>
          <button type="submit" class="btn btn_sub">${ICONS.folder}<span>드라이브 폴더에서 가져오기</span></button>
        </form>
      </div>`,
    onMount(body, close) {
      closeSheet = close;
      body.querySelector('input[type=file]').addEventListener('change', (e) => {
        const files = [...e.target.files];
        if (files.length) analyze(body, { files });
      });
      const driveForm = body.querySelector('.import_drive');
      driveForm.addEventListener('submit', (e) => {
        e.preventDefault();
        const folder = driveForm.elements.folder.value.trim();
        if (!folder) return toast('드라이브 폴더 이름이나 링크를 넣어주세요', true);
        analyze(body, { folder });
      });
    },
    onClose: () => { if (busy) toast('사진은 계속 올라가고 있어요. 완료되면 알려드릴게요'); },
  });

  async function analyze(body, source) {
    const box = body.querySelector('.import_body');
    const progress = (label, n, total) => {
      box.innerHTML = `<div class="import_progress"><p>${label} ${n}/${total}</p><div class="cat_bar_track"><div class="cat_bar_fill" style="width:${Math.round((n / total) * 100)}%"></div></div></div>`;
    };
    let photos;
    let skipped = 0;
    if (source.files) {
      progress('사진 정보 읽는 중', 0, source.files.length);
      photos = await readPhotos(source.files, (n, t) => progress('사진 정보 읽는 중', n, t));
    } else {
      box.innerHTML = '<div class="import_progress"><p>드라이브 폴더 읽는 중…</p></div>';
      try {
        const result = await readDrivePhotos(source.folder, importedSourceIds());
        photos = result.photos;
        skipped = result.total - photos.length;
        saveSetting('travel_folder', source.folder).catch(() => {});
      } catch (err) {
        box.innerHTML = `<p class="alert">${esc(err.message)}</p>`;
        return;
      }
      if (!photos.length) {
        box.innerHTML = `<p class="empty">새로 가져올 사진이 없어요${skipped ? `<br>(이미 가져온 사진 ${skipped}장)` : ''}</p>`;
        return;
      }
    }
    box.innerHTML = '<div class="import_progress"><p>장소 찾는 중…</p></div>';
    const groups = trip ? [{ start: photos[0].date, end: photos[photos.length - 1].date, photos }] : source.files ? splitTrips(photos) : groupTrips(photos);
    for (const g of groups) await locatePlaces(g.photos);
    const noGps = photos.every((p) => p.lat === null);

    box.innerHTML = `
      ${noGps ? `<p class="alert">사진에 위치 정보가 없어요. ${source.files ? '폰 브라우저에서 고르면 위치가 지워지는 경우가 있어요. 드라이브 폴더로 가져오면 위치가 그대로 남아요.' : '사진을 찍을 때 위치 저장이 꺼져 있었을 수 있어요.'} (날짜별 기록은 그대로 만들어져요)</p>` : ''}
      ${skipped ? `<p class="field_hint">이미 가져온 사진 ${skipped}장은 건너뛰어요</p>` : ''}
      <ul class="import_groups">
        ${groups.map((g, i) => `
          <li class="import_group">
            ${trip ? '' : `<label class="check_field"><input type="checkbox" name="use_${i}" checked> 여행 ${i + 1}</label>`}
            ${trip ? `<p class="import_group_name">${esc(trip.name)}</p>` : `<input class="field_input" name="name_${i}" maxlength="30" value="${esc(defaultName(g))}" aria-label="여행 ${i + 1} 이름">`}
            <p class="field_hint">${fmtDate(g.start)}${g.end !== g.start ? ` – ${fmtDate(g.end).slice(5)}` : ''} · 사진 ${g.photos.length}장 · 위치 ${g.photos.filter((p) => p.lat !== null).length}장${mainArea(g.photos) ? ` · ${esc(mainArea(g.photos))}` : ''}</p>
          </li>`).join('')}
      </ul>
      <button type="button" class="btn" data-start>${trip ? `사진 ${photos.length}장 넣기` : '여행 기록 만들기'}</button>`;

    box.querySelector('[data-start]').addEventListener('click', async () => {
      const picked = groups
        .map((g, i) => ({ ...g, name: trip ? trip.name : box.querySelector(`[name=name_${i}]`).value.trim() || defaultName(g), use: trip || box.querySelector(`[name=use_${i}]`).checked }))
        .filter((g) => g.use);
      if (!picked.length) return toast('만들 여행을 선택해주세요', true);
      const total = picked.reduce((sum, g) => sum + g.photos.length, 0);
      let sent = 0;
      let failed = 0;
      let last = null;
      busy = true;
      progress('사진 올리는 중', 0, total);
      try {
        for (const g of picked) {
          const base = sent;
          const result = await saveTrip({ trip, name: g.name, photos: g.photos, onProgress: (n) => progress('사진 올리는 중', (sent = base + n), total) });
          failed += result.failed;
          last = result.ledger;
        }
      } catch (err) {
        toast(err.message || '저장하지 못했어요', true);
      }
      busy = false;
      closeSheet();
      if (last) {
        toast(failed ? `완료! 사진 ${failed}장은 가져오지 못했어요` : '여행 기록을 만들었어요', Boolean(failed));
        location.hash = picked.length === 1 || trip ? `#/m/travel/${last.id}` : '#/m/travel';
      }
    });
  }
}

function defaultName(group) {
  if (group.name) return group.name;
  const area = mainArea(group.photos);
  const short = area.split(' ').pop();
  return short ? `${short} 여행` : `${fmtDate(group.start)} 여행`;
}

export default {
  kind: KIND,
  label: '여행',
  nav: 'plane',
  description: '사진 속 날짜·위치로 여행 지도를 만들어요',
  widget,
  menu,
  view,
  settings: openTripForm,
};
