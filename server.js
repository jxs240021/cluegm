const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// Load external dictionary
let wordDictionary = [];
try {
  const rawData = fs.readFileSync(path.join(__dirname, 'words.json'), 'utf-8');
  wordDictionary = JSON.parse(rawData);
} catch (error) {
  console.error('Error reading words.json file:', error);
  // Fallback word list
  wordDictionary = ["APPLE", "BEACH", "CASTLE", "DRAGON", "FOREST", "PLANET"];
}

let rooms = {};

function getRandomWord(usedWordsSet) {
  let available = wordDictionary.filter(w => !usedWordsSet.has(w));
  if (available.length === 0) {
    usedWordsSet.clear();
    available = wordDictionary;
  }
  let word = available[Math.floor(Math.random() * available.length)];
  usedWordsSet.add(word);
  return word;
}

function serializeRoom(room) {
  return {
    ...room,
    usedWords: Array.from(room.usedWords || [])
  };
}

function startNewRound(room, roomCode) {
  room.state = 'submitting-clues';
  room.targetWord = getRandomWord(room.usedWords);
  room.clues = {};
  room.guess = '';
  io.to(roomCode).emit('update-room', serializeRoom(room));
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
      targetWord: '',
      clues: {},
      guess: '',
      usedWords: new Set()
    };

    socket.join(roomCode);
    socket.emit('room-joined', { roomCode, isHost: true, room: serializeRoom(rooms[roomCode]) });
    io.to(roomCode).emit('update-room', serializeRoom(rooms[roomCode]));
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

    // Duplicate name validation (case-insensitive)
    let isNameTaken = room.players.some(
      p => p.name.trim().toLowerCase() === cleanName.toLowerCase()
    );

    if (isNameTaken) {
      return socket.emit('error-msg', `The name "${cleanName}" is already taken in this room. Please choose another!`);
    }

    room.players.push({ id: socket.id, name: cleanName, score: 0 });
    socket.join(roomCode);
    
    socket.emit('room-joined', { roomCode, isHost: false, room: serializeRoom(room) });
    io.to(roomCode).emit('update-room', serializeRoom(room));
  });

  // Start Game
  socket.on('start-game', ({ roomCode }) => {
    let room = rooms[roomCode];
    if (!room) return socket.emit('error-msg', 'Room no longer exists.');

    // Ensure user requesting start is actual host
    if (room.hostId !== socket.id) {
      return socket.emit('error-msg', 'Only the host can start the game.');
    }

    if (room.players.length < 3) {
      return socket.emit('error-msg', `Need at least 3 players to start! Currently connected: ${room.players.length}`);
    }

    room.guesserIndex = 0;
    room.moderatorIndex = 1 % room.players.length;
    startNewRound(room, roomCode);
  });

  // Submit Clue
  socket.on('submit-clue', ({ roomCode, clueText }) => {
    let room = rooms[roomCode];
    if (!room || room.state !== 'submitting-clues') return;

    let guesserId = room.players[room.guesserIndex].id;
    if (socket.id === guesserId) return; // Guesser cannot give clues

    let cleanClue = (clueText || '').trim().toUpperCase();
    if (!cleanClue) return;

    let player = room.players.find(p => p.id === socket.id);

    room.clues[socket.id] = {
      playerId: socket.id,
      playerName: player ? player.name : 'Unknown',
      clue: cleanClue,
      valid: true
    };

    // Auto-advance to review once all non-guessers submit clues
    let totalClueGivers = room.players.length - 1;
    if (Object.keys(room.clues).length >= totalClueGivers) {
      room.state = 'reviewing-clues';
    }

    io.to(roomCode).emit('update-room', serializeRoom(room));
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

    io.to(roomCode).emit('update-room', serializeRoom(room));
  });

  // Moderator Approve Clues
  socket.on('approve-clues', ({ roomCode }) => {
    let room = rooms[roomCode];
    if (!room || room.state !== 'reviewing-clues') return;

    let moderatorId = room.players[room.moderatorIndex].id;
    if (socket.id !== moderatorId) return;

    room.state = 'guessing';
    io.to(roomCode).emit('update-room', serializeRoom(room));
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
    io.to(roomCode).emit('update-room', serializeRoom(room));
  });

  // Next Round
  socket.on('next-round', ({ roomCode }) => {
    let room = rooms[roomCode];
    if (!room || room.state !== 'round-over') return;

    // Rotate Guesser and Moderator
    room.guesserIndex = (room.guesserIndex + 1) % room.players.length;
    room.moderatorIndex = (room.guesserIndex + 1) % room.players.length;

    startNewRound(room, roomCode);
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
          // Reassign host if host left
          if (room.hostId === socket.id) {
            room.hostId = room.players[0].id;
          }
          // Reset indices bounds
          room.guesserIndex = room.guesserIndex % room.players.length;
          room.moderatorIndex = room.moderatorIndex % room.players.length;
          
          io.to(roomCode).emit('update-room', serializeRoom(room));
        }
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
