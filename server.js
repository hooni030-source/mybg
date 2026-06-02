const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { CODENAMES_WORDS_1000 } = require('./data/words');
const crypto = require('crypto'); // 💡 세션 토큰 생성을 위한 코어 모듈

const app = express();
app.use(express.static('public'));

const server = http.createServer(app);
const io = new Server(server, { 
  cors: { origin: "*", methods: ["GET", "POST"], credentials: true },
  transports: ['websocket', 'polling'] 
});

const rooms = {};

// 오직 영어 대문자 4자리 방 코드 생성기
function generateRoomId() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  let result = '';
  for (let i = 0; i < 4; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

// Fisher-Yates 셔플 알고리즘 단어 추출기
function getRandomWords(count) {
  const shuffled = [...CODENAMES_WORDS_1000];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled.slice(0, count);
}

io.on('connection', (socket) => {
  
  // 💡 [핵심 신기능] 유저가 새로고침 시 기존 토큰 들고 자동 복귀 요청하는 파이프라인
  socket.on('request_reconnect', ({ roomId, userToken }) => {
    const targetRoomId = roomId ? roomId.toUpperCase() : null;
    const room = rooms[targetRoomId];
    
    if (room && room.players[userToken]) {
      // 1. 끊겼던 유저의 구 소켓 ID를 방금 연결된 신규 소켓 ID로 갈아치움
      room.players[userToken].socketId = socket.id;
      socket.join(targetRoomId);
      
      // 2. 클라이언트에 원래 가지던 자기 토큰 식별값 그대로 던져줌
      socket.emit('room_joined', { roomId: targetRoomId, myId: userToken, userToken });
      
      // 3. 인게임이든 대기실이든 기존 상태 전체 브로드캐스팅 동기화
      io.to(targetRoomId).emit('update_room', room);
    } else {
      // 방이 터졌거나 세션 만료 시 클라이언트에 강제 초기화 신호 송신
      socket.emit('reconnect_failed');
    }
  });
  
  socket.on('join_room', ({ roomId, nickname, userToken }) => {
    let targetRoomId = roomId ? roomId.toUpperCase() : null;
    
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
        config: { maxPlayers: 8 }, // 클라이언트 렌더링 싱크용 config 객체 래핑
        words: [],
        gameState: { turn: 'RED', phase: 'LOBBY', currentClue: null, winner: null },
        timerSettings: { clueTimeLimit: 60, guessTimeLimit: 90 },
        timer: 0,
        timerInterval: null
      };
    }

    const room = rooms[targetRoomId];
    
    // 💡 [세션 연동] 클라이언트가 토큰을 안 들고 왔으면 새로 발급, 들고 왔는데 새 방 개설이면 재활용
    let token = userToken || crypto.randomBytes(16).toString('hex');
    
    // 이 방의 최초 접속자이면 방장(isHost) 권한 부여
    const isHost = Object.keys(room.players).length === 0;
    
    room.players[token] = { 
      id: token, 
      socketId: socket.id, 
      nickname, 
      isHost: room.players[token] ? room.players[token].isHost : isHost 
    };
    
    socket.join(targetRoomId);
    
    socket.emit('room_joined', { roomId: targetRoomId, myId: token, userToken: token });
    io.to(targetRoomId).emit('update_room', room);
  });

  socket.on('select_slot', ({ roomId, slotType, index }) => {
    const room = rooms[roomId];
    if (!room || room.gameState.phase !== 'LOBBY') return;

    // 현재 소켓 ID가 어떤 토큰 유저인지 역추적
    const playerToken = Object.keys(room.players).find(t => room.players[t].socketId === socket.id);
    if (!playerToken) return;

    // 기존 슬롯 청소 (토큰 기반 처리)
    if (room.slots.RED_SPYMASTER === playerToken) room.slots.RED_SPYMASTER = null;
    if (room.slots.BLUE_SPYMASTER === playerToken) room.slots.BLUE_SPYMASTER = null;
    if (room.slots.RED_LEADER === playerToken) room.slots.RED_LEADER = null;
    if (room.slots.BLUE_LEADER === playerToken) room.slots.BLUE_LEADER = null;
    room.slots.RED_OPERATIVES = room.slots.RED_OPERATIVES.map(v => v === playerToken ? null : v);
    room.slots.BLUE_OPERATIVES = room.slots.BLUE_OPERATIVES.map(v => v === playerToken ? null : v);

    // 새 슬롯 배치
    if (slotType === 'RED_SPYMASTER' && !room.slots.RED_SPYMASTER) room.slots.RED_SPYMASTER = playerToken;
    else if (slotType === 'BLUE_SPYMASTER' && !room.slots.BLUE_SPYMASTER) room.slots.BLUE_SPYMASTER = playerToken;
    else if (slotType === 'RED_LEADER' && !room.slots.RED_LEADER) room.slots.RED_LEADER = playerToken;
    else if (slotType === 'BLUE_LEADER' && !room.slots.BLUE_LEADER) room.slots.BLUE_LEADER = playerToken;
    else if (slotType === 'RED_OPERATIVES' && room.slots.RED_OPERATIVES[index] === null) room.slots.RED_OPERATIVES[index] = playerToken;
    else if (slotType === 'BLUE_OPERATIVES' && room.slots.BLUE_OPERATIVES[index] === null) room.slots.BLUE_OPERATIVES[index] = playerToken;

    io.to(roomId).emit('update_room', room);
  });

  socket.on('toggle_lock_slot', ({ roomId, slotType, index }) => {
    const room = rooms[roomId];
    if (!room || room.gameState.phase !== 'LOBBY') return;
    
    const playerToken = Object.keys(room.players).find(t => room.players[t].socketId === socket.id);
    if (!playerToken || !room.players[playerToken].isHost) return;

    const arr = slotType === 'RED_OPERATIVES' ? room.slots.RED_OPERATIVES : room.slots.BLUE_OPERATIVES;
    if (arr[index] === 'LOCKED') {
      arr[index] = null;
    } else if (!arr[index]) {
      arr[index] = 'LOCKED';
    }
    io.to(roomId).emit('update_room', room);
  });

  socket.on('change_max_players', ({ roomId, maxPlayers }) => {
    const room = rooms[roomId];
    if (!room || room.gameState.phase !== 'LOBBY') return;
    
    const playerToken = Object.keys(room.players).find(t => room.players[t].socketId === socket.id);
    if (!playerToken || !room.players[playerToken].isHost) return;
    
    room.config.maxPlayers = maxPlayers; // config 오브젝트 내 정원 동기화
    const opCount = Math.floor((maxPlayers - 4) / 2);
    
    while(room.slots.RED_OPERATIVES.length < opCount) room.slots.RED_OPERATIVES.push(null);
    while(room.slots.RED_OPERATIVES.length > opCount) room.slots.RED_OPERATIVES.pop();
    while(room.slots.BLUE_OPERATIVES.length < opCount) room.slots.BLUE_OPERATIVES.push(null);
    while(room.slots.BLUE_OPERATIVES.length > opCount) room.slots.BLUE_OPERATIVES.pop();

    io.to(roomId).emit('update_room', room);
  });

  socket.on('change_timer_settings', ({ roomId, clueTimeLimit, guessTimeLimit }) => {
    const room = rooms[roomId];
    if (!room || room.gameState.phase !== 'LOBBY') return;
    
    const playerToken = Object.keys(room.players).find(t => room.players[t].socketId === socket.id);
    if (!playerToken || !room.players[playerToken].isHost) return;

    room.timerSettings = { clueTimeLimit, guessTimeLimit };
    io.to(roomId).emit('update_room', room);
  });

  socket.on('game_start', ({ roomId }) => {
    const room = rooms[roomId];
    if (!room || room.gameState.phase !== 'LOBBY') return;

    const playerToken = Object.keys(room.players).find(t => room.players[t].socketId === socket.id);
    if (!playerToken || !room.players[playerToken].isHost) return;

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
    startTimer(roomId, room.timerSettings.clueTimeLimit);
    io.to(roomId).emit('update_room', room);
  });

  socket.on('submit_clue', ({ roomId, word, count }) => {
    const room = rooms[roomId];
    if (!room || room.gameState.phase !== 'CLUE_WAITING') return;

    room.gameState.phase = 'GUESSING';
    room.gameState.currentClue = { word, count: parseInt(count, 10), guessedCount: 0 };
    
    clearInterval(room.timerInterval);
    startTimer(roomId, room.timerSettings.guessTimeLimit);
    io.to(roomId).emit('update_room', room);
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
    io.to(roomId).emit('update_room', room);
  });

  socket.on('skip_guess', ({ roomId }) => {
    const room = rooms[roomId];
    if (!room || room.gameState.phase !== 'GUESSING') return;
    switchTurn(roomId);
    io.to(roomId).emit('update_room', room);
  });

  socket.on('return_to_lobby', ({ roomId }) => {
    const room = rooms[roomId];
    if (!room) return;

    if (room.timerInterval) clearInterval(room.timerInterval);
    room.gameState = { turn: 'RED', phase: 'LOBBY', currentClue: null, winner: null };
    room.words = [];
    room.timer = 0;

    room.slots.RED_SPYMASTER = null;
    room.slots.BLUE_SPYMASTER = null;
    room.slots.RED_LEADER = null;
    room.slots.BLUE_LEADER = null;
    room.slots.RED_OPERATIVES = room.slots.RED_OPERATIVES.map(v => v === 'LOCKED' ? 'LOCKED' : null);
    room.slots.BLUE_OPERATIVES = room.slots.BLUE_OPERATIVES.map(v => v === 'LOCKED' ? 'LOCKED' : null);

    io.to(roomId).emit('update_room', room);
  });

  socket.on('disconnect', () => {
    for (const roomId in rooms) {
      const room = rooms[roomId];
      // 💡 연결 해제 시 즉시 방에서 지우지 않고 8초간 유예를 두어 새로고침 여유 확보
      const playerToken = Object.keys(room.players).find(t => room.players[t].socketId === socket.id);
      if (playerToken) {
        setTimeout(() => {
          // 8초 뒤 검사했을 때 소켓 ID가 여전히 끊긴 상태 그대로면 진짜 나간 것으로 판정
          if (rooms[roomId] && rooms[roomId].players[playerToken] && rooms[roomId].players[playerToken].socketId === socket.id) {
            const wasHost = room.players[playerToken].isHost;
            delete room.players[playerToken];

            if (room.slots.RED_SPYMASTER === playerToken) room.slots.RED_SPYMASTER = null;
            if (room.slots.BLUE_SPYMASTER === playerToken) room.slots.BLUE_SPYMASTER = null;
            if (room.slots.RED_LEADER === playerToken) room.slots.RED_LEADER = null;
            if (room.slots.BLUE_LEADER === playerToken) room.slots.BLUE_LEADER = null;
            room.slots.RED_OPERATIVES = room.slots.RED_OPERATIVES.map(v => v === playerToken ? null : v);
            room.slots.BLUE_OPERATIVES = room.slots.BLUE_OPERATIVES.map(v => v === playerToken ? null : v);

            if (Object.keys(room.players).length === 0) {
              if (room.timerInterval) clearInterval(room.timerInterval);
              delete rooms[roomId];
            } else if (wasHost) {
              const nextHostToken = Object.keys(room.players)[0];
              room.players[nextHostToken].isHost = true;
              io.to(roomId).emit('update_room', room);
            } else {
              io.to(roomId).emit('update_room', room);
            }
          }
        }, 8000);
        break;
      }
    }
  });
});

function startTimer(roomId, duration) {
  const room = rooms[roomId];
  if (!room) return;
  
  room.timer = duration;
  io.to(roomId).emit('timer_update', { timer: room.timer });

  room.timerInterval = setInterval(() => {
    room.timer -= 1;
    io.to(roomId).emit('timer_update', { timer: room.timer });

    if (room.timer <= 0) {
      clearInterval(room.timerInterval);
      switchTurn(roomId);
      io.to(roomId).emit('update_room', room);
    }
  }, 1000);
}

function switchTurn(roomId) {
  const room = rooms[roomId];
  if (!room) return;
  clearInterval(room.timerInterval);
  
  room.gameState.turn = room.gameState.turn === 'RED' ? 'BLUE' : 'RED';
  room.gameState.phase = 'CLUE_WAITING';
  room.gameState.currentClue = null;
  
  startTimer(roomId, room.timerSettings.clueTimeLimit);
}

function endGame(roomId, winner) {
  const room = rooms[roomId];
  if (!room) return;
  clearInterval(room.timerInterval);
  room.gameState.phase = 'ENDED';
  room.gameState.winner = winner;
}

const PORT = process.env.PORT || 4000;
server.listen(PORT, '0.0.0.0', () => console.log(`코어 서버 오픈포트: ${PORT}`));