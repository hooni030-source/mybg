const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { CODENAMES_WORDS_1000 } = require('./data/words');

const app = express();
app.use(express.static('public'));

const server = http.createServer(app);
const io = new Server(server, { 
  cors: { origin: "*", methods: ["GET", "POST"], credentials: true },
  transports: ['websocket', 'polling'] 
});

const rooms = {};

// 💡 [피드백 5 반영] 오직 영어 대문자 4자리로만 방 코드가 생성되도록 빌드
function generateRoomId() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  let result = '';
  for (let i = 0; i < 4; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

// Fisher-Yates 셔플 알고리즘 기반 단어 다각화 무작위 추출기
function getRandomWords(count) {
  const shuffled = [...CODENAMES_WORDS_1000];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled.slice(0, count);
}

io.on('connection', (socket) => {
  
  socket.on('join_room', ({ roomId, nickname }) => {
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
        maxPlayers: 8,
        words: [],
        gameState: { turn: 'RED', phase: 'LOBBY', currentClue: null, winner: null },
        timerSettings: { clueTimeLimit: 60, guessTimeLimit: 90 },
        timer: 0,
        timerInterval: null
      };
    }

    const room = rooms[targetRoomId];
    const isHost = Object.keys(room.players).length === 0;
    
    room.players[socket.id] = { id: socket.id, nickname, isHost };
    socket.join(targetRoomId);
    
    socket.emit('room_joined', { roomId: targetRoomId, myId: socket.id });
    io.to(targetRoomId).emit('update_room', room);
  });

  socket.on('select_slot', ({ roomId, slotType, index }) => {
    const room = rooms[roomId];
    if (!room || room.gameState.phase !== 'LOBBY') return;

    // 기존 슬롯 청소
    if (room.slots.RED_SPYMASTER === socket.id) room.slots.RED_SPYMASTER = null;
    if (room.slots.BLUE_SPYMASTER === socket.id) room.slots.BLUE_SPYMASTER = null;
    if (room.slots.RED_LEADER === socket.id) room.slots.RED_LEADER = null;
    if (room.slots.BLUE_LEADER === socket.id) room.slots.BLUE_LEADER = null;
    room.slots.RED_OPERATIVES = room.slots.RED_OPERATIVES.filter(id => id !== socket.id);
    room.slots.BLUE_OPERATIVES = room.slots.BLUE_OPERATIVES.filter(id => id !== socket.id);

    // 새 슬롯 배치
    if (slotType === 'RED_SPYMASTER' && !room.slots.RED_SPYMASTER) room.slots.RED_SPYMASTER = socket.id;
    else if (slotType === 'BLUE_SPYMASTER' && !room.slots.BLUE_SPYMASTER) room.slots.BLUE_SPYMASTER = socket.id;
    else if (slotType === 'RED_LEADER' && !room.slots.RED_LEADER) room.slots.RED_LEADER = socket.id;
    else if (slotType === 'BLUE_LEADER' && !room.slots.BLUE_LEADER) room.slots.BLUE_LEADER = socket.id;
    else if (slotType === 'RED_OPERATIVES') {
      if (room.slots.RED_OPERATIVES[index] === null || room.slots.RED_OPERATIVES[index] === undefined) {
        room.slots.RED_OPERATIVES[index] = socket.id;
      }
    } else if (slotType === 'BLUE_OPERATIVES') {
      if (room.slots.BLUE_OPERATIVES[index] === null || room.slots.BLUE_OPERATIVES[index] === undefined) {
        room.slots.BLUE_OPERATIVES[index] = socket.id;
      }
    }

    io.to(roomId).emit('update_room', room);
  });

  socket.on('toggle_lock_slot', ({ roomId, slotType, index }) => {
    const room = rooms[roomId];
    if (!room || !room.players[socket.id]?.isHost || room.gameState.phase !== 'LOBBY') return;

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
    if (!room || !room.players[socket.id]?.isHost || room.gameState.phase !== 'LOBBY') return;
    
    room.maxPlayers = maxPlayers;
    const opCount = Math.floor((maxPlayers - 4) / 2);
    
    while(room.slots.RED_OPERATIVES.length < opCount) room.slots.RED_OPERATIVES.push(null);
    while(room.slots.RED_OPERATIVES.length > opCount) room.slots.RED_OPERATIVES.pop();
    while(room.slots.BLUE_OPERATIVES.length < opCount) room.slots.BLUE_OPERATIVES.push(null);
    while(room.slots.BLUE_OPERATIVES.length > opCount) room.slots.BLUE_OPERATIVES.pop();

    io.to(roomId).emit('update_room', room);
  });

  socket.on('change_timer_settings', ({ roomId, clueTimeLimit, guessTimeLimit }) => {
    const room = rooms[roomId];
    if (!room || !room.players[socket.id]?.isHost || room.gameState.phase !== 'LOBBY') return;
    room.timerSettings = { clueTimeLimit, guessTimeLimit };
    io.to(roomId).emit('update_room', room);
  });

  socket.on('game_start', ({ roomId }) => {
    const room = rooms[roomId];
    if (!room || !room.players[socket.id]?.isHost || room.gameState.phase !== 'LOBBY') return;

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

  // 💡 [피드백 2 반영] 한판하고 방 깨지 않고 멤버 역할 초기화 후 로비 복귀 백엔드 파이프라인
  socket.on('return_to_lobby', ({ roomId }) => {
    const room = rooms[roomId];
    if (!room) return;

    // 타이머 인터벌 클리어 및 상태 백투랍 상태로 롤백
    if (room.timerInterval) clearInterval(room.timerInterval);
    room.gameState = { turn: 'RED', phase: 'LOBBY', currentClue: null, winner: null };
    room.words = [];
    room.timer = 0;

    // 💡 다음 판 멤버 순환 연출을 위해 locked 슬롯을 빼고 전원 관전자로 초기화(null 바인딩)
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
      if (room.players[socket.id]) {
        const wasHost = room.players[socket.id].isHost;
        delete room.players[socket.id];

        if (room.slots.RED_SPYMASTER === socket.id) room.slots.RED_SPYMASTER = null;
        if (room.slots.BLUE_SPYMASTER === socket.id) room.slots.BLUE_SPYMASTER = null;
        if (room.slots.RED_LEADER === socket.id) room.slots.RED_LEADER = null;
        if (room.slots.BLUE_LEADER === socket.id) room.slots.BLUE_LEADER = null;
        room.slots.RED_OPERATIVES = room.slots.RED_OPERATIVES.map(v => v === socket.id ? null : v);
        room.slots.BLUE_OPERATIVES = room.slots.BLUE_OPERATIVES.map(v => v === socket.id ? null : v);

        if (Object.keys(room.players).length === 0) {
          if (room.timerInterval) clearInterval(room.timerInterval);
          delete rooms[roomId];
        } else if (wasHost) {
          const nextHostId = Object.keys(room.players)[0];
          room.players[nextHostId].isHost = true;
          io.to(roomId).emit('update_room', room);
        } else {
          io.to(roomId).emit('update_room', room);
        }
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
      if (room.gameState.phase === 'CLUE_WAITING') {
        switchTurn(roomId);
      } else if (room.gameState.phase === 'GUESSING') {
        switchTurn(roomId);
      }
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