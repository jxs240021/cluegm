const socket = io();
let currentRoomCode = '';
let myPlayerName = '';

window.addEventListener('DOMContentLoaded', () => {
  const urlParams = new URLSearchParams(window.location.search);
  const roomParam = urlParams.get('room');
  if (roomParam) {
    document.getElementById('room-input').value = roomParam.toUpperCase().trim();
  }
});

// UI Click Handlers
document.getElementById('create-btn').onclick = () => {
  myPlayerName = document.getElementById('player-name').value.trim();
  if (!myPlayerName) return alert('Please enter your name first!');
  socket.emit('create-room', { playerName: myPlayerName });
};

document.getElementById('join-btn').onclick = () => {
  myPlayerName = document.getElementById('player-name').value.trim();
  let roomCode = document.getElementById('room-input').value.trim();
  if (!myPlayerName || !roomCode) return alert('Please enter your name and room code!');
  socket.emit('join-room', { roomCode, playerName: myPlayerName });
};

document.getElementById('start-game-btn').onclick = () => {
  if (confirm("Are all players in the room? Game will lock to new joins once started.")) {
    socket.emit('start-game', { roomCode: currentRoomCode });
  }
};

document.getElementById('copy-link-btn').onclick = () => {
  const shareUrl = `${window.location.origin}${window.location.pathname}?room=${currentRoomCode}`;
  navigator.clipboard.writeText(shareUrl).then(() => alert('Share link copied to clipboard!'));
};

document.getElementById('submit-clue-btn').onclick = () => {
  const clueInput = document.getElementById('clue-input');
  const clueText = clueInput.value.trim();
  if (!clueText) return;
  socket.emit('submit-clue', { roomCode: currentRoomCode, clueText });
  clueInput.value = '';
};

document.getElementById('approve-clues-btn').onclick = () => {
  socket.emit('approve-clues', { roomCode: currentRoomCode });
};

document.getElementById('submit-guess-btn').onclick = () => {
  const guessInput = document.getElementById('guess-input');
  const guessText = guessInput.value.trim();
  if (!guessText) return;
  socket.emit('submit-guess', { roomCode: currentRoomCode, guessText });
  guessInput.value = '';
};

document.getElementById('next-round-btn').onclick = () => {
  socket.emit('next-round', { roomCode: currentRoomCode });
};

// Socket Events
socket.on('error-msg', (msg) => {
  alert(msg);
  const nameInput = document.getElementById('player-name');
  if (nameInput) {
    nameInput.focus();
    nameInput.select();
  }
});

socket.on('room-joined', ({ roomCode, isHost, room }) => {
  currentRoomCode = roomCode;
  document.getElementById('join-screen').style.display = 'none';
  document.getElementById('game-screen').style.display = 'block';
  document.getElementById('room-code-display').textContent = roomCode;
  document.getElementById('player-name-badge').textContent = `Playing as: ${myPlayerName}`;
});

socket.on('update-room', (room) => {
  renderRoom(room);
});

function renderRoom(room) {
  const me = socket.id;
  const guesser = room.players[room.guesserIndex];
  const moderator = room.players[room.moderatorIndex];

  const lobbyContainer = document.getElementById('lobby-list-container');
  const scoreboardContainer = document.getElementById('scoreboard-container');
  const startBtn = document.getElementById('start-game-btn');

  if (room.state === 'lobby') {
    lobbyContainer.style.display = 'block';
    scoreboardContainer.style.display = 'none';

    const lobbyUl = document.getElementById('lobby-player-list');
    lobbyUl.innerHTML = room.players
      .map(p => `<li>👤 ${p.name} ${p.id === room.hostId ? '<span style="color:#d69e2e;">👑 (Host)</span>' : ''}</li>`)
      .join('');

    document.getElementById('role-display').textContent = 'Waiting for Host to start...';
    startBtn.style.display = (me === room.hostId) ? 'inline-block' : 'none';
  } else {
    lobbyContainer.style.display = 'none';
    scoreboardContainer.style.display = 'block';
    startBtn.style.display = 'none';

    let myRole = "Clue Provider";
    if (me === guesser?.id) myRole = "Solution Guesser";
    if (me === moderator?.id) myRole = "Moderator & Clue Provider";
    document.getElementById('role-display').textContent = `Your Role: ${myRole}`;
  }

  // Hide all panels
  document.getElementById('selecting-category-view').style.display = 'none';
  document.getElementById('submitting-clues-view').style.display = 'none';
  document.getElementById('reviewing-clues-view').style.display = 'none';
  document.getElementById('guessing-view').style.display = 'none';
  document.getElementById('round-over-view').style.display = 'none';

  // Phase 0: Category Selection
  if (room.state === 'selecting-category') {
    document.getElementById('selecting-category-view').style.display = 'block';
    const container = document.getElementById('category-buttons-container');
    container.innerHTML = '';

    const isModerator = me === moderator?.id;

    if (isModerator) {
      document.getElementById('category-picker-title').textContent = "Pick a Category for this Round!";
      document.getElementById('category-instruction-text').textContent = "As Moderator, choose one of the 3 randomly generated options:";
      
      room.categoryChoices.forEach(cat => {
        const btn = document.createElement('button');
        btn.className = 'btn-category';
        btn.textContent = `📁 ${cat}`;
        btn.onclick = () => socket.emit('select-category', { roomCode: currentRoomCode, category: cat });
        container.appendChild(btn);
      });
    } else {
      document.getElementById('category-picker-title').textContent = "Moderator is Choosing Category...";
      document.getElementById('category-instruction-text').textContent = `${moderator?.name || 'Moderator'} is picking between 3 category choices.`;
    }
  }

  // Phase 1: Submitting Clues
  if (room.state === 'submitting-clues') {
    document.getElementById('submitting-clues-view').style.display = 'block';
    document.getElementById('category-badge-display').textContent = `Category: ${room.selectedCategory}`;

    if (me === guesser.id) {
      document.getElementById('target-word-display').textContent = "??? (You are guessing)";
      document.getElementById('clue-input-box').style.display = 'none';
      document.getElementById('waiting-clues-msg').textContent = "Other players are writing clues...";
    } else {
      document.getElementById('target-word-display').textContent = `Target Word: ${room.targetWord}`;
      if (room.clues[me]) {
        document.getElementById('clue-input-box').style.display = 'none';
        document.getElementById('waiting-clues-msg').textContent = `Clue submitted: "${room.clues[me].clue}". Waiting for others...`;
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

    const isGuesser = me === guesser.id;
    const isModerator = me === moderator.id;

    if (isGuesser) {
      document.getElementById('mod-instruction-text').textContent = "The Moderator is currently reviewing the submitted clues...";
      document.getElementById('approve-clues-btn').style.display = 'none';
      listDiv.innerHTML = '<p style="font-style: italic; color: #718096;">Clues hidden until approved by Moderator...</p>';
    } else {
      document.getElementById('approve-clues-btn').style.display = isModerator ? 'inline-block' : 'none';
      document.getElementById('mod-instruction-text').textContent = isModerator 
        ? "Click any clue to toggle it Valid / Invalid before sending."
        : "Moderator is reviewing the clues below:";

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
  }

  // Phase 3: Guessing Phase
  if (room.state === 'guessing') {
    document.getElementById('guessing-view').style.display = 'block';
    const listEl = document.getElementById('guesser-clue-list');
    listEl.innerHTML = '';

    const validClues = Object.values(room.clues).filter(c => c.valid);
    if (validClues.length === 0) {
      listEl.innerHTML = '<li style="color:red;">All clues were marked invalid by the moderator!</li>';
    } else {
      validClues.forEach(item => {
        const li = document.createElement('li');
        li.className = 'clue-item';
        li.textContent = `💡 ${item.clue}`;
        listEl.appendChild(li);
      });
    }

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
    document.getElementById('result-status').textContent = isCorrect ? "🎉 Correct Answer!" : "❌ Incorrect!";
    document.getElementById('reveal-target').textContent = room.targetWord;
    document.getElementById('reveal-guess').textContent = room.guess || "(No Guess)";
  }

  // Scoreboard
  const scoreDiv = document.getElementById('scoreboard');
  if (scoreDiv) {
    scoreDiv.innerHTML = room.players
      .slice()
      .sort((a, b) => b.score - a.score)
      .map(p => `<p>${p.name}: <strong>${p.score} pts</strong></p>`)
      .join('');
  }
}
