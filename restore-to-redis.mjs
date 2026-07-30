// 백업해 둔 Netlify Blobs 데이터를 Upstash Redis로 복원한다 (1회용)
// 사용법:
//   1) 이 프로젝트 폴더에서 `vercel env pull .env.local` (또는 .env.local에 아래 두 값 직접 입력)
//        KV_REST_API_URL=...
//        KV_REST_API_TOKEN=...
//   2) blobs-backup 폴더를 이 폴더 안에 복사
//   3) node --env-file=.env.local restore-to-redis.mjs
import { Redis } from "@upstash/redis";
import fs from "node:fs";
import path from "node:path";

const BACKUP_DIR = "./blobs-backup";

if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) {
  console.error("KV_REST_API_URL / KV_REST_API_TOKEN 이 없습니다. .env.local을 확인해 주세요.");
  process.exit(1);
}
if (!fs.existsSync(BACKUP_DIR)) {
  console.error(`${BACKUP_DIR} 폴더가 없습니다. 백업 폴더를 이 폴더 안에 복사해 주세요.`);
  process.exit(1);
}

const redis = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

// 폴더를 재귀적으로 훑어 파일 경로를 모은다
function walk(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

// traffic-stats: 키를 agg/<cat>/<지점명 인코딩>/<주> 형태로 복원
// geo-cache:     키를 geo/<cat>/<지점명 인코딩> 형태로 복원
function toRedisKey(store, relParts) {
  if (store === "traffic-stats") {
    // relParts = ['agg', cat, 지점명, 주]
    const [agg, cat, name, wk] = relParts;
    return `${agg}/${cat}/${encodeURIComponent(name)}/${wk}`;
  }
  // geo-cache: relParts = [cat, 지점명]
  const [cat, name] = relParts;
  return `geo/${cat}/${encodeURIComponent(name)}`;
}

let total = 0, ok = 0, skip = 0;

for (const store of ["traffic-stats", "geo-cache"]) {
  const dir = path.join(BACKUP_DIR, store);
  if (!fs.existsSync(dir)) {
    console.log(`(${store} 백업 폴더 없음 — 건너뜀)`);
    continue;
  }
  console.log(`\n=== ${store} 복원 ===`);

  for (const file of walk(dir)) {
    total++;
    const relParts = path.relative(dir, file).split(path.sep);
    const key = toRedisKey(store, relParts);

    let value;
    try {
      value = JSON.parse(fs.readFileSync(file, "utf-8"));
    } catch (e) {
      console.error(`  건너뜀(JSON 아님): ${relParts.join("/")}`);
      skip++;
      continue;
    }

    try {
      await redis.set(key, value);
      ok++;
      if (ok % 20 === 0) console.log(`  ${ok}건 완료`);
    } catch (e) {
      console.error(`  실패: ${key} — ${e.message}`);
      skip++;
    }
  }
}

console.log(`\n복원 완료: 성공 ${ok}건 / 건너뜀 ${skip}건 (전체 ${total}건)`);
console.log("확인: 앱에서 코스트코 지점을 탭했을 때 '제로트래픽 시각'이 표시되면 정상입니다.");
