/**
 * KB국민은행(1644-9999) 입출금 알림 문자 → 가계부 내역
 *
 * 문자 형식
 *   [KB]09/15 15:16 / 123456**789 / (주)거래처 / 입금 / 500,000 / 잔액1,234,567
 *   ATM·출금취소 등은 상대방 줄이 없다.
 *
 * 분류 규칙은 위에서부터 처음 맞는 것을 쓴다. 카테고리 이름은 household 모듈의 categories와 같아야 한다.
 */

export const KB_SENDER = '16449999';

const BIG_TRANSFER = 5000000; // 사람에게 보낸·받은 돈이 이 이상이면 '목돈'으로 보고 생활비 합계에서 뺀다
const BANK_PREFIX = /^(타행|신한|농협|우리|기업|하나|국민|카카오|케이|토스|Toss|SC|씨티|새마을|우체국)\s*/;

const XML_ENTITIES = { '&#10;': '\n', '&#13;': '', '&quot;': '"', '&apos;': "'", '&lt;': '<', '&gt;': '>', '&amp;': '&' };
const unescapeXml = (s) => s.replace(/&#10;|&#13;|&quot;|&apos;|&lt;|&gt;|&amp;/g, (m) => XML_ENTITIES[m]);

/** SMS Backup & Restore XML에서 특정 발신번호 문자만 꺼낸다 → [{ date(ms), body }] */
export function extractSms(xml, sender) {
  const out = [];
  const re = new RegExp(`<sms [^>]*?address="${sender}"[^>]*?/>`, 'g');
  for (const [tag] of xml.matchAll(re)) {
    const attr = (name) => (tag.match(new RegExp(` ${name}="([^"]*)"`)) || [])[1] || '';
    out.push({ date: Number(attr('date')), body: unescapeXml(attr('body')) });
  }
  return out;
}

const clean = (s) => String(s || '').normalize('NFKC').replace(/\s+/g, ' ').trim();

/** body: 문자 내용, timestamp: 수신 시각(ms), accounts: [{ prefix: '1234', name: '주 통장' }] */
export function parseKbSms(body, timestamp, accounts) {
  const lines = String(body).replace('[Web발신]', '').split('\n').map((s) => s.trim()).filter(Boolean);
  const head = lines[0]?.match(/^\[KB\](\d{2})\/(\d{2}) (\d{2}):(\d{2})$/);
  if (!head || lines.length < 5) return null;
  const account = accounts.find((a) => a.prefix && lines[1].startsWith(a.prefix));
  if (!account) return null;
  if (lines.length === 5) lines.splice(2, 0, ''); // 상대방 없는 문자

  // 문자에는 연도가 없어서 받은 날 기준으로 정하고, 받은 날보다 미래면 작년 거래로 본다 (연말 문자가 해를 넘겨 온 경우 등)
  const kst = new Date(timestamp + 9 * 3600 * 1000);
  const received = kst.toISOString().slice(0, 10);
  let year = kst.getUTCFullYear();
  if (`${year}-${head[1]}-${head[2]}` > received) year -= 1;
  const amount = Number(lines[4].replace(/[^\d]/g, ''));
  if (!amount) return null;
  const date = `${year}-${head[1]}-${head[2]}`;
  const time = `${head[3]}:${head[4]}`;

  return {
    date,
    time,
    account: account.name,
    who: clean(lines[2]),
    kind: clean(lines[3]),
    amount,
    // 백업 파일·공유·붙여넣기·자동 전송 어느 경로로 들어와도 같은 문자는 같은 키 (잔액까지 넣어 같은 분 거래도 구분)
    ref: `kb|${lines[1]}|${date} ${time}|${amount}|${clean(lines[5])}`,
  };
}

/** 붙여넣거나 공유한 글에서 KB 문자를 하나씩 나눈다 (여러 개를 한꺼번에 붙여넣어도 됨) */
export const splitSmsText = (text) => String(text || '')
  .replace(/\r/g, '')
  .split(/(?=\[KB\]\d{2}\/\d{2} \d{2}:\d{2})/)
  .map((s) => s.trim())
  .filter((s) => s.startsWith('[KB]'));

const isIncoming = (kind) => /입금|입$|입금이|카드입금/.test(kind) || kind === '출금취소' || kind === '자동해지';

const RULES_IN = [
  [/만기자동해지|적금|해지/, '저축 해지'],
  // K-패스 환급은 이미 쓴 교통비가 돌아온 것이라 정부지원(수입)이 아니라 아래 환급·환불로 분류
  [/고용부|고용$|부모급여|아동수당|출산|육아급여|단축급여|사회|세외수입/, '정부지원'],
  [/급여|상여|리눅스웨어|메일플|코너크리에이|싸이웍|주광/, '급여'],
  [/배당|이자|출자유보금|키움|증권|^토스\d/, '금융수입'],
  [/환급|환불|보험금|메트라이프|손보|포인트|케어솔|^현대\//, '환급·환불'],
];

const RULES_OUT = [
  [/적금|비상금|^주식$|청약|연금|IBK|저축|예금신규/, '저축·투자'],
  [/카드|비자해외/, '카드대금'],
  [/캐피탈|대출|할부|이자/, '대출·할부'],
  [/관리비|아파트관리/, '주거·관리비'],
  [/에너지|도시가스|한전|전기|수도|지로/, '공과금'],
  [/^KT\d|SKT|LGU|통신|알뜰폰/, '통신비'],
  [/보험|생명|화재|해상|^현대해\d|라이프PL|라이프플래닛/, '보험'],
  [/인텔릭스|렌탈|코웨이|청호|쿠쿠|SK매직/, '주거·관리비'],
  [/웨이브|넷플릭스|유튜브|티빙|쿠팡플레이|멜론|디즈니|왓챠|지니뮤직/, '여가'],
  [/올리브|무인양품|유니클로|자라|H&M/, '쇼핑'],
  [/배민|배달|요기요|쿠팡이츠|커피|카페|스타벅스|투썸|이디야|버거|치킨|피자/, '외식'],
  [/이마트|홈플러스|롯데마트|코스트코|컬리|하나로|마트|GS25|CU|세븐일레븐|이마트24|다이소/, '식비'],
  [/네이버페이|카카오페이|토스페이|페이코|당근|쿠팡|11번가|G마켓|옥션|무신사|선물하|이케아|한샘|닷컴|롯데온|SSG|신세계|백화점/, '쇼핑'],
  [/카카오T|택시|주유|에너지\(|하이패스|코레일|SRT|티머니|버스/, '교통'],
  [/병원|의원|약국|치과|한의원|소아과|정형외과|내과/, '의료'],
  [/어린이집|유치원|키즈|아이들|유아|육아/, '육아'],
  [/학원|교육|도서|서점/, '교육'],
  [/복권|로또|CGV|메가박스|롯데시네마|여행|호텔|숙박|외국통화/, '여가'],
  [/^용돈/, '용돈'],
  [/^생활비/, '생활비 이체'],
  [/수수료/, '수수료'],
];

const BUSINESS = /전자|코리아|상사|산업|건설|에너지|마트|센터|병원|약국|상회|공사|은행|카드|페이|회사|\(주\)|<주>|주\)/;
const looksLikePerson = (who) => !BUSINESS.test(who) && /^[가-힣]{2,4}(\(.*)?$/.test(who.replace(BANK_PREFIX, ''));

/**
 * 급여 공제(회사 대출 상환 등): 통장에는 공제 후 금액만 찍히므로
 * 기간 안의 매달 가장 큰 급여에 공제액을 더하고, 같은 금액을 지출 내역으로 따로 만든다.
 * rules: [{ account, from: 'YYYY-MM', to: 'YYYY-MM', amount, label, category, minSalary, exclude: ['다른 사람 급여 거래처'] }]
 *        (시트 settings의 payroll_deductions). minSalary: 상여 등 작은 입금에 붙지 않도록 본 급여 최소 금액
 * rows: 가져올 내역 (그 자리에서 수정·추가)
 * existing: 이미 저장된 내역 — 공제를 이미 넣은 달은 건너뛴다 (문자가 한 건씩 들어오는 자동 전송 대비)
 */
export function applyPayrollDeductions(rows, rules, existing = []) {
  rules.forEach((rule) => {
    const monthly = new Map();
    const excluded = (r) => (rule.exclude || []).some((name) => r.memo.includes(name));
    const done = new Set(existing
      .filter((e) => e.category === rule.category && String(e.ref || '').endsWith('|공제') && (!rule.account || e.account === rule.account))
      .map((e) => e.date.slice(0, 7)));
    rows.filter((r) => r.category === '급여' && r.flow === 'in' && (!rule.account || r.account === rule.account) && !excluded(r))
      .filter((r) => r.date.slice(0, 7) >= rule.from && r.date.slice(0, 7) <= rule.to && !done.has(r.date.slice(0, 7)))
      .filter((r) => r.amount >= (rule.minSalary || 0))
      .forEach((r) => {
        const month = r.date.slice(0, 7);
        if (!monthly.has(month) || r.amount > monthly.get(month).amount) monthly.set(month, r);
      });
    monthly.forEach((salary) => {
      salary.amount += rule.amount;
      salary.memo = `${salary.memo} · ${rule.label} ${rule.amount.toLocaleString('ko-KR')}원 공제 전 금액`;
      rows.push({ ...salary, flow: 'out', category: rule.category, amount: rule.amount, memo: `${rule.label} (급여 공제)`, ref: `${salary.ref}|공제` });
    });
  });
  return rows;
}

const lastDayOf = (date) => new Date(Number(date.slice(0, 4)), Number(date.slice(5, 7)), 0).getDate();

/**
 * 사용자 규칙 한 개가 거래에 맞는지
 *   match        : 거래처 이름 일부 (필수)
 *   flow         : 'in' | 'out'
 *   account      : 통장 이름
 *   monthEndDays : 말일 기준 며칠 안 (예: 5 → 26~31일)
 *   minAmount    : 이 금액 이상
 *   maxAmount    : 이 금액 이하
 *   notRound     : true면 만원 단위로 딱 떨어지지 않는 금액만 (급여처럼 끝자리까지 있는 돈)
 */
function matchRule(rule, tx, flow) {
  if (!rule.match || !tx.who.includes(rule.match)) return false;
  if (rule.flow && rule.flow !== flow) return false;
  if (rule.account && rule.account !== tx.account) return false;
  if (rule.monthEndDays && lastDayOf(tx.date) - Number(tx.date.slice(8)) >= rule.monthEndDays) return false;
  if (rule.minAmount && tx.amount < rule.minAmount) return false;
  if (rule.maxAmount && tx.amount > rule.maxAmount) return false;
  if (rule.notRound && tx.amount % 10000 === 0) return false;
  return true;
}

/**
 * opts.members : 가족 이름 목록 → 서로·본인 계좌 간 이동은 합계에서 제외
 * opts.custom  : 사용자 규칙 목록 (matchRule 참고). 기본 규칙보다 먼저 적용
 *                시트 settings의 sms_rules — 개인 이름이 들어가므로 코드에 두지 않는다
 * opts.isRent(tx) : 월세 장부에 이미 있는 입금이면 true → 가져오지 않음
 * 반환: { flow, category } 또는 null(가져오지 않음)
 */
export function classify(tx, { members = [], custom = [], isRent = () => false } = {}) {
  const incoming = isIncoming(tx.kind);
  const flow = incoming ? 'in' : 'out';
  const who = tx.who;
  const bare = who.replace(BANK_PREFIX, '');

  if (incoming && isRent(tx)) return null;
  const own = custom.find((r) => matchRule(r, tx, flow));
  if (own) return { flow, category: own.category };
  if (members.some((m) => bare.startsWith(m) || who.endsWith(m) || who.includes(`/${m}`))) {
    if (!/손보|현대\/|동행복권/.test(who)) return { flow, category: '내 계좌 이동' };
  }
  if (tx.kind === '출금취소') return { flow, category: '환급·환불' };
  if (/ATM|CD공동|제휴CD|현금IC/.test(tx.kind) || /^ATM/.test(who)) return { flow, category: incoming ? '현금 입금' : '현금 인출' };
  if (tx.kind === '자기앞입금') return { flow, category: '현금 입금' };
  if (tx.kind === '통지수수료출') return { flow, category: '수수료' };
  if (tx.kind === 'TOP급여입금') return { flow, category: '급여' };
  if (tx.kind === '카드출금(') return { flow, category: '카드대금' };

  const rules = incoming ? RULES_IN : RULES_OUT;
  const hit = rules.find(([re]) => re.test(who));
  if (hit) return { flow, category: hit[1] };

  // 계좌번호로 정기 이체(기일출금·자동이체)되는 건 대부분 적금·청약
  if (!incoming && (tx.kind === '기일출금' || /^#?\d[\d*,-]{6,}/.test(who))) return { flow, category: '저축·투자' };
  if (tx.kind === '지로출금') return { flow, category: '공과금' };

  if (looksLikePerson(who)) {
    if (tx.amount >= BIG_TRANSFER) return { flow, category: incoming ? '목돈 입금' : '목돈 지출' };
    return { flow, category: incoming ? '가족·지인 입금' : '경조사·송금' };
  }
  if (tx.kind === '체크카드출금') return { flow, category: '미분류' };
  return { flow, category: incoming ? '기타수입' : '미분류' };
}

