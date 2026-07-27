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
}

let rooms = {};

function getRandomWord(usedWordsSet) {
  let available = wordDictionary.filter(w => !usedWordsSet.has(w));
  if (available.length === 0) available = wordDictionary; // reset if empty
  let word = available[Math.floor(Math.random() * available.length)];
  usedWordsSet.add(word);
  return word;
}

io.on('connection', (socket) => {
  // Create Room
  socket.on('create-room', ({ playerName }) => {
    const roomCode = Math.random().toString(36).substring(2, 6).toUpperCase();
    rooms[roomCode] = {
      hostId: socket.id,
      players: [{ id: socket.id, name: playerName, score: 0 }],
      state: 'lobby', // lobby, submitting-clues, reviewing-clues, guessing, round-over
      guesserIndex: 0,
      moderatorIndex: 1,
      targetWord: '',
      clues: {}, // socketId -> { player: name, clue: string, valid: boolean }
      guess: '',
      usedWords: new Set()
    };

    socket.join(roomCode);
    socket.emit('room-joined', { roomCode, isHost: true, room: serializeRoom(rooms[roomCode]) });
  });

  // Join Room
  socket.on('join-room', ({ roomCode, playerName }) => {
    if (!roomCode) return;
    roomCode = roomCode.toUpperCase();
    let room = rooms[roomCode];

    if (!room) return socket.emit('error-msg', 'Room not found!');
    if (room.state !== 'lobby') return socket.emit('error-msg', 'Game already in progress!');

    room.players.push({ id: socket.id, name: playerName, score: 0 });
    socket.join(roomCode);
    io.to(roomCode).emit('update-room', serializeRoom(room));
    socket.emit('room-joined', { roomCode, isHost: false, room: serializeRoom(room) });
  });

  // Start Game
  socket.on('start-game', ({ roomCode }) => {
    let room = rooms[roomCode];
    if (!room || room.hostId !== socket.id || room.state !== 'lobby') return;
    if (room.players.length < 3) {
      return socket.emit('error-msg', 'Need at least 3 players (1 Guesser, 1 Moderator, 1+ Clue Provider)!');
    }

    room.guesserIndex = 0;
    room.moderatorIndex = 1 % room.players.length;
    startNewRound(room, roomCode);
  });

  // Submit Clue (From Moderator or Clue Provider)
  socket.on('submit-clue', ({ roomCode, clueText }) => {
    let room = rooms[roomCode];
    if (!room || room.state !== 'submitting-clues') return;

    let guesserId = room.players[room.guesserIndex].id;
    if (socket.id === guesserId) return; // Guesser cannot give clues

    let cleanClue = clueText.trim().toUpperCase();
    let player = room.players.find(p => p.id === socket.id);

    room.clues[socket.id] = {
      playerId: socket.id,
      playerName: player.name,
      clue: cleanClue,
      valid: true // Default to valid until moderator reviews
    };

    // Check if all non-guesser players submitted clues
    let totalClueGivers = room.players.length - 1;
    if (Object.keys(room.clues).length === totalClueGivers) {
      room.state = 'reviewing-clues';
    }

    io.to(roomCode).emit('update-room', serializeRoom(room));
  });

  // Moderator Toggles Clue Validity
  socket.on('toggle-clue-validity', ({ roomCode, targetPlayerId }) => {
    let room = rooms[roomCode];
    let moderatorId = room.players[room.moderatorIndex].id;
    if (!room || room.state !== 'reviewing-clues' || socket.id !== moderatorId) return;

    if (room.clues[targetPlayerId]) {
      room.clues[targetPlayerId].valid = !room.clues[targetPlayerId].valid;
    }

    io.to(roomCode).emit('update-room', serializeRoom(room));
  });

  // Moderator Submits Final Reviewed Clues
  socket.on('approve-clues', ({ roomCode }) => {
    let room = rooms[roomCode];
    let moderatorId = room.players[room.moderatorIndex].id;
    if (!room || room.state !== 'reviewing-clues' || socket.id !== moderatorId) return;

    room.state = 'guessing';
    io.to(roomCode).emit('update-room', serializeRoom(room));
  });

  // Guesser Submits Guess
  socket.on('submit-guess', ({ roomCode, guessText }) => {
    let room = rooms[roomCode];
    let guesserId = room.players[room.guesserIndex].id;
    if (!room || room.state !== 'guessing' || socket.id !== guesserId) return;

    let cleanGuess = guessText.trim().toUpperCase();
    room.guess = cleanGuess;
    let isCorrect = cleanGuess === room.targetWord;

    if (isCorrect) {
      // Award 1 point to all cooperative players
      room.players.forEach(p => p.score += 1);
    }

    room.state = 'round-over';
    io.to(roomCode).emit('update-room', serializeRoom(room));
  });

  // Next Round Trigger
  socket.on('next-round', ({ roomCode }) => {
    let room = rooms[roomCode];
    if (!room || room.state !== 'round-over') return;

    // Rotate Guesser and Moderator roles
    room.guesserIndex = (room.guesserIndex + 1) % room.players.length;
    room.moderatorIndex = (room.guesserIndex + 1) % room.players.length;

    startNewRound(room, roomCode);
  });

  socket.on('disconnect', () => {
    for (let roomCode in rooms) {
      let room = rooms[roomCode];
      room.players = room.players.filter(p => p.id !== socket.id);
      if (room.players.length === 0) {
        delete rooms[roomCode];
      } else {
        io.to(roomCode).emit('update-room', serializeRoom(room));
      }
    }
  });
});

function startNewRound(room, roomCode) {
  room.state = 'submitting-clues';
  room.targetWord = getRandomWord(room.usedWords);
  room.clues = {};
  room.guess = '';
  io.to(roomCode).emit('update-room', serializeRoom(room));
}

function serializeRoom(room) {
  return {
    ...room,
    usedWords: Array.from(room.usedWords || [])
  };
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});