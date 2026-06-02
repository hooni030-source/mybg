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

io.on('connection', (socket) => {
  
  socket.on('request_reconnect', ({ roomId, userToken }) => {
    const targetRoomId = roomId ? roomId.toUpperCase() : null;
    const room = rooms[targetRoomId];
    
    if (room && room.players[userToken]) {
      room.players[userToken].socketId = socket.id;
      socket.join(targetRoomId);
      socket.emit('room_joined', { roomId: targetRoomId, myId: userToken, userToken });
      io.to(targetRoomId).emit('update_room', room);
    } else {
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
        config: { maxPlayers: 8 }, 
        words: [],
        gameState: { turn: 'RED', phase: 'LOBBY', currentClue: null, winner: null },
        timerSettings: { clueTimeLimit: 60, guessTimeLimit: 90 },
        timer: 0,
        timerInterval: null
      };
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
    io.to(targetRoomId).emit('update_room', room);
  });

  socket.on('select_slot', ({ roomId, slotType, index }) => {
    const room = rooms[roomId];
    if (!room || room.gameState.phase !== 'LOBBY') return;

    const playerToken = Object.keys(room.players).find(t => room.players[t].socketId === socket.id);
    if (!playerToken) return;

    // 슬롯 대청소
    if (room.slots.RED_SPYMASTER === playerToken) room.slots.RED_SPYMASTER = null;
    if (room.slots.BLUE_SPYMASTER === playerToken) room.slots.BLUE_SPYMASTER = null;
    if (room.slots.RED_LEADER === playerToken) room.slots.RED_LEADER = null;
    if (room.slots.BLUE_LEADER === playerToken) room.slots.BLUE_LEADER = null;
    if (room.slots.RED_OPERATIVES) room.slots.RED_OPERATIVES = room.slots.RED_OPERATIVES.map(v => v === playerToken ? null : v);
    if (room.slots.BLUE_OPERATIVES) room.slots.BLUE_OPERATIVES = room.slots.BLUE_OPERATIVES.map(v => v === playerToken ? null : v);

    // SPECTATOR 지광 이동이 아니면 새 슬롯 정착
    if (slotType !== 'SPECTATOR') {
      if (slotType === 'RED_SPYMASTER' && !room.slots.RED_SPYMASTER) room.slots.RED_SPYMASTER = playerToken;
      else if (slotType === 'BLUE_SPYMASTER' && !room.slots.BLUE_SPYMASTER) room.slots.BLUE_SPYMASTER = playerToken;
      else if (slotType === 'RED_LEADER' && !room.slots.RED_LEADER) room.slots.RED_LEADER = playerToken;
      else if (slotType === 'BLUE_LEADER' && !room.slots.BLUE_LEADER) room.slots.BLUE_LEADER = playerToken;
      else if (slotType === 'RED_OPERATIVES' && room.slots.RED_OPERATIVES[index] === null) room.slots.RED_OPERATIVES[index] = playerToken;
      else if (slotType === 'BLUE_OPERATIVES' && room.slots.BLUE_OPERATIVES[index] === null) room.slots.BLUE_OPERATIVES[index] = playerToken;
    }

    io.to(roomId).emit('update_room', room);
  });

  socket.on('toggle_lock_slot', ({ roomId, slotType, index }) => {
    const room = rooms[roomId];
    if (!room || room.gameState.phase !== 'LOBBY') return;
    
    const playerToken = Object.keys(room.players).find(t => room.players[t].socketId === socket.id);
    if (!playerToken || !room.players[playerToken].isHost) return;

    const arr = slotType === 'RED_OPERATIVES' ? room.slots.RED_OPERATIVES : room.slots.BLUE_OPERATIVES;
    if (arr[index] === 'LOCKED') { arr[index] = null; } 
    else if (!arr[index]) { arr[index] = 'LOCKED'; }
    io.to(roomId).emit('update_room', room);
  });

  socket.on('change_max_players', ({ roomId, maxPlayers }) => {
    const room = rooms[roomId];
    if (!room || room.gameState.phase !== 'LOBBY') return;
    
    const playerToken = Object.keys(room.players).find(t => room.players[t].socketId === socket.id);
    if (!playerToken || !room.players[playerToken].isHost) return;
    
    room.config.maxPlayers = maxPlayers;
    const opCount = Math.floor((maxPlayers - 4) / 2);
    
    // 4인 모드면 알아서 빈 배열로 청소됨
    if (!room.slots.RED_OPERATIVES) room.slots.RED_OPERATIVES = [];
    if (!room.slots.BLUE_OPERATIVES) room.slots.BLUE_OPERATIVES = [];

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

    // 💡 억까 락 해제: 매판 완벽하게 25개 카드를 재생성하여 인게임 브로드캐스팅 개시
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
    
    if (room.timerInterval) clearInterval(room.timerInterval);
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
    if (room.slots.RED_OPERATIVES) room.slots.RED_OPERATIVES = room.slots.RED_OPERATIVES.map(v => v === 'LOCKED' ? 'LOCKED' : null);
    if (room.slots.BLUE_OPERATIVES) room.slots.BLUE_OPERATIVES = room.slots.BLUE_OPERATIVES.map(v => v === 'LOCKED' ? 'LOCKED' : null);

    io.to(roomId).emit('update_room', room);
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

            if (Object.keys(room.players).length === 0) {
              if (room.timerInterval) clearInterval(room.timerInterval);
              delete rooms[roomId];
            } else if (wasHost) {
              const nextHostToken = Object.keys(room.players)[0];
              if (nextHostToken) room.players[nextHostToken].isHost = true;
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