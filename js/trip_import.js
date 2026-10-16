import { call } from './api.js';
import { getConfig } from './config.js';
import { uploadPhoto } from './photos.js';
import { upsert, insertMany, byLedger } from './store.js';
import { distanceKm } from './map.js';
import { pad, daysBetween, parseJson } from './utils.js';

/**
 * 여러 장의 사진으로 여행 기록 만들기
 * 1) readPhotos   : 사진 원본의 EXIF에서 찍은 시각·GPS 좌표 읽기 (압축하면 EXIF가 사라지므로 먼저 읽는다)
 * 2) splitTrips   : 날짜 간격으로 여행 나누기
 * 3) locatePlaces : 가까운 사진끼리 묶어 장소 이름 찾기
 * 4) saveTrip     : 사진 업로드 + 여행·사진 기록 저장
 */
const EXIFR_URL = 'https://cdn.jsdelivr.net/npm/exifr@7.1.3/dist/lite.esm.mjs';
const TRIP_GAP_DAYS = 2; // 사진 없는 날이 하루 끼어도 같은 여행으로 본다
const PLACE_RADIUS_KM = 1.5;
const GEOCODE_BATCH = 30;
const UPLOAD_WORKERS = 3;

const localDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const localTime = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const validCoord = (v) => Number.isFinite(v) && v !== 0;

export async function readPhotos(files, onProgress) {
  let exifr = null;
  try {
    exifr = (await import(EXIFR_URL)).default;
  } catch {
    /* 라이브러리를 못 불러오면 파일 수정 시각만 사용 */
  }
  const photos = [];
  for (const [i, file] of files.entries()) {
    let meta = null;
    try {
      meta = exifr ? await exifr.parse(file, { gps: true }) : null;
    } catch {
      meta = null;
    }
    const exifDate = meta?.DateTimeOriginal || meta?.CreateDate;
    const taken = exifDate instanceof Date && !Number.isNaN(exifDate.getTime()) ? exifDate : new Date(file.lastModified);
    const lat = Number(meta?.latitude);
    const lng = Number(meta?.longitude);
    const hasGps = validCoord(lat) && validCoord(lng);
    photos.push({ file, date: localDate(taken), time: localTime(taken), stamp: taken.getTime(), lat: hasGps ? lat : null, lng: hasGps ? lng : null });
    onProgress?.(i + 1, files.length);
  }
  return photos.sort((a, b) => a.stamp - b.stamp);
}

/** 드라이브 폴더 사진 목록(서버가 읽은 촬영 시각·위치) → 사진 객체. 이미 가져온 사진은 뺀다 */
export async function readDrivePhotos(folder, importedIds) {
  const files = await call('scanDrivePhotos', { folder });
  const photos = files
    .filter((f) => !importedIds.has(f.id))
    .map((f) => ({
      sourceId: f.id,
      folder: f.folder || '',
      date: f.date,
      time: f.time,
      stamp: new Date(`${f.date}T${f.time}`).getTime(),
      lat: validCoord(Number(f.lat)) ? Number(f.lat) : null,
      lng: validCoord(Number(f.lng)) ? Number(f.lng) : null,
    }));
  return { total: files.length, photos: photos.sort((a, b) => a.stamp - b.stamp) };
}

export function splitTrips(photos) {
  const groups = [];
  photos.forEach((p) => {
    const last = groups[groups.length - 1];
    if (last && daysBetween(last.end, p.date) <= TRIP_GAP_DAYS) {
      last.photos.push(p);
      last.end = p.date;
    } else {
      groups.push({ start: p.date, end: p.date, photos: [p] });
    }
  });
  return groups;
}

/** 드라이브 사진: 하위 폴더마다 여행 하나(폴더 이름 = 여행 이름), 고른 폴더 바로 안 사진은 날짜 간격으로 나눈다 */
export function groupTrips(photos) {
  const byFolder = new Map();
  photos.forEach((p) => {
    if (!byFolder.has(p.folder)) byFolder.set(p.folder, []);
    byFolder.get(p.folder).push(p);
  });
  const groups = [];
  byFolder.forEach((list, folder) => {
    if (folder) groups.push({ name: folder, start: list[0].date, end: list[list.length - 1].date, photos: list });
    else groups.push(...splitTrips(list));
  });
  return groups.sort((a, b) => a.start.localeCompare(b.start));
}

/** 시간순으로 가까운 사진끼리 묶어 묶음마다 한 번씩만 장소를 조회 */
export async function locatePlaces(photos) {
  const clusters = [];
  photos.filter((p) => p.lat !== null).forEach((p) => {
    const last = clusters[clusters.length - 1];
    if (last && distanceKm(last, p) <= PLACE_RADIUS_KM) last.photos.push(p);
    else clusters.push({ lat: p.lat, lng: p.lng, photos: [p] });
  });
  for (let i = 0; i < clusters.length; i += GEOCODE_BATCH) {
    const chunk = clusters.slice(i, i + GEOCODE_BATCH);
    let found = [];
    try {
      found = await call('reverseGeocode', { points: chunk.map(({ lat, lng }) => ({ lat, lng })) });
    } catch {
      found = []; // 장소 이름 없이도 기록은 만든다
    }
    chunk.forEach((c, j) => c.photos.forEach((p) => {
      p.place = found[j]?.place || '';
      p.area = found[j]?.area || '';
    }));
  }
}

/** 가장 많이 나온 지역 이름 */
export function mainArea(photos) {
  const count = new Map();
  photos.forEach((p) => { if (p.area) count.set(p.area, (count.get(p.area) || 0) + 1); });
  return [...count].sort((a, b) => b[1] - a[1])[0]?.[0] || '';
}

/**
 * trip이 있으면 그 여행에 사진을 추가하고, 없으면 새 여행을 만든다.
 * 사진은 3장씩 동시에 올리고, 기록은 마지막에 한 번에 저장한다.
 */
export async function saveTrip({ trip = null, name, photos, onProgress }) {
  const by = getConfig().userName;
  let ledger = trip;
  if (!ledger) ledger = await upsert('ledgers', { kind: 'travel', name, sort: 0, meta: '{}' });

  const queue = photos.slice();
  const rows = [];
  let done = 0;
  let failed = 0;
  const worker = async () => {
    while (queue.length) {
      const p = queue.shift();
      try {
        // 내 기기 사진은 압축해서 올리고, 드라이브 사진은 서버가 미리보기로 사본을 만든다
        const ids = p.file ? await uploadPhoto(p.file, ledger.name) : await call('importDrivePhoto', { id: p.sourceId, folder: ledger.name });
        rows.push({
          ledger_id: ledger.id, type: 'photo', date: p.date, title: '', memo: '', by, ...ids,
          data: JSON.stringify({ time: p.time, lat: p.lat, lng: p.lng, place: p.place || '', area: p.area || '', source_id: p.sourceId || '' }),
        });
      } catch {
        failed += 1;
      }
      onProgress?.((done += 1), photos.length);
    }
  };
  await Promise.all(Array.from({ length: UPLOAD_WORKERS }, worker));
  if (rows.length) await insertMany('records', rows);

  // 여행 기간·대표 사진·지역을 전체 사진 기준으로 갱신
  const all = byLedger('records', ledger.id).filter((r) => r.type === 'photo');
  const dates = all.map((r) => r.date).sort();
  const meta = parseJson(ledger.meta);
  const sorted = rows.slice().sort((a, b) => a.date.localeCompare(b.date));
  const nextMeta = {
    ...meta,
    start: dates[0] || meta.start || '',
    end: dates[dates.length - 1] || meta.end || '',
    cover: meta.cover || sorted[Math.floor(sorted.length / 2)]?.thumb_id || '',
    area: meta.area || mainArea(photos),
  };
  ledger = await upsert('ledgers', { ...ledger, meta: JSON.stringify(nextMeta) });
  return { ledger, uploaded: rows.length, failed };
}
