const socket = io();
let currentRoomCode = '';
let myPlayerName = '';

// Pre-fill Room Code if opened via Share Link
window.addEventListener('DOMContentLoaded', () => {
  const urlParams = new URLSearchParams(window.location.search);
  const roomParam = urlParams.get('room');
  if (roomParam) {
    document.getElementById('room-input').value = roomParam.toUpperCase();
  }
});

// UI Event Listeners
document.getElementById('create-btn').onclick = () => {
  myPlayerName = document.getElementById('player-name').value.trim();
  if (!myPlayerName) return alert('Enter your name!');
  socket.emit('create-room', { playerName: myPlayerName });
};

document.getElementById('join-btn').onclick = () => {
  myPlayerName = document.getElementById('player-name').value.trim();
  let roomCode = document.getElementById('room-input').value.trim();
  if (!myPlayerName || !roomCode) return alert('Enter name and room code!');
  socket.emit('join-room', { roomCode, playerName: myPlayerName });
};

document.getElementById('start-game-btn').onclick = () => {
  const confirmStart = confirm("Are all players in the room?\n\nOnce started, new players cannot join.");
  if (confirmStart) {
    socket.emit('start-game', { roomCode: currentRoomCode });
  }
};

document.getElementById('copy-link-btn').onclick = () => {
  const shareUrl = `${window.location.origin}${window.location.pathname}?room=${currentRoomCode}`;
  navigator.clipboard.writeText(shareUrl).then(() => alert('Share link copied!'));
};

document.getElementById('submit-clue-btn').onclick = () => {
  const clueText = document.getElementById('clue-input').value.trim();
  if (!clueText) return;
  socket.emit('submit-clue', { roomCode: currentRoomCode, clueText });
  document.getElementById('clue-input').value = '';
};

document.getElementById('approve-clues-btn').onclick = () => {
  socket.emit('approve-clues', { roomCode: currentRoomCode });
};

document.getElementById('submit-guess-btn').onclick = () => {
  const guessText = document.getElementById('guess-input').value.trim();
  if (!guessText) return;
  socket.emit('submit-guess', { roomCode: currentRoomCode, guessText });
};

document.getElementById('next-round-btn').onclick = () => {
  socket.emit('next-round', { roomCode: currentRoomCode });
};

// Socket Event Listeners
socket.on('room-joined', ({ roomCode, isHost, room }) => {
  currentRoomCode = roomCode;
  document.getElementById('join-screen').style.display = 'none';
  document.getElementById('game-screen').style.display = 'block';
  document.getElementById('room-code-display').textContent = roomCode;
  document.getElementById('player-name-badge').textContent = `Playing as: ${myPlayerName}`;
  
  if (isHost) document.getElementById('start-game-btn').style.display = 'inline-block';
});

socket.on('error-msg', (msg) => alert(msg));

socket.on('update-room', (room) => {
  renderRoom(room);
});

function renderRoom(room) {
  const me = socket.id;
  const guesser = room.players[room.guesserIndex];
  const moderator = room.players[room.moderatorIndex];

  // Role Text
  let myRole = "Clue Provider";
  if (me === guesser.id) myRole = "Solution Guesser";
  if (me === moderator.id) myRole = "Moderator & Clue Provider";
  document.getElementById('role-display').textContent = `Your Role: ${myRole}`;

  // Hide all phase panels by default
  document.getElementById('submitting-clues-view').style.display = 'none';
  document.getElementById('reviewing-clues-view').style.display = 'none';
  document.getElementById('guessing-view').style.display = 'none';
  document.getElementById('round-over-view').style.display = 'none';

  if (room.state !== 'lobby') {
    document.getElementById('start-game-btn').style.display = 'none';
  }

  // Phase 1: Submitting Clues
  if (room.state === 'submitting-clues') {
    document.getElementById('submitting-clues-view').style.display = 'block';
    
    if (me === guesser.id) {
      document.getElementById('target-word-display').textContent = "??? (You are guessing)";
      document.getElementById('clue-input-box').style.display = 'none';
      document.getElementById('waiting-clues-msg').textContent = "Other players are writing clues...";
    } else {
      document.getElementById('target-word-display').textContent = `Target Word: ${room.targetWord}`;
      if (room.clues[me]) {
        document.getElementById('clue-input-box').style.display = 'none';
        document.getElementById('waiting-clues-msg').textContent = "Clue submitted! Waiting for others...";
      } else {
        document.getElementById('clue-input-box').style.display = 'block';
        document.getElementById('waiting-clues-msg').textContent = "";
      }
    }
  }

  // Phase 2: Reviewing Clues
  if (room.state === 'reviewing-clues') {
    document.getElementById('reviewing-clues-view').style.display = 'block';
    const listDiv = document.getElementById('moderator-clue-list');
    listDiv.innerHTML = '';

    const isModerator = me === moderator.id;
    document.getElementById('approve-clues-btn').style.display = isModerator ? 'inline-block' : 'none';

    Object.values(room.clues).forEach(item => {
      const el = document.createElement('div');
      el.className = `clue-item ${item.valid ? '' : 'invalid'}`;
      el.textContent = `${item.playerName}: ${item.clue}`;
      
      if (isModerator) {
        el.style.cursor = 'pointer';
        el.onclick = () => socket.emit('toggle-clue-validity', { roomCode: currentRoomCode, targetPlayerId: item.playerId });
      }
      listDiv.appendChild(el);
    });
  }

  // Phase 3: Guessing Phase
  if (room.state === 'guessing') {
    document.getElementById('guessing-view').style.display = 'block';
    const listEl = document.getElementById('guesser-clue-list');
    listEl.innerHTML = '';

    // Filter valid clues only
    const validClues = Object.values(room.clues).filter(c => c.valid);
    validClues.forEach(item => {
      const li = document.createElement('li');
      li.textContent = `💡 ${item.clue}`;
      listEl.appendChild(li);
    });

    if (me === guesser.id) {
      document.getElementById('guesser-input-box').style.display = 'block';
    } else {
      document.getElementById('guesser-input-box').style.display = 'none';
    }
  }

  // Phase 4: Round Over
  if (room.state === 'round-over') {
    document.getElementById('round-over-view').style.display = 'block';
    const isCorrect = room.guess === room.targetWord;
    document.getElementById('result-status').textContent = isCorrect ? "🎉 Correct Answer!" : "❌ Wrong Guess!";
    document.getElementById('reveal-target').textContent = room.targetWord;
    document.getElementById('reveal-guess').textContent = room.guess || "(No Guess)";
  }

  // Render Scoreboard
  const scoreDiv = document.getElementById('scoreboard');
  scoreDiv.innerHTML = room.players
    .slice()
    .sort((a, b) => b.score - a.score)
    .map(p => `<p>${p.name}: <strong>${p.score} pts</strong></p>`)
    .join('');
}