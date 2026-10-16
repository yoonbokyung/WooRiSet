/**
 * Leaflet(index.html에서 불러온 전역 L) + OpenStreetMap 지도 헬퍼.
 * 오프라인 등으로 Leaflet이 없으면 안내 문구만 보여준다.
 */
const TILE_URL = 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png';
const KOREA = [36.4, 127.9];

/**
 * points: 경로로 이을 좌표 [{ lat, lng }] (시간순)
 * markers: 핀 [{ lat, lng, label, title, href }]
 */
export function createMap(el, { points = [], markers = [] } = {}) {
  if (!window.L) {
    el.innerHTML = '<p class="map_fallback">지도를 불러오지 못했어요. 인터넷 연결을 확인해주세요.</p>';
    return null;
  }
  const { L } = window;
  const map = L.map(el, { zoomControl: false, scrollWheelZoom: true });
  L.control.zoom({ position: 'topright', zoomInTitle: '확대', zoomOutTitle: '축소' }).addTo(map);
  map.attributionControl.setPrefix('<a href="https://leafletjs.com">Leaflet</a>');
  L.tileLayer(TILE_URL, { maxZoom: 18, attribution: '© OpenStreetMap' }).addTo(map);
  if (points.length > 1) L.polyline(points.map((p) => [p.lat, p.lng]), { className: 'map_route' }).addTo(map);
  markers.forEach((m) => {
    const icon = L.divIcon({ className: 'map_pin', html: `<span>${m.label}</span>`, iconSize: [28, 28], iconAnchor: [14, 14] });
    const marker = L.marker([m.lat, m.lng], { icon, title: m.title, alt: m.title }).addTo(map);
    if (m.href) marker.on('click', () => { location.hash = m.href; });
  });
  const all = [...points, ...markers];
  if (all.length) map.fitBounds(L.latLngBounds(all.map((p) => [p.lat, p.lng])), { padding: [30, 30], maxZoom: 13 });
  else map.setView(KOREA, 6);
  return map;
}

/** 두 좌표 사이 거리(km) */
export function distanceKm(a, b) {
  const rad = (v) => (v * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}
