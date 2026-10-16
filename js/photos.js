import { call } from './api.js';

/**
 * 사진은 내 구글 드라이브에 비공개로 저장하고, API로 받아서 기기에 캐시한다.
 * 화면에는 <img data-photo="드라이브 파일 id">로 두면 hydratePhotos()가 채운다.
 */
const CACHE_NAME = 'hl-photos';
const MAX_BYTES = 350 * 1024; // 앱용 사본은 350KB 이하 (이미지 규칙 500KB보다 여유 있게)
const BATCH = 12;
const urls = new Map(); // 파일 id → object URL
const pending = new Set();

async function toJpeg(file, maxSide, quality) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
}

// 크기·화질 순서대로 줄여보며 MAX_BYTES 이하가 되는 첫 결과를 쓴다
const STEPS = [[1600, 0.8], [1600, 0.7], [1600, 0.6], [1280, 0.7], [1280, 0.6], [1024, 0.6], [1024, 0.5]];

/** 사본은 긴 변 최대 1600px·350KB 이하, 썸네일은 480px */
async function compress(file) {
  let blob;
  for (const [side, quality] of STEPS) {
    blob = await toJpeg(file, side, quality);
    if (blob.size <= MAX_BYTES) break;
  }
  return { blob, thumb: await toJpeg(file, 480, 0.7) };
}

const toBase64 = (blob) => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(String(reader.result).split(',')[1]);
  reader.onerror = reject;
  reader.readAsDataURL(blob);
});

const fromBase64 = (b64, mime) => new Blob([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], { type: mime });

const keyOf = (id) => `${location.origin}/__photo/${id}`;

async function openCache() {
  try {
    return await caches.open(CACHE_NAME);
  } catch {
    return null; // 캐시를 쓸 수 없는 환경
  }
}

async function remember(id, blob) {
  urls.set(id, URL.createObjectURL(blob));
  const cache = await openCache();
  await cache?.put(keyOf(id), new Response(blob));
}

/** folder: 사진 폴더 아래 만들 하위 폴더 이름 (여행 이름) */
export async function uploadPhoto(file, folder = '') {
  const { blob, thumb } = await compress(file);
  const saved = await call('uploadPhoto', {
    name: `${Date.now()}.jpg`,
    mime: 'image/jpeg',
    data: await toBase64(blob),
    thumb: await toBase64(thumb),
    folder,
  });
  await remember(saved.file_id, blob);
  await remember(saved.thumb_id, thumb);
  return saved;
}

const failed = new Set(); // 이미지로 읽을 수 없는 파일 id
let missingHandler = null;

/** 사진을 못 불러왔을 때 실행할 함수 등록 (여행 모듈이 원본 드라이브 사진으로 다시 만든다) */
export const onPhotoMissing = (fn) => { missingHandler = fn; };

async function markFailed(id) {
  if (failed.has(id)) return;
  failed.add(id);
  urls.delete(id);
  const cache = await openCache();
  await cache?.delete(keyOf(id));
  apply();
  missingHandler?.(id);
}

async function load(ids) {
  const cache = await openCache();
  const need = [];
  for (const id of ids) {
    const blob = await (await cache?.match(keyOf(id)))?.blob();
    if (blob && blob.type.startsWith('image/')) urls.set(id, URL.createObjectURL(blob));
    else need.push(id); // 캐시에 없거나 이미지가 아닌 것(예전 오류 파일)은 다시 받는다
  }
  for (let i = 0; i < need.length; i += BATCH) {
    const chunk = need.slice(i, i + BATCH);
    const data = await call('getPhotos', { ids: chunk });
    for (const id of chunk) {
      if (data[id]?.mime?.startsWith('image/')) await remember(id, fromBase64(data[id].data, data[id].mime));
      else markFailed(id);
    }
  }
}

function apply() {
  document.querySelectorAll('img[data-photo]').forEach((img) => {
    const id = img.dataset.photo;
    const url = urls.get(id);
    img.classList.toggle('is_missing', failed.has(id));
    if (url && img.getAttribute('src') !== url) {
      img.onerror = () => markFailed(id); // 깨진 파일이면 엑박 대신 빈 자리로
      img.src = url;
    }
  });
}

/** root 안의 사진을 채운다 (렌더 중 다시 그려져도 문서 전체에 적용) */
export async function hydratePhotos(root) {
  apply();
  const ids = [...new Set([...root.querySelectorAll('img[data-photo]')].map((img) => img.dataset.photo))]
    .filter((id) => id && !urls.has(id) && !pending.has(id));
  if (!ids.length) return;
  ids.forEach((id) => pending.add(id));
  try {
    await load(ids);
  } catch {
    /* 오프라인 등: 다음 화면 갱신 때 다시 시도 */
  } finally {
    ids.forEach((id) => pending.delete(id));
  }
  apply();
}

