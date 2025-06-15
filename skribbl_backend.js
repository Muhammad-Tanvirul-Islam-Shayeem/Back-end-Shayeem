// server.js - Main server file for Railway deployment
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const path = require('path');

const app = express();
const server = http.createServer(app);

// CORS configuration for Netlify frontend
const io = socketIo(server, {
    cors: {
        origin: ["draw-shayeem.netlify.app", "http://localhost:3000"], // Replace with your Netlify URL
        methods: ["GET", "POST"],
        allowedHeaders: ["Content-Type"],
        credentials: true
    }
});

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Game data storage
const lobbies = new Map();
const players = new Map();

// Word lists for the game
const WORD_LISTS = {
    easy: [
        'cat', 'dog', 'sun', 'car', 'tree', 'house', 'book', 'fish', 'bird', 'moon',
        'star', 'ball', 'cake', 'ice', 'fire', 'rain', 'snow', 'boat', 'shoe', 'hat'
    ],
    medium: [
        'elephant', 'butterfly', 'rainbow', 'bicycle', 'computer', 'telephone', 'airplane', 
        'sandwich', 'umbrella', 'dinosaur', 'princess', 'guitar', 'volcano', 'treasure',
        'lighthouse', 'snowman', 'octopus', 'hamburger', 'spaceship', 'keyboard'
    ],
    hard: [
        'refrigerator', 'kaleidoscope', 'motorcycle', 'microphone', 'photographer', 
        'skeleton', 'watermelon', 'spaghetti', 'toothbrush', 'helicopter', 'telescope',
        'trampoline', 'parachute', 'orchestra', 'thermometer', 'escalator', 'submarine'
    ]
};

// Game configuration
const GAME_CONFIG = {
    ROUND_TIME: 80, // seconds
    ROUNDS_PER_GAME: 6,
    POINTS_CORRECT_GUESS: 100,
    POINTS_DRAWING_BONUS: 50,
    LOBBY_CODE_LENGTH: 6
};

// Utility functions
function generateLobbyCode() {
    return Math.random().toString(36).substr(2, GAME_CONFIG.LOBBY_CODE_LENGTH).toUpperCase();
}

function getRandomWord() {
    const allWords = [...WORD_LISTS.easy, ...WORD_LISTS.medium, ...WORD_LISTS.hard];
    return allWords[Math.floor(Math.random() * allWords.length)];
}

function createWordHint(word) {
    return word.split('').map(char => char === ' ' ? ' ' : '_').join(' ');
}

function getNextDrawer(lobby) {
    const availablePlayers = lobby.players.filter(p => p.id !== lobby.gameState.lastDrawer);
    if (availablePlayers.length === 0) {
        return lobby.players[0];
    }
    return availablePlayers[Math.floor(Math.random() * availablePlayers.length)];
}

// Lobby management
class Lobby {
    constructor(id, name, creatorId, maxPlayers = 8, isPrivate = false) {
        this.id = id;
        this.name = name;
        this.code = generateLobbyCode();
        this.creatorId = creatorId;
        this.maxPlayers = maxPlayers;
        this.isPrivate = isPrivate;
        this.players = [];
        this.gameState = {
            isPlaying: false,
            round: 0,
            currentDrawer: null,
            lastDrawer: null,
            currentWord: null,
            wordHint: null,
            timeLeft: GAME_CONFIG.ROUND_TIME,
            playersGuessed: new Set(),
            timer: null
        };
        this.createdAt = Date.now();
    }

    addPlayer(player) {
        if (this.players.length >= this.maxPlayers) {
            throw new Error('Lobby is full');
        }
        this.players.push(player);
    }

    removePlayer(playerId) {
        this.players = this.players.filter(p => p.id !== playerId);
        
        // If creator left, assign new creator
        if (this.creatorId === playerId && this.players.length > 0) {
            this.creatorId = this.players[0].id;
        }
        
        // If current drawer left, end round
        if (this.gameState.currentDrawer === playerId && this.gameState.isPlaying) {
            this.endRound();
        }
    }

    startGame() {
        if (this.players.length < 2) {
            throw new Error('Need at least 2 players to start');
        }
        
        this.gameState.isPlaying = true;
        this.gameState.round = 1;
        this.startNewRound();
    }

    startNewRound() {
        // Clear previous round state
        this.gameState.playersGuessed.clear();
        this.gameState.currentWord = getRandomWord();
        this.gameState.wordHint = createWordHint(this.gameState.currentWord);
        this.gameState.timeLeft = GAME_CONFIG.ROUND_TIME;
        
        // Select next drawer
        this.gameState.currentDrawer = getNextDrawer(this).id;
        this.gameState.lastDrawer = this.gameState.currentDrawer;
        
        // Reset player guess status
        this.players.forEach(player => {
            player.hasGuessed = false;
        });
        
        // Start timer
        this.startTimer();
    }

    startTimer() {
        if (this.gameState.timer) {
            clearInterval(this.gameState.timer);
        }
        
        this.gameState.timer = setInterval(() => {
            this.gameState.timeLeft--;
            
            // Broadcast time update
            io.to(this.id).emit('timeUpdate', { timeLeft: this.gameState.timeLeft });
            
            if (this.gameState.timeLeft <= 0 || this.allPlayersGuessed()) {
                this.endRound();
            }
        }, 1000);
    }

    endRound() {
        if (this.gameState.timer) {
            clearInterval(this.gameState.timer);
            this.gameState.timer = null;
        }
        
        // Show word if not everyone guessed
        if (!this.allPlayersGuessed()) {
            io.to(this.id).emit('timeUp', { word: this.gameState.currentWord });
        }
        
        // Check if game should end
        if (this.gameState.round >= GAME_CONFIG.ROUNDS_PER_GAME) {
            this.endGame();
        } else {
            // Start next round after delay
            setTimeout(() => {
                this.gameState.round++;
                this.startNewRound();
                io.to(this.id).emit('newRound', this.getGameStateForClient());
            }, 6000);
        }
    }

    endGame() {
        this.gameState.isPlaying = false;
        
        // Find winner
        const winner = this.players.reduce((prev, current) => 
            (prev.score > current.score) ? prev : current
        );
        
        io.to(this.id).emit('gameEnded', { winner });
        
        // Reset game state
        this.gameState.round = 0;
        this.gameState.currentDrawer = null;
        this.gameState.lastDrawer = null;
        this.gameState.currentWord = null;
        this.gameState.wordHint = null;
        this.gameState.playersGuessed.clear();
        
        // Reset player scores
        this.players.forEach(player => {
            player.score = 0;
            player.hasGuessed = false;
        });
    }

    allPlayersGuessed() {
        const playersWhoCanGuess = this.players.filter(p => p.id !== this.gameState.currentDrawer);
        return playersWhoCanGuess.every(p => p.hasGuessed);
    }

    getGameStateForClient() {
        return {
            isPlaying: this.gameState.isPlaying,
            round: this.gameState.round,
            currentDrawer: this.gameState.currentDrawer,
            currentWord: this.gameState.currentWord,
            wordHint: this.gameState.wordHint,
            timeLeft: this.gameState.timeLeft
        };
    }
}

// Player management
class Player {
    constructor(id, name, lobbyCode) {
        this.id = id;
        this.name = name;
        this.lobbyCode = lobbyCode;
        this.score = 0;
        this.hasGuessed = false;
        this.joinedAt = Date.now();
    }
}

// Socket.IO connection handling
io.on('connection', (socket) => {
    console.log(`Player connected: ${socket.id}`);

    // Create lobby
    socket.on('createLobby', ({ playerName, lobbyName, maxPlayers, isPrivate }) => {
        try {
            const lobbyId = socket.id + '_lobby';
            const lobby = new Lobby(lobbyId, lobbyName, socket.id, maxPlayers, isPrivate);
            
            lobbies.set(lobbyId, lobby);
            
            socket.emit('lobbyCreated', {
                code: lobby.code,
                name: lobby.name,
                isPrivate: lobby.isPrivate
            });
            
        } catch (error) {
            socket.emit('error', { message: error.message });
        }
    });

    // Join lobby
    socket.on('joinLobby', ({ code, playerName }) => {
        try {
            const lobby = Array.from(lobbies.values()).find(l => l.code === code);
            
            if (!lobby) {
                throw new Error('Lobby not found');
            }
            
            if (lobby.players.length >= lobby.maxPlayers) {
                throw new Error('Lobby is full');
            }
            
            const player = new Player(socket.id, playerName, code);
            lobby.addPlayer(player);
            players.set(socket.id, player);
            
            socket.join(lobby.id);
            
            // Notify all players in lobby
            io.to(lobby.id).emit('playerJoined', {
                player: player,
                players: lobby.players
            });
            
            // Send lobby data to joining player
            socket.emit('lobbyJoined', {
                lobby: {
                    id: lobby.id,
                    name: lobby.name,
                    code: lobby.code,
                    creatorId: lobby.creatorId,
                    players: lobby.players,
                    maxPlayers: lobby.maxPlayers
                },
                player: player,
                gameState: lobby.getGameStateForClient()
            });
            
            // Auto-start game if enough players and creator joined
            if (lobby.players.length >= 2 && !lobby.gameState.isPlaying) {
                setTimeout(() => {
                    lobby.startGame();
                    io.to(lobby.id).emit('gameStarted', lobby.getGameStateForClient());
                    io.to(lobby.id).emit('newRound', lobby.getGameStateForClient());
                }, 3000);
            }
            
        } catch (error) {
            socket.emit('error', { message: error.message });
        }
    });

    // Leave lobby
    socket.on('leaveLobby', () => {
        const player = players.get(socket.id);
        if (player) {
            const lobby = Array.from(lobbies.values()).find(l => l.code === player.lobbyCode);
            if (lobby) {
                lobby.removePlayer(socket.id);
                socket.leave(lobby.id);
                
                io.to(lobby.id).emit('playerLeft', {
                    playerName: player.name,
                    players: lobby.players
                });
                
                // Remove empty lobbies
                if (lobby.players.length === 0) {
                    lobbies.delete(lobby.id);
                }
            }
            players.delete(socket.id);
        }
    });

    // Get public lobbies
    socket.on('getPublicLobbies', () => {
        const publicLobbies = Array.from(lobbies.values())
            .filter(lobby => !lobby.isPrivate && lobby.players.length < lobby.maxPlayers)
            .map(lobby => ({
                code: lobby.code,
                name: lobby.name,
                players: lobby.players.length,
                maxPlayers: lobby.maxPlayers
            }));
        
        socket.emit('publicLobbies', publicLobbies);
    });

    // Drawing events
    socket.on('draw', (drawData) => {
        const player = players.get(socket.id);
        if (player) {
            const lobby = Array.from(lobbies.values()).find(l => l.code === player.lobbyCode);
            if (lobby && lobby.gameState.currentDrawer === socket.id) {
                socket.to(lobby.id).emit('drawing', drawData);
            }
        }
    });

    socket.on('clearCanvas', () => {
        const player = players.get(socket.id);
        if (player) {
            const lobby = Array.from(lobbies.values()).find(l => l.code === player.lobbyCode);
            if (lobby && lobby.gameState.currentDrawer === socket.id) {
                socket.to(lobby.id).emit('canvasCleared');
            }
        }
    });

    // Guess handling
    socket.on('guess', ({ message }) => {
        const player = players.get(socket.id);
        if (!player) return;
        
        const lobby = Array.from(lobbies.values()).find(l => l.code === player.lobbyCode);
        if (!lobby || !lobby.gameState.isPlaying) return;
        
        // Can't guess if you're the drawer or already guessed
        if (lobby.gameState.currentDrawer === socket.id || player.hasGuessed) return;
        
        const guess = message.toLowerCase().trim();
        const correctWord = lobby.gameState.currentWord.toLowerCase();
        
        if (guess === correctWord) {
            // Correct guess
            player.hasGuessed = true;
            player.score += GAME_CONFIG.POINTS_CORRECT_GUESS;
            lobby.gameState.playersGuessed.add(socket.id);
            
            io.to(lobby.id).emit('correctGuess', {
                playerId: socket.id,
                playerName: player.name,
                points: GAME_CONFIG.POINTS_CORRECT_GUESS,
                players: lobby.players
            });
            
            // Check if all players guessed
            if (lobby.allPlayersGuessed()) {
                // Give bonus points to drawer
                const drawer = lobby.players.find(p => p.id === lobby.gameState.currentDrawer);
                if (drawer) {
                    drawer.score += GAME_CONFIG.POINTS_DRAWING_BONUS;
                }
                lobby.endRound();
            }
        } else {
            // Wrong guess - broadcast as chat message
            io.to(lobby.id).emit('chatMessage', {
                playerId: socket.id,
                playerName: player.name,
                message: message,
                isCorrect: false
            });
        }
    });

    // Kick player
    socket.on('kickPlayer', ({ playerId }) => {
        const player = players.get(socket.id);
        if (!player) return;
        
        const lobby = Array.from(lobbies.values()).find(l => l.code === player.lobbyCode);
        if (!lobby || lobby.creatorId !== socket.id) return;
        
        const targetPlayer = players.get(playerId);
        if (targetPlayer) {
            lobby.removePlayer(playerId);
            
            io.to(lobby.id).emit('playerKicked', {
                playerId: playerId,
                playerName: targetPlayer.name
            });
            
            // Force disconnect the kicked player
            const targetSocket = io.sockets.sockets.get(playerId);
            if (targetSocket) {
                targetSocket.leave(lobby.id);
            }
            
            players.delete(playerId);
        }
    });

    // Disconnect handling
    socket.on('disconnect', () => {
        console.log(`Player disconnected: ${socket.id}`);
        
        const player = players.get(socket.id);
        if (player) {
            const lobby = Array.from(lobbies.values()).find(l => l.code === player.lobbyCode);
            if (lobby) {
                lobby.removePlayer(socket.id);
                
                io.to(lobby.id).emit('playerLeft', {
                    playerName: player.name,
                    players: lobby.players
                });
                
                // Remove empty lobbies
                if (lobby.players.length === 0) {
                    lobbies.delete(lobby.id);
                }
            }
            players.delete(socket.id);
        }
    });
});

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({ 
        status: 'healthy', 
        lobbies: lobbies.size, 
        players: players.size,
        timestamp: new Date().toISOString()
    });
});

// Get server stats
app.get('/stats', (req, res) => {
    const publicLobbies = Array.from(lobbies.values()).filter(lobby => !lobby.isPrivate);
    res.json({
        totalLobbies: lobbies.size,
        publicLobbies: publicLobbies.length,
        totalPlayers: players.size,
        activeGames: Array.from(lobbies.values()).filter(lobby => lobby.gameState.isPlaying).length
    });
});

// Cleanup inactive lobbies every 30 minutes
setInterval(() => {
    const now = Date.now();
    const INACTIVE_TIMEOUT = 30 * 60 * 1000; // 30 minutes
    
    for (const [id, lobby] of lobbies) {
        if (now - lobby.createdAt > INACTIVE_TIMEOUT && lobby.players.length === 0) {
            lobbies.delete(id);
            console.log(`Cleaned up inactive lobby: ${id}`);
        }
    }
}, 30 * 60 * 1000);

// Start server
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
});