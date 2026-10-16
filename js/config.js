const KEYS = { apiUrl: 'hl_api_url', token: 'hl_api_token', userName: 'hl_user_name' };

function read(key) {
  try {
    return localStorage.getItem(key) || '';
  } catch {
    return '';
  }
}

function write(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* 저장할 수 없는 환경(사생활 보호 모드 등) */
  }
}

export function getConfig() {
  return { apiUrl: read(KEYS.apiUrl), token: read(KEYS.token), userName: read(KEYS.userName) };
}

export function setConfig(values) {
  Object.entries(values).forEach(([k, v]) => write(KEYS[k], String(v ?? '').trim()));
}

export function hasConfig() {
  const { apiUrl, token } = getConfig();
  return Boolean(apiUrl && token);
}

/** 가족 공유 링크(?api=...&token=...)로 들어오면 설정을 저장하고 주소창에서 지운다 */
export function importConfigFromUrl() {
  const params = new URLSearchParams(location.search);
  if (!params.has('api') || !params.has('token')) return;
  setConfig({ apiUrl: params.get('api'), token: params.get('token') });
  history.replaceState(null, '', location.pathname + location.hash);
}

export function shareLink() {
  const { apiUrl, token } = getConfig();
  return `${location.origin}${location.pathname}?api=${encodeURIComponent(apiUrl)}&token=${encodeURIComponent(token)}`;
}
