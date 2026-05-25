// server/server.js
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { CODENAMES_WORDS_1000 } = require('./data/words');

const app = express();
app.use(express.static('public'));
const server = http.createServer(app);

// Render 환경에서는 외부 연결을 유연하게 받아줘야 포트 통신이 뚫려
const io = new Server(server, { 
  cors: { 
    origin: "*", 
    methods: ["GET", "POST"],
    credentials: true
  },
  transports: ['websocket', 'polling'] 
});
const rooms = {};
const roomIntervals = {};

function generateRoomId() { return Math.random().toString(36).substring(2, 6).toUpperCase(); }
function get25RandomWords(allWords) {
  const shuffled = [...allWords];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled.slice(0, 25);
}
function generateGameBoard(allWords) {
  const selectedWords = get25RandomWords(allWords);
  const types = [...Array(9).fill("RED"), ...Array(8).fill("BLUE"), ...Array(7).fill("NEUTRAL"), "ASSASSIN"];
  for (let i = types.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [types[i], types[j]] = [types[j], types[i]];
  }
  return selectedWords.map((word, index) => ({ id: index, text: word, type: types[index], isRevealed: false }));
}
function filterBoardForOperatives(words) {
  return words.map(card => card.isRevealed ? card : { id: card.id, text: card.text, isRevealed: false, type: "UNKNOWN" });
}

function broadcastRoomState(roomId) {
  const room = rooms[roomId];
  if (!room) return;
  Object.keys(room.players).forEach(pId => {
    const isSpymaster = (room.slots.RED_SPYMASTER === pId || room.slots.BLUE_SPYMASTER === pId);
    if (isSpymaster) { io.to(pId).emit('update_room', room); } 
    else { io.to(pId).emit('update_room', { ...room, words: filterBoardForOperatives(room.words) }); }
  });
}

function startRoomTimer(roomId) {
  if (roomIntervals[roomId]) clearInterval(roomIntervals[roomId]);
  roomIntervals[roomId] = setInterval(() => {
    const room = rooms[roomId];
    if (!room || room.gameState.phase === "LOBBY" || room.gameState.phase === "ENDED") { clearInterval(roomIntervals[roomId]); return; }
    if (room.gameState.timer <= 0) { handleTimeOut(roomId); return; }
    room.gameState.timer -= 1;
    io.to(roomId).emit('timer_update', { timer: room.gameState.timer });
  }, 1000);
}

function handleTimeOut(roomId) {
  const room = rooms[roomId];
  if (!room) return;
  changeTurnToNextTeam(room);
  broadcastRoomState(roomId);
}

function changeTurnToNextTeam(room) {
  room.gameState.phase = "CLUE_WAITING";
  room.gameState.turn = room.gameState.turn === "RED" ? "BLUE" : "RED";
  room.gameState.timer = room.settings.clueTimeLimit;
  room.gameState.currentClue = { word: "", count: 0, guessedCount: 0 };
}

function checkWinner(room) {
  const redRemaining = room.words.filter(w => w.type === "RED" && !w.isRevealed).length;
  const blueRemaining = room.words.filter(w => w.type === "BLUE" && !w.isRevealed).length;
  if (redRemaining === 0) return "RED";
  if (blueRemaining === 0) return "BLUE";
  return null;
}

io.on('connection', (socket) => {
  socket.on('join_room', ({ roomId, nickname }) => {
    let targetRoomId = roomId ? roomId.toUpperCase() : null;
    let isHost = false;

    if (!targetRoomId || !rooms[targetRoomId]) {
      targetRoomId = generateRoomId();
      isHost = true;
      rooms[targetRoomId] = {
        roomId: targetRoomId,
        settings: { maxPlayers: 8, clueTimeLimit: 60, guessTimeLimit: 90 },
        gameState: { phase: "LOBBY", turn: "RED", currentClue: { word: "", count: 0, guessedCount: 0 }, timer: 0, winner: null },
        slots: { 
          RED_SPYMASTER: null, BLUE_SPYMASTER: null, 
          RED_LEADER: null, BLUE_LEADER: null, // 선택자 전용 슬롯 추가
          RED_OPERATIVES: [null, null, null], BLUE_OPERATIVES: [null, null, null] 
        },
        players: {}, words: []
      };
    }

    const room = rooms[targetRoomId];
    socket.join(targetRoomId);
    room.players[socket.id] = { id: socket.id, nickname: nickname || `유저_${socket.id.substring(0, 4)}`, isHost: isHost };
    socket.emit('room_joined', { roomId: targetRoomId, myId: socket.id });
    broadcastRoomState(targetRoomId);
  });

  socket.on('change_max_players', ({ roomId, maxPlayers }) => {
    const room = rooms[roomId];
    if (!room || !room.players[socket.id]?.isHost) return;
    room.settings.maxPlayers = maxPlayers;
    const opSize = Math.max(1, (maxPlayers / 2) - 2); // 팀장1, 선택자1 제외한 일반 요원 수
    const resize = (arr, size) => {
      const next = Array(size).fill(null);
      for(let i=0; i<size; i++) if(arr[i]) next[i] = arr[i];
      return next;
    };
    room.slots.RED_OPERATIVES = resize(room.slots.RED_OPERATIVES, opSize);
    room.slots.BLUE_OPERATIVES = resize(room.slots.BLUE_OPERATIVES, opSize);
    broadcastRoomState(roomId);
  });

  socket.on('change_timer_settings', ({ roomId, clueTimeLimit, guessTimeLimit }) => {
    const room = rooms[roomId];
    if (!room || !room.players[socket.id]?.isHost) return;
    room.settings.clueTimeLimit = clueTimeLimit;
    room.settings.guessTimeLimit = guessTimeLimit;
    broadcastRoomState(roomId);
  });

  socket.on('select_slot', ({ roomId, slotType, index }) => {
    const room = rooms[roomId];
    if (!room) return;

    const pId = socket.id;
    // 모든 슬롯 롤백 청소
    if (room.slots.RED_SPYMASTER === pId) room.slots.RED_SPYMASTER = null;
    if (room.slots.BLUE_SPYMASTER === pId) room.slots.BLUE_SPYMASTER = null;
    if (room.slots.RED_LEADER === pId) room.slots.RED_LEADER = null;
    if (room.slots.BLUE_LEADER === pId) room.slots.BLUE_LEADER = null;
    room.slots.RED_OPERATIVES = room.slots.RED_OPERATIVES.map(id => id === pId ? null : id);
    room.slots.BLUE_OPERATIVES = room.slots.BLUE_OPERATIVES.map(id => id === pId ? null : id);

    if (index === null) {
      if (room.slots[slotType] === null) room.slots[slotType] = pId;
    } else {
      if (room.slots[slotType][index] === null) room.slots[slotType][index] = pId;
    }
    broadcastRoomState(roomId);
  });

  socket.on('toggle_lock_slot', ({ roomId, slotType, index }) => {
    const room = rooms[roomId];
    if (!room || !room.players[socket.id]?.isHost) return;
    if (slotType === 'RED_OPERATIVES' || slotType === 'BLUE_OPERATIVES') {
      const current = room.slots[slotType][index];
      room.slots[slotType][index] = current === null ? "LOCKED" : current === "LOCKED" ? null : current;
    }
    broadcastRoomState(roomId);
  });

  socket.on('game_start', ({ roomId }) => {
    const room = rooms[roomId];
    if (!room || !room.players[socket.id]?.isHost) return;
    if (!room.slots.RED_SPYMASTER || !room.slots.BLUE_SPYMASTER || !room.slots.RED_LEADER || !room.slots.BLUE_LEADER) {
      return socket.emit('game_error', { message: "양 팀의 팀장과 선택자(대표)가 모두 배정되어야 작전 개시가 가능합니다." });
    }
    room.words = generateGameBoard(CODENAMES_WORDS_1000);
    room.gameState.phase = "CLUE_WAITING";
    room.gameState.turn = "RED";
    room.gameState.currentClue = { word: "", count: 0, guessedCount: 0 };
    room.gameState.timer = room.settings.clueTimeLimit;
    broadcastRoomState(roomId);
    startRoomTimer(roomId);
  });

  socket.on('submit_clue', ({ roomId, word, count }) => {
    const room = rooms[roomId];
    if (!room || room.gameState.phase !== "CLUE_WAITING") return;
    const currentSpy = room.gameState.turn === "RED" ? room.slots.RED_SPYMASTER : room.slots.BLUE_SPYMASTER;
    if (currentSpy !== socket.id) return;

    room.gameState.currentClue = { word, count: parseInt(count, 10), guessedCount: 0 };
    room.gameState.phase = "GUESSING";
    room.gameState.timer = room.settings.guessTimeLimit;
    broadcastRoomState(roomId);
  });

  socket.on('click_card', ({ roomId, cardId }) => {
    const room = rooms[roomId];
    if (!room || room.gameState.phase !== "GUESSING") return;

    // [핵심 변경] 오직 현재 턴인 팀의 '선택자(LEADER)'만 클릭 검증 및 패스 허용
    const currentTurn = room.gameState.turn;
    const currentLeader = currentTurn === "RED" ? room.slots.RED_LEADER : room.slots.BLUE_LEADER;
    
    if (currentLeader !== socket.id) return; // 선택자가 아니면 묵살

    const card = room.words.find(w => w.id === cardId);
    if (!card || card.isRevealed) return;

    card.isRevealed = true;
    room.gameState.currentClue.guessedCount += 1;

    if (card.type === "ASSASSIN") {
      room.gameState.phase = "ENDED"; room.gameState.winner = currentTurn === "RED" ? "BLUE" : "RED";
      broadcastRoomState(roomId); return;
    }
    const winner = checkWinner(room);
    if (winner) {
      room.gameState.phase = "ENDED"; room.gameState.winner = winner;
      broadcastRoomState(roomId); return;
    }

    if (card.type === currentTurn) {
      if (room.gameState.currentClue.guessedCount >= (room.gameState.currentClue.count + 1)) {
        changeTurnToNextTeam(room);
      }
    } else {
      changeTurnToNextTeam(room);
    }
    broadcastRoomState(roomId);
  });

  socket.on('skip_guess', ({ roomId }) => {
    const room = rooms[roomId];
    if (!room || room.gameState.phase !== "GUESSING") return;
    const currentLeader = room.gameState.turn === "RED" ? room.slots.RED_LEADER : room.slots.BLUE_LEADER;
    if (currentLeader !== socket.id) return; // 선택자만 턴 패스 가능

    changeTurnToNextTeam(room);
    broadcastRoomState(roomId);
  });

  socket.on('disconnect', () => {
    Object.keys(rooms).forEach(roomId => {
      const room = rooms[roomId];
      if (room && room.players[socket.id]) {
        const wasHost = room.players[socket.id].isHost;
        if (room.slots.RED_SPYMASTER === socket.id) room.slots.RED_SPYMASTER = null;
        if (room.slots.BLUE_SPYMASTER === socket.id) room.slots.BLUE_SPYMASTER = null;
        if (room.slots.RED_LEADER === socket.id) room.slots.RED_LEADER = null;
        if (room.slots.BLUE_LEADER === socket.id) room.slots.BLUE_LEADER = null;
        room.slots.RED_OPERATIVES = room.slots.RED_OPERATIVES.map(id => id === socket.id ? null : id);
        room.slots.BLUE_OPERATIVES = room.slots.BLUE_OPERATIVES.map(id => id === socket.id ? null : id);
        delete room.players[socket.id];
        const rem = Object.keys(room.players);
        if (rem.length === 0) { delete rooms[roomId]; if (roomIntervals[roomId]) clearInterval(roomIntervals[roomId]); } 
        else if (wasHost) { room.players[rem[0]].isHost = true; broadcastRoomState(roomId); } 
        else { broadcastRoomState(roomId); }
      }
    });
  });
});

const PORT = 4000;
server.listen(PORT, () => console.log(`코어 서버 포트 활성화: ${PORT}`));