/**
 * 쿠팡 주문내역 CSV → 가계부 records(type 'coupang')
 *
 * 쿠팡 결제는 이미 가계부에 카드대금·생활비 이체 같은 덩어리로 잡혀 있으므로 지출로 더하지 않는다.
 * household 모듈이 같은 달 덩어리 금액에서 이만큼을 떼어 실제 카테고리로 옮겨 보여준다 (총액은 그대로).
 *
 * CSV 열: 주문일시, 주문번호, 상품명, 옵션, 수량, 정가, 결제단가, 취소수량, 반품수량, 판매자
 */

export const COUPANG_TYPE = 'coupang';

/** 상품명 → 카테고리 (위에서부터 처음 맞는 것). 육아를 먼저 봐야 '아기치즈'가 식비로 가지 않는다 */
const PRODUCT_RULES = [
  [/식기세척기|세탁조|세탁망/, '생필품'],
  [/유아|아기|아이 |아가|베이비|베베|키즈|아동|어린이|신생아|돌아기|걸음마|젖병|젖꼭지|노리개|치발기|분유|이유식|기저귀|하기스|턱받이|유모차|우주복|롬퍼|바디수트|딸랑이|모빌|사운드북|팝업북|낱말카드|세이펜|놀이|장난감|토이|킥보드|붕붕카|보행기|컵쌓기|뽀로로|스와들|탕온계|어린이집|구디백|수유|산후|임부|임산부|맘스|유두|락피도|첫치즈|흡입기|비지북|인형|손빨기|무스텔라|아이배냇|아이얌/, '육아'],
  [/비타민|유산균|락토핏|체온계|혈당|보호대|콜레스테롤|영양제|드레싱|밴드/, '의료'],
  [/우유|요거트|요구르트|두부|김치|생채|감귤|사과|딸기|바나나|토마토|키위|레몬|버섯|깻잎|상추|쌈|양파|마늘|대파|고추|당근|호박|부추|콩나물|파프리카|감자|고구마|무$|절단무|조각무|수박|복숭아|참외|멜론|머스켓|포도|한돈|한우|삼겹|항정|앞다리|등심|닭|계란|유정란|어묵|만두|교자|피자|빵|베이글|식빵|크로아상|브리오|팡|카스테라|쿠키|약과|도넛|브리또|부리또|밀키트|찌개|스프|카레|짜장|칼국수|소면|사리면|라멘|짜파게티|스파게티|면 |탕면|햅쌀|쌀|밥|미역|다시|육수|액젓|소금|천일염|간장|참기름|들기름|케첩|다시다|소스|버터|치즈|커피|에스프레소|캡슐|차음료|보리|수염차|음료|주스|즙|퓨레|이온|소시지|햄|오징어|숏다리|고등어|삼치|갈치|너트|아몬드|서리태|그래놀라|시리얼|곡물바|프로틴|칼로리바란스|밤|미숫가루|호떡|청국장|소이조이|병아리콩|스위트콘|떡볶이|아몬드브리즈|매실|캔디|간식|김$|도시락김|재래|냉동|냉장/, '식비'],
  [/세제|섬유유연제|유연제|화장지|휴지|물티슈|티슈|지퍼백|위생롤백|칫솔|치약|구강|샴푸|트리트먼트|헤어오일|오일 에센스|핸드워시|워시|클렌징|휘핑 폼|면봉|생리대|라이너|오버나이트|콘돔|건전지|탈취|항균|진드기|수세미|거름망|샤워|타월|타올|수건|크림|로션|선크림|세럼|미스트|올인원|파우더|때밀이|휴지통|세정제|면도|위생랩|습기제거/, '생필품'],
  [/개정판|공부|자격증|문제집|교재/, '교육'],
];

export function classifyProduct(name) {
  return (PRODUCT_RULES.find(([re]) => re.test(name)) || [null, '쇼핑'])[1];
}

/** 따옴표·줄바꿈이 들어간 CSV 칸까지 읽는다 */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  const src = text.replace(/^﻿/, '');
  for (let i = 0; i < src.length; i += 1) {
    const c = src[i];
    if (quoted) {
      if (c === '"' && src[i + 1] === '"') { field += '"'; i += 1; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field.replace(/\r$/, '')); rows.push(row); row = []; field = ''; }
    else field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}

/** CSV 글 → 새로 넣을 records와 통계. known: 이미 넣은 주문 상품 키 */
export function buildCoupangRecords(text, ledgerId, known) {
  const [head, ...rows] = parseCsv(text);
  const col = (name) => head?.indexOf(name) ?? -1;
  const idx = { at: col('주문일시'), order: col('주문번호'), name: col('상품명'), option: col('옵션'), qty: col('수량'), price: col('결제단가'), cancel: col('취소수량'), back: col('반품수량') };
  if (Object.values(idx).some((i) => i < 0)) return null;

  const fresh = [];
  const stats = { dup: 0, canceled: 0, byCategory: new Map() };
  rows.forEach((r) => {
    if (r.length < head.length) return;
    const key = `${r[idx.order]}|${r[idx.option]}`;
    if (known.has(key)) { stats.dup += 1; return; }
    known.add(key);
    const qty = Math.max(Number(r[idx.qty]) - Number(r[idx.cancel] || 0) - Number(r[idx.back] || 0), 0);
    const amount = qty * Number(r[idx.price]);
    if (!amount) { stats.canceled += 1; return; }
    const category = classifyProduct(r[idx.name]);
    fresh.push({
      ledger_id: ledgerId,
      type: COUPANG_TYPE,
      date: r[idx.at].slice(0, 10),
      title: r[idx.name],
      memo: r[idx.option],
      data: JSON.stringify({ key, amount, qty, category }),
    });
    const [n, sum] = stats.byCategory.get(category) || [0, 0];
    stats.byCategory.set(category, [n + 1, sum + amount]);
  });
  return { fresh, stats };
}
