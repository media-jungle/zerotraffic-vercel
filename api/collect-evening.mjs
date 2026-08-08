// [스케줄] 제로트래픽 학습용 저녁 자동 수집 — 코스트코·트레이더스만
// 스케줄은 vercel.json의 crons에 정의 (UTC 8:00~12:30 = KST 17:00~21:30, 매 30분)
// 하루 44개 지점 × 10회 = 440 Directions 호출. 수집 종료일 이후엔 아무것도 안 함.
// 종료 후에는 방문자 탭 데이터만으로 계속 학습된다. 연장하려면 COLLECT_END만 수정.
import { CATEGORIES, offsetPoint, nowKST } from "./_shared.mjs";
import { recordObservation, recordRawObservation, redisClient } from "./_stats.mjs";
import { getContext } from "./_context.mjs";

export const config = { runtime: 'edge' }; // Vercel: 표준 웹 Request/Response로 실행

const COLLECT_END = Date.parse("2027-02-21T00:00:00+09:00"); // 수집 종료(KST 2027-02-20 자정까지)
const TARGETS = ["costco", "traders"];

const GEOCODE_URL = "https://maps.apigw.ntruss.com/map-geocode/v2/geocode";
const DIRECTIONS_URL = "https://maps.apigw.ntruss.com/map-direction/v1/driving";

function hdr() {
  return {
    "x-ncp-apigw-api-key-id": process.env.NCP_CLIENT_ID || "",
    "x-ncp-apigw-api-key": process.env.NCP_CLIENT_SECRET || "",
  };
}
async function geocode(address) {
  const res = await fetch(`${GEOCODE_URL}?query=${encodeURIComponent(address)}`, { headers: hdr() });
  if (!res.ok) return null;
  const d = await res.json();
  if (!d.addresses || !d.addresses.length) return null;
  return [parseFloat(d.addresses[0].x), parseFloat(d.addresses[0].y)];
}
// 강변·매립지·대형 부지 근처는 도로가 없어 경로가 안 잡힐 수 있다.
// 거리(150m→300m→500m) x 8방향으로 넓혀가며 시도 (store.mjs의 directions()와 동일 로직).
async function congestionAt(lon, lat) {
  const distances = [150, 300, 500];
  const bearings = [45, 135, 225, 315, 0, 90, 180, 270];
  for (const dist of distances) {
    for (const bearing of bearings) {
      const [sLon, sLat] = offsetPoint(lon, lat, dist, bearing);
      const url = `${DIRECTIONS_URL}?start=${sLon},${sLat}&goal=${lon},${lat}&option=traoptimal`;
      const res = await fetch(url, { headers: hdr() });
      if (!res.ok) throw new Error("directions " + res.status);
      const d = await res.json();
      const route = d?.route?.traoptimal;
      if (route && route.length) {
        const sec = route[0].section || [];
        const sum = route[0].summary || {};
        const cong = sec.length ? sec[sec.length - 1].congestion : null;
        const road = sum.duration ? Math.round((sum.duration / 60000) * 10) / 10 : 0;
        if (cong != null) return [cong, road];
      }
      // 이 지점엔 경로가 없음 — 다음 방향/거리로 재시도
    }
  }
  return [null, 0];
}

export default async (req) => {
  // 크론 외부에서의 임의 호출 차단 (버셀이 크론 요청에 자동으로 붙여주는 시크릿)
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = req.headers.get("authorization");
    if (auth !== `Bearer ${secret}`) return new Response("unauthorized", { status: 401 });
  }

  if (Date.now() > COLLECT_END) return new Response("collection period ended");
  if (!process.env.NCP_CLIENT_ID) return new Response("no key");

  const redis = redisClient();

  const jobs = [];
  for (const cat of TARGETS) {
    for (const s of CATEGORIES[cat].stores) jobs.push({ cat, s });
  }

  let ok = 0, fail = 0;
  // 10개씩 병렬 (함수 시간제한 내 완료)
  for (let i = 0; i < jobs.length; i += 10) {
    await Promise.allSettled(
      jobs.slice(i, i + 10).map(async ({ cat, s }) => {
        try {
          const gKey = `geo/${cat}/${encodeURIComponent(s.name)}`;
          let coord = null;
          if (redis) { try { coord = await redis.get(gKey); } catch { coord = null; } }
          if (!coord) {
            coord = await geocode(s.addr);
            if (coord && redis) { try { await redis.set(gKey, coord); } catch { /* 무시 */ } }
          }
          if (!coord && s.lat != null) coord = [s.lon, s.lat];
          if (!coord) { fail++; return; }
          const [cong, road] = await congestionAt(coord[0], coord[1]);

          // 원본 관측값 + 날씨/달력 맥락 기록 (경로를 못 구했어도 null로 남겨서 결측을 0과 구분)
          const ctx = await getContext(s.lat, s.lon).catch(() => ({ weather: null, calendar: null }));
          await recordRawObservation(cat, s.name, {
            ts: nowKST(), congestion: cong, road_min: cong != null ? road : null,
            weather: ctx.weather, calendar: ctx.calendar,
          });

          if (cong == null) { fail++; return; }
          await recordObservation(cat, s.name, cong);
          ok++;
        } catch { fail++; }
      })
    );
  }
  return new Response(`collected ok=${ok} fail=${fail}`);
};
