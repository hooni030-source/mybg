const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { CODENAMES_WORDS_1000 } = require('./data/words');
const crypto = require('crypto');

const app = express();
app.use(express.static('public'));

const server = http.createServer(app);
const io = new Server(server, { 
  cors: { origin: "*", methods: ["GET", "POST"], credentials: true },
  transports: ['websocket', 'polling'] 
});

const rooms = {};
const roomTimers = {};
const DISCONNECT_GRACE_MS = 120000;

function getRoomKey(roomId) {
  return roomId ? String(roomId).toUpperCase() : null;
}

function getPublicRoom(room) {
  if (!room) return null;
  return {
    roomId: room.roomId,
    players: room.players,
    slots: room.slots,
    config: room.config,
    words: room.words,
    gameState: room.gameState,
    timerSettings: room.timerSettings,
    timer: room.timer
  };
}

function emitRoomUpdate(roomId) {
  const targetRoomId = getRoomKey(roomId);
  const room = rooms[targetRoomId];
  if (room) io.to(targetRoomId).emit('update_room', getPublicRoom(room));
}

function clearRoomTimer(roomId) {
  const targetRoomId = getRoomKey(roomId);
  if (targetRoomId && roomTimers[targetRoomId]) {
    clearInterval(roomTimers[targetRoomId]);
    delete roomTimers[targetRoomId];
  }
}

function generateRoomId() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  let result = '';
  for (let i = 0; i < 4; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

function getRandomWords(count) {
  const shuffled = [...CODENAMES_WORDS_1000];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled.slice(0, count);
}

// 💡 슬롯 규격을 maxPlayers 세팅에 맞춰 엄격하게 강제 보정해주는 유틸 함수 정의
function enforceSlotStructure(room) {
  const maxPlayers = room.config.maxPlayers || 8;
  // 팀장 2명 + 최종선택자 2명 = 4명을 뺀 나머지가 일반 요원(Operatives)의 몫
  const opCount = Math.max(0, Math.floor((maxPlayers - 4) / 2));

  if (!room.slots.RED_OPERATIVES) room.slots.RED_OPERATIVES = [];
  if (!room.slots.BLUE_OPERATIVES) room.slots.BLUE_OPERATIVES = [];

  // 모자라면 빈 슬롯 채우고, 넘치면 잘라내서 정원 불일치 원천 차단
  while (room.slots.RED_OPERATIVES.length < opCount) room.slots.RED_OPERATIVES.push(null);
  while (room.slots.RED_OPERATIVES.length > opCount) room.slots.RED_OPERATIVES.pop();
  while (room.slots.BLUE_OPERATIVES.length < opCount) room.slots.BLUE_OPERATIVES.push(null);
  while (room.slots.BLUE_OPERATIVES.length > opCount) room.slots.BLUE_OPERATIVES.pop();
}

io.on('connection', (socket) => {
  
  socket.on('request_reconnect', ({ roomId, userToken }) => {
    const targetRoomId = getRoomKey(roomId);
    const room = rooms[targetRoomId];
    
    if (room && room.players[userToken]) {
      room.players[userToken].socketId = socket.id;
      socket.join(targetRoomId);
      socket.emit('room_joined', { roomId: targetRoomId, myId: userToken, userToken });
      emitRoomUpdate(targetRoomId);
    } else {
      socket.emit('reconnect_failed');
    }
  });
  
  socket.on('join_room', ({ roomId, nickname, userToken }) => {
    let targetRoomId = getRoomKey(roomId);
    
    if (!targetRoomId || !rooms[targetRoomId]) {
      targetRoomId = generateRoomId();
      while (rooms[targetRoomId]) { targetRoomId = generateRoomId(); }
      
      rooms[targetRoomId] = {
        roomId: targetRoomId,
        players: {},
        slots: {
          RED_SPYMASTER: null, RED_LEADER: null, RED_OPERATIVES: [],
          BLUE_SPYMASTER: null, BLUE_LEADER: null, BLUE_OPERATIVES: []
        },
        config: { maxPlayers: 8 }, // 기본값 8인 세팅
        words: [],
        gameState: { turn: 'RED', phase: 'LOBBY', currentClue: null, winner: null },
        timerSettings: { clueTimeLimit: 60, guessTimeLimit: 90 },
        timer: 0
      };
      // 초기 개설 시 슬롯 레이아웃 동기화
      enforceSlotStructure(rooms[targetRoomId]);
    }

    const room = rooms[targetRoomId];
    let token = userToken || crypto.randomBytes(16).toString('hex');
    const isHost = Object.keys(room.players).length === 0;
    
    room.players[token] = { 
      id: token, 
      socketId: socket.id, 
      nickname, 
      isHost: room.players[token] ? room.players[token].isHost : isHost 
    };
    
    socket.join(targetRoomId);
    socket.emit('room_joined', { roomId: targetRoomId, myId: token, userToken: token });
    emitRoomUpdate(targetRoomId);
  });

  socket.on('select_slot', ({ roomId, slotType, index }) => {
    const room = rooms[roomId];
    if (!room || room.gameState.phase !== 'LOBBY') return;

    const playerToken = Object.keys(room.players).find(t => room.players[t].socketId === socket.id);
    if (!playerToken) return;

    // 슬롯 변경 전 대청소
    if (room.slots.RED_SPYMASTER === playerToken) room.slots.RED_SPYMASTER = null;
    if (room.slots.BLUE_SPYMASTER === playerToken) room.slots.BLUE_SPYMASTER = null;
    if (room.slots.RED_LEADER === playerToken) room.slots.RED_LEADER = null;
    if (room.slots.BLUE_LEADER === playerToken) room.slots.BLUE_LEADER = null;
    if (room.slots.RED_OPERATIVES) room.slots.RED_OPERATIVES = room.slots.RED_OPERATIVES.map(v => v === playerToken ? null : v);
    if (room.slots.BLUE_OPERATIVES) room.slots.BLUE_OPERATIVES = room.slots.BLUE_OPERATIVES.map(v => v === playerToken ? null : v);

    // 슬롯 강제 보정 후 안착
    enforceSlotStructure(room);

    if (slotType !== 'SPECTATOR') {
      if (slotType === 'RED_SPYMASTER' && !room.slots.RED_SPYMASTER) room.slots.RED_SPYMASTER = playerToken;
      else if (slotType === 'BLUE_SPYMASTER' && !room.slots.BLUE_SPYMASTER) room.slots.BLUE_SPYMASTER = playerToken;
      else if (slotType === 'RED_LEADER' && !room.slots.RED_LEADER) room.slots.RED_LEADER = playerToken;
      else if (slotType === 'BLUE_LEADER' && !room.slots.BLUE_LEADER) room.slots.BLUE_LEADER = playerToken;
      else if (slotType === 'RED_OPERATIVES' && room.slots.RED_OPERATIVES[index] === null) room.slots.RED_OPERATIVES[index] = playerToken;
      else if (slotType === 'BLUE_OPERATIVES' && room.slots.BLUE_OPERATIVES[index] === null) room.slots.BLUE_OPERATIVES[index] = playerToken;
    }

    emitRoomUpdate(roomId);
  });

  socket.on('toggle_lock_slot', ({ roomId, slotType, index }) => {
    const room = rooms[roomId];
    if (!room || room.gameState.phase !== 'LOBBY') return;
    
    const playerToken = Object.keys(room.players).find(t => room.players[t].socketId === socket.id);
    if (!playerToken || !room.players[playerToken].isHost) return;

    enforceSlotStructure(room);

    const arr = slotType === 'RED_OPERATIVES' ? room.slots.RED_OPERATIVES : room.slots.BLUE_OPERATIVES;
    if (arr[index] === 'LOCKED') { arr[index] = null; } 
    else if (!arr[index]) { arr[index] = 'LOCKED'; }
    emitRoomUpdate(roomId);
  });

  socket.on('change_max_players', ({ roomId, maxPlayers }) => {
    const room = rooms[roomId];
    if (!room || room.gameState.phase !== 'LOBBY') return;
    
    const playerToken = Object.keys(room.players).find(t => room.players[t].socketId === socket.id);
    if (!playerToken || !room.players[playerToken].isHost) return;
    
    room.config.maxPlayers = parseInt(maxPlayers, 10);
    // 💡 셀렉트 박스 바꿀 때 즉시 슬롯 개수 늘리고 줄여서 프론트와 완벽 동기화
    enforceSlotStructure(room);

    emitRoomUpdate(roomId);
  });

  socket.on('change_timer_settings', ({ roomId, clueTimeLimit, guessTimeLimit }) => {
    const room = rooms[roomId];
    if (!room || room.gameState.phase !== 'LOBBY') return;
    
    const playerToken = Object.keys(room.players).find(t => room.players[t].socketId === socket.id);
    if (!playerToken || !room.players[playerToken].isHost) return;

    room.timerSettings = { clueTimeLimit: parseInt(clueTimeLimit, 10), guessTimeLimit: parseInt(guessTimeLimit, 10) };
    emitRoomUpdate(roomId);
  });

  socket.on('game_start', ({ roomId }) => {
    const targetRoomId = getRoomKey(roomId);
    const room = rooms[targetRoomId];
    if (!room) {
      socket.emit('game_start_failed', { reason: '방 정보를 찾을 수 없습니다. 새로고침 후 다시 입장해 주세요.' });
      return;
    }
    if (room.gameState.phase !== 'LOBBY') {
      socket.emit('game_start_failed', { reason: '로비 상태에서만 작전을 시작할 수 있습니다.' });
      return;
    }

    const playerToken = Object.keys(room.players).find(t => room.players[t].socketId === socket.id);
    if (!playerToken) {
      socket.emit('game_start_failed', { reason: '현재 소켓이 이 방의 플레이어로 등록되어 있지 않습니다. 다시 입장해 주세요.' });
      return;
    }
    if (!room.players[playerToken].isHost) {
      socket.emit('game_start_failed', { reason: '호스트만 작전을 시작할 수 있습니다.' });
      return;
    }

    // 💡 시작 버튼 누를 때 다시 한 번 현재 설정된 정원에 맞게 오퍼레이티브 슬롯 구조를 한 번 더 체크 및 정제
    enforceSlotStructure(room);

    // 25개 랜덤 카드 생성 가동
    const selectedWords = getRandomWords(25);
    const types = [
      ...Array(9).fill('RED'),
      ...Array(8).fill('BLUE'),
      ...Array(7).fill('NEUTRAL'),
      'ASSASSIN'
    ].sort(() => Math.random() - 0.5);

    room.words = selectedWords.map((word, i) => ({
      id: i,
      text: word,
      type: types[i],
      isRevealed: false
    }));

    room.gameState = { turn: 'RED', phase: 'CLUE_WAITING', currentClue: null, winner: null };
    
    clearRoomTimer(targetRoomId);
    startTimer(targetRoomId, room.timerSettings.clueTimeLimit);
    emitRoomUpdate(targetRoomId);
  });

  socket.on('submit_clue', ({ roomId, word, count }) => {
    const room = rooms[roomId];
    if (!room || room.gameState.phase !== 'CLUE_WAITING') return;

    room.gameState.phase = 'GUESSING';
    room.gameState.currentClue = { word, count: parseInt(count, 10), guessedCount: 0 };
    
    clearRoomTimer(roomId);
    startTimer(roomId, room.timerSettings.guessTimeLimit);
    emitRoomUpdate(roomId);
  });

  socket.on('click_card', ({ roomId, cardId }) => {
    const room = rooms[roomId];
    if (!room || room.gameState.phase !== 'GUESSING') return;

    const card = room.words.find(w => w.id === cardId);
    if (!card || card.isRevealed) return;

    card.isRevealed = true;
    const currentTurn = room.gameState.turn;

    if (card.type === 'ASSASSIN') {
      endGame(roomId, currentTurn === 'RED' ? 'BLUE' : 'RED');
      return;
    }

    if (card.type === currentTurn) {
      room.gameState.currentClue.guessedCount += 1;
      const leftWords = room.words.filter(w => w.type === currentTurn && !w.isRevealed).length;
      
      if (leftWords === 0) {
        endGame(roomId, currentTurn);
        return;
      }

      if (room.gameState.currentClue.guessedCount >= room.gameState.currentClue.count + 1) {
        switchTurn(roomId);
      }
    } else {
      const opponentTurn = currentTurn === 'RED' ? 'BLUE' : 'RED';
      const leftWords = room.words.filter(w => w.type === opponentTurn && !w.isRevealed).length;
      
      if (leftWords === 0) {
        endGame(roomId, opponentTurn);
        return;
      }
      switchTurn(roomId);
    }
    emitRoomUpdate(roomId);
  });

  socket.on('skip_guess', ({ roomId }) => {
    const room = rooms[roomId];
    if (!room || room.gameState.phase !== 'GUESSING') return;
    switchTurn(roomId);
    emitRoomUpdate(roomId);
  });

  socket.on('return_to_lobby', ({ roomId }) => {
    const room = rooms[roomId];
    if (!room) return;

    clearRoomTimer(roomId);
    room.gameState = { turn: 'RED', phase: 'LOBBY', currentClue: null, winner: null };
    room.words = [];
    room.timer = 0;

    room.slots.RED_SPYMASTER = null;
    room.slots.BLUE_SPYMASTER = null;
    room.slots.RED_LEADER = null;
    room.slots.BLUE_LEADER = null;
    
    // 로비 복귀 시 슬롯 초기화 후 구조 재확정
    if (room.slots.RED_OPERATIVES) room.slots.RED_OPERATIVES = room.slots.RED_OPERATIVES.map(v => v === 'LOCKED' ? 'LOCKED' : null);
    if (room.slots.BLUE_OPERATIVES) room.slots.BLUE_OPERATIVES = room.slots.BLUE_OPERATIVES.map(v => v === 'LOCKED' ? 'LOCKED' : null);
    enforceSlotStructure(room);

    emitRoomUpdate(roomId);
  });

  socket.on('disconnect', () => {
    for (const roomId in rooms) {
      const room = rooms[roomId];
      const playerToken = Object.keys(room.players).find(t => room.players[t].socketId === socket.id);
      if (playerToken) {
        setTimeout(() => {
          if (rooms[roomId] && rooms[roomId].players[playerToken] && rooms[roomId].players[playerToken].socketId === socket.id) {
            const wasHost = room.players[playerToken].isHost;
            delete room.players[playerToken];

            if (room.slots.RED_SPYMASTER === playerToken) room.slots.RED_SPYMASTER = null;
            if (room.slots.BLUE_SPYMASTER === playerToken) room.slots.BLUE_SPYMASTER = null;
            if (room.slots.RED_LEADER === playerToken) room.slots.RED_LEADER = null;
            if (room.slots.BLUE_LEADER === playerToken) room.slots.BLUE_LEADER = null;
            if (room.slots.RED_OPERATIVES) room.slots.RED_OPERATIVES = room.slots.RED_OPERATIVES.map(v => v === playerToken ? null : v);
            if (room.slots.BLUE_OPERATIVES) room.slots.BLUE_OPERATIVES = room.slots.BLUE_OPERATIVES.map(v => v === playerToken ? null : v);

            enforceSlotStructure(room);

            if (Object.keys(room.players).length === 0) {
              clearRoomTimer(roomId);
              delete rooms[roomId];
            } else if (wasHost) {
              const nextHostToken = Object.keys(room.players)[0];
              if (nextHostToken) room.players[nextHostToken].isHost = true;
              emitRoomUpdate(roomId);
            } else {
              emitRoomUpdate(roomId);
            }
          }
        }, DISCONNECT_GRACE_MS);
        break;
      }
    }
  });
});

function startTimer(roomId, duration) {
  const targetRoomId = getRoomKey(roomId);
  const room = rooms[targetRoomId];
  if (!room) return;
  
  room.timer = duration;
  io.to(targetRoomId).emit('timer_update', { timer: room.timer });

  clearRoomTimer(targetRoomId);
  roomTimers[targetRoomId] = setInterval(() => {
    room.timer -= 1;
    io.to(targetRoomId).emit('timer_update', { timer: room.timer });

    if (room.timer <= 0) {
      clearRoomTimer(targetRoomId);
      switchTurn(targetRoomId);
      emitRoomUpdate(targetRoomId);
    }
  }, 1000);
}

function switchTurn(roomId) {
  const targetRoomId = getRoomKey(roomId);
  const room = rooms[targetRoomId];
  if (!room) return;
  clearRoomTimer(targetRoomId);
  
  room.gameState.turn = room.gameState.turn === 'RED' ? 'BLUE' : 'RED';
  room.gameState.phase = 'CLUE_WAITING';
  room.gameState.currentClue = null;
  
  startTimer(targetRoomId, room.timerSettings.clueTimeLimit);
}

function endGame(roomId, winner) {
  const targetRoomId = getRoomKey(roomId);
  const room = rooms[targetRoomId];
  if (!room) return;
  clearRoomTimer(targetRoomId);
  room.gameState.phase = 'ENDED';
  room.gameState.winner = winner;
  emitRoomUpdate(targetRoomId);
}

const PORT = process.env.PORT || 4000;
server.listen(PORT, '0.0.0.0', () => console.log(`코어 서버 오픈포트: ${PORT}`));
