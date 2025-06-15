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
        origin: ["https://your-netlify-app.netlify.app", "http://localhost:3000"], // Replace with your Netlify URL
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
        'lighthouse', 'snowman', 'octopus', 'hamburger', 'spaceship