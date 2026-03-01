const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// ── Game State ────────────────────────────────────────────────────────────────

let state = {
  phase: 'setup', // 'setup' | 'lobby' | 'question' | 'summary'
  questions: [
    { id: 1, text: '밤새 과제 vs 아침 일찍 일어나서 과제', optionA: '밤새 과제', optionB: '아침 일찍 과제' },
    { id: 2, text: '팀플 할 때 조장 vs 팀원', optionA: '조장', optionB: '팀원' },
    { id: 3, text: '전공 수업 앞자리 vs 뒷자리', optionA: '앞자리', optionB: '뒷자리' },
    { id: 4, text: '졸업 후 취업 vs 창업', optionA: '취업', optionB: '창업' },
    { id: 5, text: '포트폴리오 혼자 작업 vs 협업', optionA: '혼자 작업', optionB: '협업' },
  ],
  currentIndex: -1,
  votes: {},    // { [questionId]: { A: number, B: number } }
  nextId: 6,
};

// Track voted questions per socket session: socketId → Set<questionId>
const votedMap = new Map();
// Track host sockets to exclude from participantCount
const hostSockets = new Set();

// ── Helpers ───────────────────────────────────────────────────────────────────

function currentQuestion() {
  if (state.currentIndex < 0 || state.currentIndex >= state.questions.length) return null;
  return state.questions[state.currentIndex];
}

function votesFor(id) {
  return state.votes[id] || { A: 0, B: 0 };
}

function buildState() {
  const q = currentQuestion();
  return {
    phase: state.phase,
    questions: state.questions,
    currentIndex: state.currentIndex,
    currentQuestion: q,
    currentVotes: q ? votesFor(q.id) : null,
    allVotes: state.votes,
    participantCount: Math.max(0, io.sockets.sockets.size - hostSockets.size),
  };
}

function broadcast() {
  io.emit('game:state', buildState());
}

function broadcastCount() {
  io.emit('count:update', { participantCount: Math.max(0, io.sockets.sockets.size - hostSockets.size) });
}

// ── Socket Handlers ───────────────────────────────────────────────────────────

io.on('connection', (socket) => {
  console.log(`[+] ${socket.id}`);
  votedMap.set(socket.id, new Set());

  // Send full state to the new connection only
  socket.emit('game:state', buildState());
  // Notify everyone of updated participant count (lightweight)
  broadcastCount();

  socket.on('host:register', () => {
    hostSockets.add(socket.id);
    broadcastCount();
  });

  socket.on('disconnect', () => {
    votedMap.delete(socket.id);
    hostSockets.delete(socket.id);
    console.log(`[-] ${socket.id}`);
    broadcastCount();
  });

  // ── Host: question management ─────────────────────────────────────────────

  socket.on('host:add', ({ text, optionA, optionB }) => {
    if (!text?.trim() || !optionA?.trim() || !optionB?.trim()) return;
    state.questions.push({
      id: state.nextId++,
      text: text.trim(),
      optionA: optionA.trim(),
      optionB: optionB.trim(),
    });
    broadcast();
  });

  socket.on('host:update', ({ id, text, optionA, optionB }) => {
    const q = state.questions.find(q => q.id === id);
    if (!q || !text?.trim() || !optionA?.trim() || !optionB?.trim()) return;
    q.text = text.trim();
    q.optionA = optionA.trim();
    q.optionB = optionB.trim();
    broadcast();
  });

  socket.on('host:delete', (id) => {
    const idx = state.questions.findIndex(q => q.id === id);
    if (idx === -1) return;
    delete state.votes[state.questions[idx].id];
    state.questions.splice(idx, 1);
    // Keep currentIndex in bounds
    if (state.currentIndex >= state.questions.length) {
      state.currentIndex = Math.max(0, state.questions.length - 1);
    }
    if (state.questions.length === 0) {
      state.phase = 'setup';
      state.currentIndex = -1;
    }
    broadcast();
  });

  // ── Host: navigation ──────────────────────────────────────────────────────

  socket.on('host:next', () => {
    if (state.questions.length === 0) return;
    if (state.phase === 'setup') {
      state.phase = 'lobby';
    } else if (state.phase === 'lobby') {
      state.phase = 'question';
      state.currentIndex = 0;
    } else if (state.phase === 'question') {
      if (state.currentIndex < state.questions.length - 1) {
        state.currentIndex++;
      } else {
        state.phase = 'summary';
      }
    }
    broadcast();
  });

  socket.on('host:prev', () => {
    if (state.phase === 'lobby') {
      state.phase = 'setup';
      broadcast();
    } else if (state.phase === 'question' && state.currentIndex > 0) {
      state.currentIndex--;
      broadcast();
    } else if (state.phase === 'summary') {
      state.phase = 'question';
      broadcast();
    }
  });

  socket.on('host:reset', () => {
    state.phase = 'setup';
    state.currentIndex = -1;
    state.votes = {};
    votedMap.forEach(s => s.clear());
    broadcast();
  });

  // ── Participant: vote ─────────────────────────────────────────────────────

  socket.on('participant:vote', ({ questionId, choice }) => {
    const voted = votedMap.get(socket.id);
    if (!voted) return;
    if (voted.has(questionId)) {
      socket.emit('vote:duplicate');
      return;
    }

    const cur = currentQuestion();
    if (!cur || cur.id !== questionId) return;
    if (state.phase !== 'question') return;
    if (choice !== 'A' && choice !== 'B') return;

    if (!state.votes[questionId]) state.votes[questionId] = { A: 0, B: 0 };
    state.votes[questionId][choice]++;
    voted.add(questionId);

    socket.emit('vote:success', { choice });
    io.emit('game:voteUpdated', { questionId, votes: state.votes[questionId] });
  });
});

// ── Start Server ──────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n포트 ${PORT}가 이미 사용 중입니다.`);
    console.error('기존 서버를 종료하거나 다른 포트로 실행하세요.');
    console.error('예: $env:PORT=3001; node server.js\n');
    process.exit(1);
  }
  throw err;
});

server.listen(PORT, () => {
  console.log(`\n  ⚖️  밸런스 게임 서버 실행 중\n`);
  console.log(`  진행자: http://localhost:${PORT}/host.html`);
  console.log(`  참가자: http://localhost:${PORT}/participant.html\n`);
});
