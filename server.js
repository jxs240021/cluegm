const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// Categorized Word Dictionary & Shuffled Decks
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
      "General": ["APPLE", "BEACH", "CASTLE", "DRAGON", "FOREST", "PLANET", "ROCKET", "PENGUIN"]
    };
  }

  // Initialize shuffled decks for each category
  for (const cat in wordDictionary) {
    categoryDecks[cat] = shuffleArray(wordDictionary[cat]);
  }
}

loadDictionary();

function drawNextWordFromCategory(category) {
  if (!categoryDecks[category] || categoryDecks[category].length === 0) {
    // Re-shuffle deck when depleted
    categoryDecks[category] = shuffleArray(wordDictionary[category] || ["MYSTERY"]);
  }
  return categoryDecks[category].pop();
}

function getThreeRandomCategories() {
  const categories = Object.keys(wordDictionary);
  const shuffled = shuffleArray(categories);
  return shuffled.slice(0, 3);
}

let rooms = {};

function serializeRoomForSocket(room, targetSocketId) {
  const guesser = room.players[room.guesserIndex];
  
  let roomCopy = {
    ...room,
    usedWords: Array.from(room.usedWords || [])
  };

  // Strip clues from guesser during review phase
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
  room.categoryChoices = getThreeRandomCategories();
  room.selectedCategory = '';
  room.targetWord = '';
  room.clues = {};
  room.guess = '';
  broadcastRoomUpdate(roomCode);
}

io.on('connection', (socket) => {

  // Create Room
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
      targetWord: '',
      clues: {},
      guess: '',
      usedWords: new Set()
    };

    socket.join(roomCode);
    socket.emit('room-joined', { roomCode, isHost: true, room: serializeRoomForSocket(rooms[roomCode], socket.id) });
    broadcastRoomUpdate(roomCode);
  });

  // Join Room
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
      return socket.emit('error-msg', `The name "${cleanName}" is already taken in this room. Please choose another!`);
    }

    room.players.push({ id: socket.id, name: cleanName, score: 0 });
    socket.join(roomCode);
    
    socket.emit('room-joined', { roomCode, isHost: false, room: serializeRoomForSocket(room, socket.id) });
    broadcastRoomUpdate(roomCode);
  });

  // Start Game
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

  // Moderator Chooses Category
  socket.on('select-category', ({ roomCode, category }) => {
    let room = rooms[roomCode];
    if (!room || room.state !== 'selecting-category') return;

    let moderatorId = room.players[room.moderatorIndex].id;
    if (socket.id !== moderatorId) return;

    room.selectedCategory = category;
    room.targetWord = drawNextWordFromCategory(category);
    room.state = 'submitting-clues';
    broadcastRoomUpdate(roomCode);
  });

  // Submit Clue
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

  // Moderator Toggle Clue Validity
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

  // Moderator Approve Clues
  socket.on('approve-clues', ({ roomCode }) => {
    let room = rooms[roomCode];
    if (!room || room.state !== 'reviewing-clues') return;

    let moderatorId = room.players[room.moderatorIndex].id;
    if (socket.id !== moderatorId) return;

    room.state = 'guessing';
    broadcastRoomUpdate(roomCode);
  });

  // Guesser Submit Guess
  socket.on('submit-guess', ({ roomCode, guessText }) => {
    let room = rooms[roomCode];
    if (!room || room.state !== 'guessing') return;

    let guesserId = room.players[room.guesserIndex].id;
    if (socket.id !== guesserId) return;

    let cleanGuess = (guessText || '').trim().toUpperCase();
    room.guess = cleanGuess;
    let isCorrect = cleanGuess === room.targetWord;

    if (isCorrect) {
      room.players.forEach(p => p.score += 1);
    }

    room.state = 'round-over';
    broadcastRoomUpdate(roomCode);
  });

  // Next Round
  socket.on('next-round', ({ roomCode }) => {
    let room = rooms[roomCode];
    if (!room || room.state !== 'round-over') return;

    room.guesserIndex = (room.guesserIndex + 1) % room.players.length;
    room.moderatorIndex = (room.guesserIndex + 1) % room.players.length;

    startCategorySelectionPhase(room, roomCode);
  });

  // Handle Disconnections
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
