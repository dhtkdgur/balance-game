/**
 * 밸런스 게임 플레이테스트 시뮬레이터
 * 참가자 200명 + 진행자 1명 시뮬레이션
 *
 * 사용법: node playtest.js  (서버가 먼저 실행되어 있어야 합니다)
 */

const { io } = require('socket.io-client');

const SERVER          = 'http://localhost:3000';
const NUM_PARTICIPANTS = 200;
const QUESTION_DURATION = 6000; // 질문당 투표 대기 시간 (ms)
const CONNECT_BATCH    = 20;    // 한 번에 접속할 참가자 수
const CONNECT_DELAY    = 50;    // 배치 간 딜레이 (ms)

const sleep = ms => new Promise(r => setTimeout(r, ms));
const rand  = (lo, hi) => Math.random() * (hi - lo) + lo;

// ── ANSI 색상 ──────────────────────────────────────────────────────────────
const C = {
  r: '\x1b[0m',  b: '\x1b[1m',  dim: '\x1b[2m',
  red:     '\x1b[31m', green:   '\x1b[32m',
  yellow:  '\x1b[33m', blue:    '\x1b[34m',
  magenta: '\x1b[35m', cyan:    '\x1b[36m',
  white:   '\x1b[37m',
};

// ── 집계 변수 ──────────────────────────────────────────────────────────────
let connectedCount = 0;
let totalVotes     = 0;
const liveVotes    = {}; // { [questionId]: { A: n, B: n } }

// ── 참가자 생성 ────────────────────────────────────────────────────────────
function spawnParticipant(idx) {
  const sock  = io(SERVER, { reconnection: false, timeout: 8000 });
  const voted = {};

  sock.on('connect',       () => connectedCount++);
  sock.on('connect_error', () => {});  // 무시

  sock.on('game:state', state => {
    if (state.phase !== 'question') return;
    const q = state.currentQuestion;
    if (!q || voted[q.id]) return;

    // 투표 행동 모델:
    //  10% — 기권 (투표 안 함)
    //  25% — 빠른 투표 (100~700ms)
    //  65% — 일반 투표 (700~5500ms, 일부는 시간 초과로 반영 안 될 수 있음)
    const roll = Math.random();
    if (roll < 0.10) return;
    const delay = roll < 0.35
      ? rand(100,  700)   // 빠른 투표자
      : rand(700, 5500);  // 일반 투표자

    const qid = q.id;
    setTimeout(() => {
      if (voted[qid]) return;
      // 선택지 비율: 완전 50/50이 아닌 약간의 편향을 각 참가자마다 다르게
      const bias = 0.35 + Math.random() * 0.30; // 0.35~0.65
      const choice = Math.random() < bias ? 'A' : 'B';
      sock.emit('participant:vote', { questionId: qid, choice });
      voted[qid] = choice;
    }, delay);
  });

  sock.on('vote:success', () => totalVotes++);
  return sock;
}

// ── 막대 그래프 문자열 ────────────────────────────────────────────────────
function bar(pct, width) {
  const n = Math.round(Math.max(0, Math.min(100, pct)) / 100 * width);
  return C.white + '█'.repeat(n) + C.dim + '░'.repeat(width - n) + C.r;
}

// ── 메인 시뮬레이션 ────────────────────────────────────────────────────────
async function main() {
  console.log(`
${C.cyan}${C.b}╔══════════════════════════════════════════════════╗
║   ⚖️  밸런스 게임 플레이테스트 시뮬레이터          ║
║   참가자 ${NUM_PARTICIPANTS}명  +  진행자 1명                    ║
╚══════════════════════════════════════════════════╝${C.r}
`);

  // ── STEP 1: 진행자 접속 ─────────────────────────────────────────────────
  process.stdout.write(`${C.yellow}[STEP 1]${C.r} 진행자 접속 중... `);

  const host = io(SERVER, { reconnection: false, timeout: 8000 });

  const initState = await new Promise((resolve, reject) => {
    const timer = setTimeout(() =>
      reject(new Error(
        '서버 응답 없음.\n  먼저 다른 터미널에서 node server.js 를 실행해주세요.'
      )), 7000);
    host.once('game:state',    s => { clearTimeout(timer); resolve(s); });
    host.once('connect_error', e => { clearTimeout(timer); reject(e); });
  });

  console.log(`${C.green}완료 ✓${C.r}  (질문 ${initState.questions.length}개 로드됨)\n`);

  // 실시간 투표 추적
  host.on('game:voteUpdated', ({ questionId, votes }) => {
    liveVotes[questionId] = { ...votes };
  });

  // 다음 game:state 이벤트를 한 번만 기다리는 헬퍼
  const awaitState = () => new Promise(r => host.once('game:state', r));

  // ── STEP 2: 참가자 200명 접속 ───────────────────────────────────────────
  process.stdout.write(`${C.yellow}[STEP 2]${C.r} 참가자 ${NUM_PARTICIPANTS}명 접속 중`);

  const participants = [];
  for (let i = 0; i < NUM_PARTICIPANTS; i++) {
    participants.push(spawnParticipant(i));
    if ((i + 1) % CONNECT_BATCH === 0) {
      process.stdout.write('.');
      await sleep(CONNECT_DELAY);
    }
  }
  await sleep(1800); // 소켓 안정화 대기
  console.log(` ${C.green}${connectedCount}명 접속 완료 ✓${C.r}\n`);

  // ── STEP 3: 게임 시작 ───────────────────────────────────────────────────
  process.stdout.write(`${C.yellow}[STEP 3]${C.r} 게임 시작 신호 전송... `);
  host.emit('host:next');
  let state = await awaitState();
  console.log(`${C.green}완료 ✓${C.r}  (phase: ${state.phase})\n`);

  // ── STEP 4: 질문 순환 ───────────────────────────────────────────────────
  console.log(`${C.yellow}[STEP 4]${C.r} 질문 진행 시작 (질문당 ${QUESTION_DURATION / 1000}초)\n`);

  const questions = initState.questions;
  const results   = [];

  for (let qi = 0; qi < questions.length; qi++) {
    const q = questions[qi];
    if (!liveVotes[q.id]) liveVotes[q.id] = { A: 0, B: 0 };

    // 질문 헤더
    console.log(`${C.b}${C.cyan}  ┌── 질문 ${qi + 1} / ${questions.length} ${'─'.repeat(38)}┐${C.r}`);
    console.log(`${C.b}  │  "${q.text}"${C.r}`);
    console.log(`  │  ${C.blue}A: ${q.optionA}${C.r}  vs  ${C.magenta}B: ${q.optionB}${C.r}`);
    console.log(`  │`);

    // 실시간 투표 현황 tick
    const t0 = Date.now();
    while (Date.now() - t0 < QUESTION_DURATION) {
      await sleep(400);
      const v   = liveVotes[q.id] || { A: 0, B: 0 };
      const tot = v.A + v.B;
      const pA  = tot ? Math.round(v.A / tot * 100) : 0;
      const pB  = tot ? 100 - pA : 0;
      const sec = ((Date.now() - t0) / 1000).toFixed(1);

      process.stdout.write(
        `\r  │ ${C.dim}[${sec}s]${C.r}  ` +
        `${C.blue}A ${bar(pA, 12)} ${String(pA + '%').padStart(4)} (${String(v.A).padStart(3)}명)${C.r}   ` +
        `${C.magenta}B ${bar(pB, 12)} ${String(pB + '%').padStart(4)} (${String(v.B).padStart(3)}명)${C.r}  ` +
        `${C.dim}총 ${tot}명${C.r}  `
      );
    }
    console.log(); // 줄바꿈

    // 최종 스냅샷
    const fv  = { ...(liveVotes[q.id] || { A: 0, B: 0 }) };
    const tot = fv.A + fv.B;
    const pA  = tot ? Math.round(fv.A / tot * 100) : 0;
    const pB  = 100 - pA;
    results.push({ q, votes: fv, pA, pB });

    const winner = pA >= pB
      ? `${C.blue}A — ${q.optionA}${C.r}`
      : `${C.magenta}B — ${q.optionB}${C.r}`;
    const partRate = tot > 0 ? ((tot / (connectedCount * 0.9)) * 100).toFixed(0) : 0;

    console.log(`  │`);
    console.log(`  │  ${C.green}${C.b}🏆 승자: ${winner}${C.b}${C.r}   (참여율 ~${partRate}%)`);
    console.log(`${C.cyan}  └${'─'.repeat(48)}┘${C.r}\n`);

    await sleep(300);
    host.emit('host:next');
    state = await awaitState();
    await sleep(150);
  }

  // ── STEP 5: 최종 결과 요약 ──────────────────────────────────────────────
  const totalPossibleVotes = NUM_PARTICIPANTS * questions.length;
  const avgParticipation   = ((totalVotes / totalPossibleVotes) * 100).toFixed(1);

  console.log(`\n${C.cyan}${C.b}╔══════════════════════════════════════════════════════════╗`);
  console.log(`║                    📊  최종 결과 요약                    ║`);
  console.log(`╠══════════════════════════════════════════════════════════╣${C.r}`);

  results.forEach((r, i) => {
    const { q, votes, pA, pB } = r;
    const tot  = votes.A + votes.B;
    const winA = pA >= pB;

    console.log(`${C.cyan}║  Q${i + 1}. ${q.text}`);
    console.log(`║${C.r}     ${C.blue}A) ${q.optionA.padEnd(10)}${C.r} ${bar(pA, 18)} ${String(pA + '%').padStart(4)} (${String(votes.A).padStart(3)}명) ${winA ? C.green + C.b + '🏆' + C.r : '  '}${C.cyan}`);
    console.log(`${C.cyan}║${C.r}     ${C.magenta}B) ${q.optionB.padEnd(10)}${C.r} ${bar(pB, 18)} ${String(pB + '%').padStart(4)} (${String(votes.B).padStart(3)}명) ${!winA ? C.green + C.b + '🏆' + C.r : '  '}${C.cyan}`);
    console.log(`${C.cyan}║     ${C.dim}총 ${tot}명 투표${C.r}${C.cyan}`);
    if (i < results.length - 1) console.log(`╠══════════════════════════════════════════════════════════╣`);
  });

  console.log(`╠══════════════════════════════════════════════════════════╣`);
  console.log(`║  접속 참가자: ${String(connectedCount).padStart(3)}명  │  총 투표수: ${String(totalVotes).padStart(4)}표  │  평균 참여율: ${avgParticipation}%  ║`);
  console.log(`╚══════════════════════════════════════════════════════════╝${C.r}\n`);

  // ── STEP 6: 요약 화면 확인 ──────────────────────────────────────────────
  console.log(`${C.green}✓ 서버 phase: ${state.phase}  (참가자 화면도 요약 화면으로 전환됨)${C.r}`);
  console.log(`${C.dim}접속 종료 중...${C.r}`);

  host.disconnect();
  participants.forEach(p => p.disconnect());
  await sleep(500);
  process.exit(0);
}

main().catch(err => {
  console.error(`\n${C.red}❌ 오류: ${err.message}${C.r}\n`);
  process.exit(1);
});
