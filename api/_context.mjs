// 관측 시점의 맥락 변수(날씨·달력) — 왜 혼잡했는지 설명할 수 있는 부가 데이터.
// 콘텐츠 제작(예: "비 오는 날은 오히려 한산하다")을 위해 raw 로그에 함께 기록한다.
// 실패해도 혼잡도 조회 자체엔 절대 영향 없도록 전부 try/catch로 감싸고,
// 값을 못 가져오면 0이 아니라 null로 남긴다(결측과 0을 구분).
// 사용 API: 기상청 단기예보(초단기실황/초단기예보), 한국천문연구원 특일 정보
//  — 둘 다 새 인증 절차 없이 기존 DATA_GO_KR_KEY를 그대로 재사용.

const KMA_NCST_URL = "https://apis.data.go.kr/1360000/VilageFcstInfoService_2.0/getUltraSrtNcst";
const KMA_FCST_URL = "https://apis.data.go.kr/1360000/VilageFcstInfoService_2.0/getUltraSrtFcst";
const HOLIDAY_URL = "https://apis.data.go.kr/B090041/openapi/service/SpcdeInfoService/getRestDeInfo";

const PTY_LABEL = { 0: "없음", 1: "비", 2: "비/눈", 3: "눈", 4: "소나기", 5: "빗방울", 6: "빗방울눈날림", 7: "눈날림" };
const SKY_LABEL = { 1: "맑음", 3: "구름많음", 4: "흐림" };

function kst() { return new Date(Date.now() + 9 * 3600 * 1000); }
function ymd(d) { return d.toISOString().slice(0, 10).replace(/-/g, ""); }
function hm(d) { return d.toISOString().slice(11, 16).replace(":", ""); }

// 위경도 → 기상청 격자좌표(nx, ny). 기상청 공식 LCC DFS 변환식.
export function latLonToGrid(lat, lon) {
  const RE = 6371.00877, GRID = 5.0;
  const SLAT1 = 30.0, SLAT2 = 60.0, OLON = 126.0, OLAT = 38.0, XO = 43, YO = 136;
  const DEGRAD = Math.PI / 180.0;
  const re = RE / GRID;
  const slat1 = SLAT1 * DEGRAD, slat2 = SLAT2 * DEGRAD;
  const olon = OLON * DEGRAD, olat = OLAT * DEGRAD;
  let sn = Math.tan(Math.PI * 0.25 + slat2 * 0.5) / Math.tan(Math.PI * 0.25 + slat1 * 0.5);
  sn = Math.log(Math.cos(slat1) / Math.cos(slat2)) / Math.log(sn);
  let sf = Math.tan(Math.PI * 0.25 + slat1 * 0.5);
  sf = (Math.pow(sf, sn) * Math.cos(slat1)) / sn;
  let ro = Math.tan(Math.PI * 0.25 + olat * 0.5);
  ro = (re * sf) / Math.pow(ro, sn);
  let ra = Math.tan(Math.PI * 0.25 + (lat * DEGRAD) * 0.5);
  ra = (re * sf) / Math.pow(ra, sn);
  let theta = lon * DEGRAD - olon;
  if (theta > Math.PI) theta -= 2.0 * Math.PI;
  if (theta < -Math.PI) theta += 2.0 * Math.PI;
  theta *= sn;
  const nx = Math.floor(ra * Math.sin(theta) + XO + 0.5);
  const ny = Math.floor(ro - ra * Math.cos(theta) + YO + 0.5);
  return { nx, ny };
}

// 초단기실황: 매시 40분 생성, 45분 이후 조회 가능 → 45분 전이면 이전 시각 사용
function ncstBaseTime() {
  const d = kst();
  if (d.getUTCMinutes() < 45) d.setUTCHours(d.getUTCHours() - 1);
  d.setUTCMinutes(0, 0, 0);
  return { date: ymd(d), time: hm(d) };
}
// 초단기예보: 매시 30분 생성, 45분 이후 조회 가능 (하늘상태 SKY는 실황에 없어서 예보에서 가져옴)
function fcstBaseTime() {
  const d = kst();
  if (d.getUTCMinutes() < 45) d.setUTCHours(d.getUTCHours() - 1);
  d.setUTCMinutes(30, 0, 0);
  return { date: ymd(d), time: hm(d) };
}

// 격자당 캐시(인스턴스 메모리). 실황은 시간당 1회만 갱신되므로 50분이면 충분하고
// 스케줄 수집(30분 간격) 때 매번 새로 호출하는 걸 크게 줄여준다.
const weatherCache = new Map(); // "nx,ny" -> {ts, data}
const WEATHER_CACHE_MS = 50 * 60 * 1000;

export async function fetchWeather(lat, lon) {
  const empty = { temp: null, pty: null, ptyLabel: null, sky: null, skyLabel: null };
  const key = process.env.DATA_GO_KR_KEY;
  if (!key || lat == null || lon == null) return empty;

  const { nx, ny } = latLonToGrid(lat, lon);
  const cacheKey = `${nx},${ny}`;
  const cached = weatherCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < WEATHER_CACHE_MS) return cached.data;

  let temp = null, pty = null, sky = null;
  try {
    const b = ncstBaseTime();
    const url = `${KMA_NCST_URL}?serviceKey=${encodeURIComponent(key)}&numOfRows=10&pageNo=1&dataType=JSON&base_date=${b.date}&base_time=${b.time}&nx=${nx}&ny=${ny}`;
    const res = await fetch(url);
    if (res.ok) {
      const d = await res.json();
      const items = d?.response?.body?.items?.item;
      const arr = items ? [].concat(items) : [];
      for (const it of arr) {
        if (it.category === "T1H") temp = parseFloat(it.obsrValue);
        if (it.category === "PTY") pty = parseInt(it.obsrValue, 10);
      }
    }
  } catch { /* 무시 — 아래서 null 유지 */ }

  try {
    const b = fcstBaseTime();
    const url = `${KMA_FCST_URL}?serviceKey=${encodeURIComponent(key)}&numOfRows=60&pageNo=1&dataType=JSON&base_date=${b.date}&base_time=${b.time}&nx=${nx}&ny=${ny}`;
    const res = await fetch(url);
    if (res.ok) {
      const d = await res.json();
      const items = d?.response?.body?.items?.item;
      const arr = items ? [].concat(items) : [];
      const skyItem = arr.find((it) => it.category === "SKY");
      if (skyItem) sky = parseInt(skyItem.fcstValue, 10);
    }
  } catch { /* 무시 */ }

  const data = {
    temp: Number.isFinite(temp) ? temp : null,
    pty: Number.isFinite(pty) ? pty : null,
    ptyLabel: Number.isFinite(pty) ? (PTY_LABEL[pty] ?? null) : null,
    sky: Number.isFinite(sky) ? sky : null,
    skyLabel: Number.isFinite(sky) ? (SKY_LABEL[sky] ?? null) : null,
  };
  weatherCache.set(cacheKey, { ts: Date.now(), data });
  return data;
}

// ── 특일정보(공휴일) — 연 단위로 캐시, 명절 D-day 계산에도 사용 ──
const holidayCache = new Map(); // year -> {ts, map: Map("YYYYMMDD" -> {name, isHoliday})}
const HOLIDAY_CACHE_MS = 24 * 60 * 60 * 1000;

async function fetchHolidayYear(year) {
  const cached = holidayCache.get(year);
  if (cached && Date.now() - cached.ts < HOLIDAY_CACHE_MS) return cached.map;

  const map = new Map();
  const key = process.env.DATA_GO_KR_KEY;
  if (key) {
    try {
      const url = `${HOLIDAY_URL}?serviceKey=${encodeURIComponent(key)}&solYear=${year}&numOfRows=100&_type=json`;
      const res = await fetch(url);
      if (res.ok) {
        const d = await res.json();
        const items = d?.response?.body?.items?.item;
        const arr = items ? [].concat(items) : [];
        for (const it of arr) {
          map.set(String(it.locdate), { name: it.dateName, isHoliday: it.isHoliday === "Y" });
        }
      }
    } catch { /* 무시 — map 비면 아래서 판정 불가로 처리 */ }
  }
  holidayCache.set(year, { ts: Date.now(), map });
  return map;
}

function dateStr(d) { return ymd(d); } // YYYYMMDD

// 이번 달 몇째 주 (그 달 1일이 속한 주를 1주차로, 월요일 시작)
function weekOfMonth(d) {
  const first = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
  const firstDow = (first.getUTCDay() + 6) % 7; // 월=0
  return Math.ceil((d.getUTCDate() + firstDow) / 7);
}

export async function getCalendarContext(d = kst()) {
  const today = dateStr(d);
  const year = d.getUTCFullYear();

  let holidays;
  try {
    holidays = await fetchHolidayYear(year);
    if (d.getUTCMonth() === 11) { // 12월엔 다음 해 신정연휴도 미리 포함
      const next = await fetchHolidayYear(year + 1);
      for (const [k, v] of next) holidays.set(k, v);
    }
  } catch { holidays = new Map(); }

  const todayInfo = holidays.get(today);
  const dow = d.getUTCDay(); // 0=일
  const isWeekend = dow === 0 || dow === 6;
  // holidays 조회 자체가 실패(size 0)하면 판정 불가 → null. 성공했으면 공휴일이 아니어도 주말은 휴일로 간주.
  const isHoliday = todayInfo ? todayInfo.isHoliday : (holidays.size ? isWeekend : null);

  // 연휴 며칠째(오늘 포함, 과거 방향으로 연속 휴일 카운트)
  let consecutiveHolidayDay = null;
  if (holidays.size && isHoliday) {
    let n = 0;
    for (let i = 0; i < 10; i++) {
      const dd = new Date(d.getTime() - i * 86400000);
      const ddow = dd.getUTCDay();
      const info = holidays.get(dateStr(dd));
      const off = info ? info.isHoliday : (ddow === 0 || ddow === 6);
      if (!off) break;
      n++;
    }
    consecutiveHolidayDay = n;
  }

  // 다음 명절(설날/추석 당일)까지 D-day
  let daysToNextMajorHoliday = null, nextMajorHolidayName = null;
  if (holidays.size) {
    let best = null;
    for (const [k, v] of holidays) {
      if (!/^(설날|추석)$/.test(v.name)) continue; // "설날전날"·"설날다음날" 등은 제외, 당일만
      const dd = Date.UTC(+k.slice(0, 4), +k.slice(4, 6) - 1, +k.slice(6, 8));
      const diff = Math.round((dd - Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())) / 86400000);
      if (diff >= 0 && (best === null || diff < best.diff)) best = { diff, name: v.name };
    }
    if (best) { daysToNextMajorHoliday = best.diff; nextMajorHolidayName = best.name; }
  }

  // 월급날(25일로 가정) 전후
  const payday = 25;
  const dom = d.getUTCDate();
  const daysSincePayday = dom >= payday ? dom - payday : null;
  const daysUntilPayday = dom < payday ? payday - dom : null;

  return {
    dow, isWeekend,
    isHoliday, holidayName: todayInfo ? todayInfo.name : null,
    weekOfMonth: weekOfMonth(d),
    consecutiveHolidayDay,
    daysToNextMajorHoliday, nextMajorHolidayName,
    daysSincePayday, daysUntilPayday,
  };
}

// 날씨 + 달력 맥락을 한 번에. 둘 다 실패해도 절대 throw하지 않는다.
export async function getContext(lat, lon) {
  const [weather, calendar] = await Promise.all([
    fetchWeather(lat, lon).catch(() => ({ temp: null, pty: null, ptyLabel: null, sky: null, skyLabel: null })),
    getCalendarContext().catch(() => null),
  ]);
  return { weather, calendar };
}
