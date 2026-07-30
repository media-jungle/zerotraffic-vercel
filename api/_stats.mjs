// 혼잡 관측 데이터 축적 + 제로트래픽 시각 계산 (Upstash Redis)
// - 방문자가 카드를 탭해 실측이 생길 때마다 recordObservation()으로 요일×30분 슬롯 집계에 누적
// - zeroTimeToday()는 "지난주 같은 요일" 데이터에서 원활해지기 시작한 가장 이른 시각을 계산
//   (마감까지 100% 원활이 안 끊기고 이어질 것을 요구하지 않음 — 원활 비율 기준으로 판정)
//   지난주 데이터가 없거나 판정 불가면 그 이전 주로 순서대로 넘어가며 찾는다.
// - Redis 실패(로컬 실행 등)는 전부 조용히 무시 → 본 기능(혼잡도 표시)에 영향 없음
import { Redis } from "@upstash/redis";

const TZ = 9 * 3600 * 1000; // KST

export function kstNow() { return new Date(Date.now() + TZ); }

// 해당 주의 월요일 날짜(YYYY-MM-DD)를 주 키로 사용
export function weekKey(d = kstNow()) {
  const day = (d.getUTCDay() + 6) % 7; // 월=0
  const mon = new Date(d.getTime() - day * 86400000);
  return mon.toISOString().slice(0, 10);
}
export function prevWeekKeys(count = 4) {
  const keys = [];
  const now = kstNow();
  for (let i = 0; i < count; i++) keys.push(weekKey(new Date(now.getTime() - i * 7 * 86400000)));
  return keys;
}
export function slotOf(d = kstNow()) {
  const h = String(d.getUTCHours()).padStart(2, "0");
  return `${h}:${d.getUTCMinutes() < 30 ? "00" : "30"}`;
}
export function dowOf(d = kstNow()) { return d.getUTCDay(); } // 0=일

// 환경변수가 없으면 null → 호출부에서 조용히 무시된다
let _redis;
export function redisClient() {
  if (_redis !== undefined) return _redis;
  try {
    _redis = (process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN)
      ? new Redis({ url: process.env.KV_REST_API_URL, token: process.env.KV_REST_API_TOKEN })
      : null;
  } catch { _redis = null; }
  return _redis;
}

// Blobs 시절의 키 형식을 그대로 유지 (백업 데이터 복원 호환)
export function aggKey(cat, name, wk) { return `agg/${cat}/${encodeURIComponent(name)}/${wk}`; }

// 관측 1건 누적: 슬롯당 [관측수, 원활수]
export async function recordObservation(cat, name, congestion) {
  try {
    const r = redisClient();
    if (!r) return;
    const key = aggKey(cat, name, weekKey());
    const data = (await r.get(key)) || {};
    const dow = String(dowOf());
    const slot = slotOf();
    data[dow] = data[dow] || {};
    const cell = data[dow][slot] || [0, 0];
    cell[0] += 1;
    if (congestion <= 1) cell[1] += 1; // 0(정보없음)·1(원활) = 한산으로 집계
    data[dow][slot] = cell;
    await r.set(key, data);
  } catch { /* 집계 실패는 무시 */ }
}

// 판정 기준 (필요시 조정)
const MIN_SAMPLES = 2;   // 해당 슬롯에 최소 이만큼 관측이 쌓여야 신뢰
const SMOOTH_RATIO = 0.5; // 관측 중 원활 비율이 이 이상이면 "원활 시작"으로 판정

// 하루치 슬롯 데이터에서 원활해지기 시작한 첫 시각 계산 (테스트 가능하도록 분리)
// daySlots: { "HH:MM": [관측수, 원활수] } — 특정 한 주의 특정 요일 데이터
export function computeZeroTime(daySlots, closeHour = 22, startHour = "15:00") {
  const closeStr = `${String(closeHour).padStart(2, "0")}:00`;
  const slots = Object.keys(daySlots).filter((t) => t >= startHour && t < closeStr).sort();
  for (const t of slots) {
    const [n, f] = daySlots[t];
    if (n >= MIN_SAMPLES && f / n >= SMOOTH_RATIO) {
      return { time: t, samples: n };
    }
  }
  return null;
}

const ztMemo = new Map(); // 인스턴스 메모 (1시간)
export async function zeroTimeToday(cat, name, closeHour = 22) {
  const dow = dowOf();
  const memoKey = `${cat}:${name}:${dow}:${weekKey()}`;
  const memo = ztMemo.get(memoKey);
  if (memo && Date.now() - memo.ts < 3600e3) return memo.val;

  let val = null;
  try {
    const r = redisClient();
    if (!r) return null;
    // i=0은 이번 주(당일 데이터라 아직 불완전할 수 있음)라서 건너뛰고,
    // 지난주부터 순서대로 조회해 처음 판정되는 값을 쓴다.
    const weekKeys = prevWeekKeys(5).slice(1); // 지난주 ~ 4주 전
    const weeks = await r.mget(...weekKeys.map((wk) => aggKey(cat, name, wk)));
    for (const d of weeks) {
      const day = d && d[String(dow)];
      if (!day) continue;
      val = computeZeroTime(day, closeHour);
      if (val) break;
    }
  } catch { val = null; }

  if (ztMemo.size > 2000) ztMemo.clear();
  ztMemo.set(memoKey, { ts: Date.now(), val });
  return val;
}
