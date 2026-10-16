import { getConfig } from './config.js';

/**
 * Apps Script 웹 앱 호출.
 * Content-Type을 지정하지 않으면 text/plain으로 전송되어 CORS preflight 없이 동작한다.
 */
export async function call(action, payload = {}) {
  const { apiUrl, token } = getConfig();
  if (!apiUrl || !token) throw new Error('설정에서 API 주소와 토큰을 입력해주세요.');

  let res;
  try {
    res = await fetch(apiUrl, { method: 'POST', body: JSON.stringify({ token, action, payload }) });
  } catch {
    // 인터넷이 되는데 실패하면 대부분 배포의 "액세스 권한"이 '모든 사용자'가 아니라 구글 로그인 화면으로 돌려보낸 경우
    throw new Error(navigator.onLine
      ? '서버에 연결할 수 없어요. Apps Script 배포의 액세스 권한이 "모든 사용자"인지 확인해주세요.'
      : '인터넷에 연결되어 있지 않아요.');
  }
  if (!res.ok) throw new Error(`서버 오류가 발생했어요 (${res.status})`);

  const json = await res.json().catch(() => {
    throw new Error('응답을 읽을 수 없어요. API 주소가 맞는지 확인해주세요.');
  });
  if (!json.ok) throw new Error(json.error || '요청을 처리하지 못했어요.');
  return json.data;
}
