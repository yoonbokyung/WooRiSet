import { call } from './api.js';

/**
 * 사진은 내 구글 드라이브에 비공개로 저장하고, API로 받아서 기기에 캐시한다.
 * 화면에는 <img data-photo="드라이브 파일 id">로 두면 hydratePhotos()가 채운다.
 */
const CACHE_NAME = 'hl-photos';
const MAX_BYTES = 500 * 1024; // 이미지 규칙: 500KB 이하
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

/** 원본은 긴 변 1600px·500KB 이하, 썸네일은 480px */
async function compress(file) {
  let blob;
  for (let q = 0.85; q > 0.3; q -= 0.1) {
    blob = await toJpeg(file, 1600, q);
    if (blob.size <= MAX_BYTES) break;
  }
  if (blob.size > MAX_BYTES) blob = await toJpeg(file, 1200, 0.6);
  return { blob, thumb: await toJpeg(file, 480, 0.75) };
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

export async function uploadPhoto(file) {
  const { blob, thumb } = await compress(file);
  const saved = await call('uploadPhoto', {
    name: `${Date.now()}.jpg`,
    mime: 'image/jpeg',
    data: await toBase64(blob),
    thumb: await toBase64(thumb),
  });
  await remember(saved.file_id, blob);
  await remember(saved.thumb_id, thumb);
  return saved;
}

async function load(ids) {
  const cache = await openCache();
  const need = [];
  for (const id of ids) {
    const hit = await cache?.match(keyOf(id));
    if (hit) urls.set(id, URL.createObjectURL(await hit.blob()));
    else need.push(id);
  }
  for (let i = 0; i < need.length; i += BATCH) {
    const chunk = need.slice(i, i + BATCH);
    const data = await call('getPhotos', { ids: chunk });
    for (const id of chunk) {
      if (data[id]) await remember(id, fromBase64(data[id].data, data[id].mime));
    }
  }
}

function apply() {
  document.querySelectorAll('img[data-photo]').forEach((img) => {
    const url = urls.get(img.dataset.photo);
    if (url && img.getAttribute('src') !== url) img.src = url;
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

