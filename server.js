const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

let wordDictionary = {};
let categoryDecks = {};

function shuffleArray(array) {
  const arr = [...array];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function loadDictionary() {
  try {
    const rawData = fs.readFileSync(path.join(__dirname, 'words.json'), 'utf-8');
    wordDictionary = JSON.parse(rawData);
  } catch (error) {
    console.error('Error reading words.json file:', error);
    wordDictionary = {
      "General": {
        "Easy": ["APPLE", "BEACH", "CASTLE"],
        "Medium": ["DRAGON", "FOREST", "PLANET"],
        "Hard": ["ROCKET", "PENGUIN", "ASTRONAUT"]
      }
    };
  }

  for (const cat in wordDictionary) {
    for (const diff in wordDictionary[cat]) {
      const key = `${cat}|${diff}`;
      categoryDecks[key] = shuffleArray(wordDictionary[cat][diff]);
    }
  }
}

loadDictionary();

function drawNextWord(category, difficulty) {
  const key = `${category}|${difficulty}`;
  if (!categoryDecks[key] || categoryDecks[key].length === 0) {
    const pool = (wordDictionary[category] && wordDictionary[category][difficulty]) || ["MYSTERY"];
    categoryDecks[key] = shuffleArray(pool);
  }
  return categoryDecks[key].pop();
}

function getFourRandomCategoryOptions() {
  const categories = Object.keys(wordDictionary);
  const shuffledCats = shuffleArray(categories);
  const selectedCats = shuffledCats.slice(0, 4);

  const difficulties = ["Easy", "Medium", "Hard"];

  return selectedCats.map(cat => {
    const randomDiff = difficulties[Math.floor(Math.random() * difficulties.length)];
    return {
      category: cat,
      difficulty: randomDiff
    };
  });
}

let rooms = {};

function serializeRoomForSocket(room, targetSocketId) {
  const guesser = room.players[room.guesserIndex];
  
  let roomCopy = {
    ...room,
    usedWords: Array.from(room.usedWords || [])
  };

  if (room.state === 'reviewing-clues' && targetSocketId === guesser?.id) {
    roomCopy.clues = {};
  }

  return roomCopy;
}

function broadcastRoomUpdate(roomCode) {
  let room = rooms[roomCode];
  if (!room) return;

  let socketsInRoom = io.sockets.adapter.rooms.get(roomCode);
  if (socketsInRoom) {
    for (let sId of socketsInRoom) {
      let clientSocket = io.sockets.sockets.get(sId);
      if (clientSocket) {
        clientSocket.emit('update-room', serializeRoomForSocket(room, sId));
      }
    }
  }
}

function startCategorySelectionPhase(room, roomCode) {
  room.state = 'selecting-category';
  room.categoryChoices = getFourRandomCategoryOptions();
  room.selectedCategory = '';
  room.selectedDifficulty = '';
  room.targetWord = '';
  room.clues = {};
  room.guess = '';
  broadcastRoomUpdate(roomCode);
}

io.on('connection', (socket) => {

  socket.on('create-room', ({ playerName }) => {
    let cleanName = (playerName || '').trim();
    if (!cleanName) return socket.emit('error-msg', 'Please enter a valid name.');

    const roomCode = Math.random().toString(36).substring(2, 6).toUpperCase();
    rooms[roomCode] = {
      hostId: socket.id,
      players: [{ id: socket.id, name: cleanName, score: 0 }],
      state: 'lobby',
      guesserIndex: 0,
      moderatorIndex: 1,
      categoryChoices: [],
      selectedCategory: '',
      selectedDifficulty: '',
      targetWord: '',
      clues: {},
      guess: '',
      usedWords: new Set()
    };

    socket.join(roomCode);
    socket.emit('room-joined', { roomCode, isHost: true, room: serializeRoomForSocket(rooms[roomCode], socket.id) });
    broadcastRoomUpdate(roomCode);
  });

  socket.on('join-room', ({ roomCode, playerName }) => {
    if (!roomCode) return socket.emit('error-msg', 'Room code is required.');
    roomCode = roomCode.toUpperCase().trim();
    let room = rooms[roomCode];

    if (!room) return socket.emit('error-msg', 'Room not found!');
    if (room.state !== 'lobby') return socket.emit('error-msg', 'Game already in progress!');

    let cleanName = (playerName || '').trim();
    if (!cleanName) return socket.emit('error-msg', 'Please enter a valid name.');

    let isNameTaken = room.players.some(
      p => p.name.trim().toLowerCase() === cleanName.toLowerCase()
    );

    if (isNameTaken) {
      return socket.emit('error-msg', `The name "${cleanName}" is already taken in this room.`);
    }

    room.players.push({ id: socket.id, name: cleanName, score: 0 });
    socket.join(roomCode);
    
    socket.emit('room-joined', { roomCode, isHost: false, room: serializeRoomForSocket(room, socket.id) });
    broadcastRoomUpdate(roomCode);
  });

  socket.on('start-game', ({ roomCode }) => {
    let room = rooms[roomCode];
    if (!room) return socket.emit('error-msg', 'Room no longer exists.');

    if (room.hostId !== socket.id) {
      return socket.emit('error-msg', 'Only the host can start the game.');
    }

    if (room.players.length < 3) {
      return socket.emit('error-msg', `Need at least 3 players to start! Currently connected: ${room.players.length}`);
    }

    room.guesserIndex = 0;
    room.moderatorIndex = 1 % room.players.length;
    startCategorySelectionPhase(room, roomCode);
  });

  socket.on('select-category', ({ roomCode, category, difficulty }) => {
    let room = rooms[roomCode];
    if (!room || room.state !== 'selecting-category') return;

    let moderatorId = room.players[room.moderatorIndex].id;
    if (socket.id !== moderatorId) return;

    room.selectedCategory = category;
    room.selectedDifficulty = difficulty;
    room.targetWord = drawNextWord(category, difficulty);
    room.state = 'submitting-clues';
    broadcastRoomUpdate(roomCode);
  });

  // Moderator Skip Word Handler
  socket.on('skip-word', ({ roomCode }) => {
    let room = rooms[roomCode];
    if (!room || room.state !== 'submitting-clues') return;

    let moderatorId = room.players[room.moderatorIndex].id;
    if (socket.id !== moderatorId) return;

    // Draw a new word in same category & difficulty
    room.targetWord = drawNextWord(room.selectedCategory, room.selectedDifficulty);
    room.clues = {}; // Reset any clues submitted for the old word
    broadcastRoomUpdate(roomCode);
  });

  socket.on('submit-clue', ({ roomCode, clueText }) => {
    let room = rooms[roomCode];
    if (!room || room.state !== 'submitting-clues') return;

    let guesserId = room.players[room.guesserIndex].id;
    if (socket.id === guesserId) return;

    let cleanClue = (clueText || '').trim().toUpperCase();
    if (!cleanClue) return;

    let player = room.players.find(p => p.id === socket.id);

    room.clues[socket.id] = {
      playerId: socket.id,
      playerName: player ? player.name : 'Unknown',
      clue: cleanClue,
      valid: true
    };

    let totalClueGivers = room.players.length - 1;
    if (Object.keys(room.clues).length >= totalClueGivers) {
      room.state = 'reviewing-clues';
    }

    broadcastRoomUpdate(roomCode);
  });

  socket.on('toggle-clue-validity', ({ roomCode, targetPlayerId }) => {
    let room = rooms[roomCode];
    if (!room || room.state !== 'reviewing-clues') return;
    
    let moderatorId = room.players[room.moderatorIndex].id;
    if (socket.id !== moderatorId) return;

    if (room.clues[targetPlayerId]) {
      room.clues[targetPlayerId].valid = !room.clues[targetPlayerId].valid;
    }

    broadcastRoomUpdate(roomCode);
  });

  socket.on('approve-clues', ({ roomCode }) => {
    let room = rooms[roomCode];
    if (!room || room.state !== 'reviewing-clues') return;

    let moderatorId = room.players[room.moderatorIndex].id;
    if (socket.id !== moderatorId) return;

    room.state = 'guessing';
    broadcastRoomUpdate(roomCode);
  });

  socket.on('submit-guess', ({ roomCode, guessText }) => {
    let room = rooms[roomCode];
    if (!room || room.state !== 'guessing') return;

    let guesserId = room.players[room.guesserIndex].id;
    if (socket.id !== guesserId) return;

    let cleanGuess = (guessText || '').trim().toUpperCase();
    room.guess = cleanGuess;
    let isCorrect = cleanGuess === room.targetWord;

    if (isCorrect) {
      let pts = 1;
      if (room.selectedDifficulty === 'Medium') pts = 2;
      if (room.selectedDifficulty === 'Hard') pts = 3;
      
      room.players.forEach(p => p.score += pts);
    }

    room.state = 'round-over';
    broadcastRoomUpdate(roomCode);
  });

  socket.on('next-round', ({ roomCode }) => {
    let room = rooms[roomCode];
    if (!room || room.state !== 'round-over') return;

    room.guesserIndex = (room.guesserIndex + 1) % room.players.length;
    room.moderatorIndex = (room.guesserIndex + 1) % room.players.length;

    startCategorySelectionPhase(room, roomCode);
  });

  socket.on('disconnect', () => {
    for (let roomCode in rooms) {
      let room = rooms[roomCode];
      let pIndex = room.players.findIndex(p => p.id === socket.id);
      
      if (pIndex !== -1) {
        room.players.splice(pIndex, 1);

        if (room.players.length === 0) {
          delete rooms[roomCode];
        } else {
          if (room.hostId === socket.id) {
            room.hostId = room.players[0].id;
          }
          room.guesserIndex = room.guesserIndex % room.players.length;
          room.moderatorIndex = room.moderatorIndex % room.players.length;
          
          broadcastRoomUpdate(roomCode);
        }
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
