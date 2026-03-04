const express = require('express');
const WebSocket = require('ws');
const cors = require('cors');
const http = require('http');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// Create HTTP server
const server = http.createServer(app);

// Create WebSocket server
const wss = new WebSocket.Server({ server });

// Data storage
const activePlayers = new Map();
const activeCalls = new Map();
const playerConnections = new Map();

// ==================== WebSocket Handlers ====================
wss.on('connection', (ws) => {
    console.log('[WebSocket] New client connected');
    let playerId = null;

    ws.on('message', (data) => {
        try {
            const message = JSON.parse(data);
            handleWebSocketMessage(ws, message);
        } catch (error) {
            console.error('[WebSocket] Error parsing message:', error);
            ws.send(JSON.stringify({
                type: 'error',
                message: 'Invalid message format'
            }));
        }
    });

    ws.on('close', () => {
        if (playerId) {
            activePlayers.delete(playerId);
            playerConnections.delete(playerId);
            console.log(`[WebSocket] Player ${playerId} disconnected`);
        }
    });

    ws.on('error', (error) => {
        console.error('[WebSocket] Error:', error);
    });
});

function handleWebSocketMessage(ws, message) {
    switch (message.type) {
        case 'register':
            registerWebSocketPlayer(ws, message);
            break;
        case 'voice-data':
            forwardVoiceData(message);
            break;
        case 'call-started':
            broadcastCallEvent('call-started', message);
            break;
        case 'call-ended':
            broadcastCallEvent('call-ended', message);
            break;
        case 'ping':
            ws.send(JSON.stringify({ type: 'pong' }));
            break;
        default:
            console.warn('[WebSocket] Unknown message type:', message.type);
    }
}

function registerWebSocketPlayer(ws, message) {
    const { playerId, playerName } = message;
    playerConnections.set(playerId, ws);
    console.log(`[WebSocket] Player registered: ${playerName} (${playerId})`);
    
    ws.send(JSON.stringify({
        type: 'register-success',
        playerId: playerId,
        message: 'Successfully registered for voice chat'
    }));
}

function forwardVoiceData(message) {
    const { targetId, voiceData } = message;
    const targetWs = playerConnections.get(targetId);
    
    if (targetWs && targetWs.readyState === WebSocket.OPEN) {
        targetWs.send(JSON.stringify({
            type: 'voice-data',
            from: message.playerId,
            voiceData: voiceData
        }));
    }
}

function broadcastCallEvent(eventType, data) {
    const { initiatorId, targetId } = data;
    const initiatorWs = playerConnections.get(initiatorId);
    const targetWs = playerConnections.get(targetId);

    const event = {
        type: eventType,
        ...data
    };

    if (initiatorWs && initiatorWs.readyState === WebSocket.OPEN) {
        initiatorWs.send(JSON.stringify(event));
    }
    if (targetWs && targetWs.readyState === WebSocket.OPEN) {
        targetWs.send(JSON.stringify(event));
    }
}

// ==================== HTTP API Endpoints ====================

// Health check
app.get('/api/health', (req, res) => {
    res.json({
        status: 'online',
        timestamp: Date.now(),
        activePlayers: activePlayers.size,
        activeCalls: activeCalls.size
    });
});

// Register player
app.post('/api/players', (req, res) => {
    const { playerId, playerName } = req.body;

    if (!playerId || !playerName) {
        return res.status(400).json({ error: 'Missing playerId or playerName' });
    }

    activePlayers.set(playerId, {
        name: playerName,
        registeredAt: Date.now(),
        status: 'online'
    });

    console.log(`[HTTP] Player registered: ${playerName} (${playerId})`);

    res.json({
        success: true,
        message: 'Player registered successfully',
        playerId: playerId
    });
});

// Get all active players
app.get('/api/players', (req, res) => {
    const players = Array.from(activePlayers.entries()).map(([id, data]) => ({
        id,
        ...data
    }));

    res.json({
        players: players,
        count: players.length
    });
});

// Start voice call
app.post('/api/calls/start', (req, res) => {
    const { callId, initiatorId, initiatorName, targetId, targetName, timestamp } = req.body;

    if (!callId || !initiatorId || !targetId) {
        return res.status(400).json({ error: 'Missing required call parameters' });
    }

    const call = {
        callId,
        initiatorId,
        initiatorName,
        targetId,
        targetName,
        status: 'pending',
        startedAt: timestamp,
        answeredAt: null
    };

    activeCalls.set(callId, call);

    console.log(`[Call] Started: ${initiatorName} -> ${targetName}`);

    // Send WebSocket notification
    const receiverWs = playerConnections.get(targetId);
    if (receiverWs && receiverWs.readyState === WebSocket.OPEN) {
        receiverWs.send(JSON.stringify({
            type: 'incoming-call',
            callId: callId,
            from: initiatorName,
            fromId: initiatorId,
            timestamp: timestamp
        }));
    }

    res.json({
        success: true,
        callId: callId,
        message: 'Call initiated'
    });
});

// Answer voice call
app.post('/api/calls/answer', (req, res) => {
    const { callId, playerId, playerName } = req.body;

    const call = activeCalls.get(callId);
    if (!call) {
        return res.status(404).json({ error: 'Call not found' });
    }

    call.status = 'active';
    call.answeredAt = Date.now();

    console.log(`[Call] Answered: ${playerName} joined call ${callId}`);

    // Notify both parties
    const initiatorWs = playerConnections.get(call.initiatorId);
    const answererWs = playerConnections.get(playerId);

    const updateEvent = {
        type: 'call-active',
        callId: callId,
        initiator: call.initiatorName,
        answerer: playerName
    };

    if (initiatorWs?.readyState === WebSocket.OPEN) {
        initiatorWs.send(JSON.stringify(updateEvent));
    }
    if (answererWs?.readyState === WebSocket.OPEN) {
        answererWs.send(JSON.stringify(updateEvent));
    }

    res.json({
        success: true,
        message: 'Call answered successfully'
    });
});

// End voice call
app.post('/api/calls/end', (req, res) => {
    const { callId, playerId } = req.body;

    const call = activeCalls.get(callId);
    if (!call) {
        return res.status(404).json({ error: 'Call not found' });
    }

    const duration = Date.now() - call.startedAt;

    console.log(`[Call] Ended: ${callId} (Duration: ${Math.round(duration / 1000)}s)`);

    activeCalls.delete(callId);

    // Notify both parties
    const initiatorWs = playerConnections.get(call.initiatorId);
    const targetWs = playerConnections.get(call.targetId);

    const endEvent = {
        type: 'call-ended',
        callId: callId,
        duration: duration
    };

    if (initiatorWs?.readyState === WebSocket.OPEN) {
        initiatorWs.send(JSON.stringify(endEvent));
    }
    if (targetWs?.readyState === WebSocket.OPEN) {
        targetWs.send(JSON.stringify(endEvent));
    }

    res.json({
        success: true,
        message: 'Call ended',
        duration: duration
    });
});

// ==================== Voice Streaming API ====================

// Start voice transmission
app.post('/api/voice/start', (req, res) => {
    const { playerId, playerName, position, dimension } = req.body;

    if (!playerId || !playerName) {
        return res.status(400).json({ error: 'Missing playerId or playerName' });
    }

    const player = activePlayers.get(playerId);
    if (player) {
        player.voiceActive = true;
        player.voiceStart = Date.now();
        player.position = position;
        player.dimension = dimension;
    }

    console.log(`[Voice] ${playerName} started transmitting`);

    // Notify WebSocket clients
    wss.clients.forEach(ws => {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
                type: 'voice-start',
                playerId: playerId,
                playerName: playerName,
                timestamp: Date.now()
            }));
        }
    });

    res.json({
        success: true,
        message: 'Voice transmission started',
        playerId: playerId
    });
});

// Stop voice transmission
app.post('/api/voice/stop', (req, res) => {
    const { playerId } = req.body;

    const player = activePlayers.get(playerId);
    if (player) {
        player.voiceActive = false;
        if (player.voiceStart) {
            const duration = Math.round((Date.now() - player.voiceStart) / 1000);
            console.log(`[Voice] ${player.name} stopped transmitting (${duration}s)`);
        }
    }

    // Notify WebSocket clients
    wss.clients.forEach(ws => {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
                type: 'voice-stop',
                playerId: playerId,
                timestamp: Date.now()
            }));
        }
    });

    res.json({
        success: true,
        message: 'Voice transmission stopped'
    });
});

// Update voice stream positions (for distance calculation)
app.post('/api/voice/update', (req, res) => {
    const { timestamp, updates } = req.body;

    if (!updates || !Array.isArray(updates)) {
        return res.status(400).json({ error: 'Invalid voice updates' });
    }

    // Store voice state for later queries
    const voiceState = {
        timestamp: timestamp,
        speakers: []
    };

    updates.forEach(update => {
        const { speakerId, speakerName, position, listeners } = update;

        const speaker = activePlayers.get(speakerId);
        if (speaker) {
            speaker.position = position;
            speaker.listeners = listeners;
        }

        voiceState.speakers.push({
            speakerId,
            speakerName,
            position,
            listenerCount: listeners.length
        });
    });

    // Broadcast to WebSocket clients
    wss.clients.forEach(ws => {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
                type: 'voice-update',
                voiceState: voiceState
            }));
        }
    });

    res.json({
        success: true,
        processed: updates.length
    });
});

// Get active voice channels (players currently transmitting)
app.get('/api/voice/active', (req, res) => {
    const activeVoice = [];

    for (const [id, player] of activePlayers) {
        if (player.voiceActive) {
            activeVoice.push({
                playerId: id,
                playerName: player.name,
                position: player.position,
                dimension: player.dimension,
                startTime: player.voiceStart,
                duration: Math.round((Date.now() - player.voiceStart) / 1000),
                listeners: player.listeners ? player.listeners.length : 0
            });
        }
    }

    res.json({
        active: activeVoice,
        count: activeVoice.length,
        timestamp: Date.now()
    });
});

// Get listeners for a specific player (who can hear them)
app.get('/api/voice/:playerId/listeners', (req, res) => {
    const { playerId } = req.params;
    const player = activePlayers.get(playerId);

    if (!player || !player.voiceActive) {
        return res.status(404).json({ error: 'Player not found or not transmitting' });
    }

    const listeners = player.listeners || [];

    res.json({
        playerId: playerId,
        playerName: player.name,
        listeners: listeners,
        count: listeners.length
    });
});

// Mute/unmute in call
app.post('/api/calls/:callId/mute', (req, res) => {
    const { playerId, muted } = req.body;
    const call = activeCalls.get(req.params.callId);

    if (!call) {
        return res.status(404).json({ error: 'Call not found' });
    }

    if (!call.participants) {
        call.participants = {};
    }

    call.participants[playerId] = { muted };

    console.log(`[Call] Player ${playerId} muted: ${muted}`);

    res.json({
        success: true,
        message: `Player ${muted ? 'muted' : 'unmuted'}`
    });
});

// ==================== Settings API ====================

// Save player settings
app.post('/api/settings/save', (req, res) => {
    const { playerId, settings } = req.body;

    if (!playerId || !settings) {
        return res.status(400).json({ error: 'Missing playerId or settings' });
    }

    // Store settings in memory (in production, use database)
    if (!activePlayers.has(playerId)) {
        activePlayers.set(playerId, { settings: {} });
    }
    
    activePlayers.get(playerId).settings = settings;

    console.log(`[Settings] Saved for player ${playerId}`);

    res.json({
        success: true,
        message: 'Settings saved successfully'
    });
});

// Load player settings
app.get('/api/settings/:playerId', (req, res) => {
    const { playerId } = req.params;
    const player = activePlayers.get(playerId);

    if (!player || !player.settings) {
        return res.status(404).json({ error: 'Settings not found' });
    }

    res.json({
        playerId: playerId,
        settings: player.settings
    });
});

// Get all settings for a player
app.get('/api/settings/:playerId/all', (req, res) => {
    const { playerId } = req.params;
    const player = activePlayers.get(playerId);

    if (!player) {
        return res.status(404).json({ error: 'Player not found' });
    }

    res.json({
        playerId: playerId,
        settings: player.settings || {},
        timestamp: Date.now()
    });
});

// Reset settings to default
app.post('/api/settings/:playerId/reset', (req, res) => {
    const { playerId } = req.params;
    
    if (activePlayers.has(playerId)) {
        activePlayers.get(playerId).settings = {};
    }

    console.log(`[Settings] Reset for player ${playerId}`);

    res.json({
        success: true,
        message: 'Settings reset to default'
    });
});

// Block player
app.post('/api/settings/:playerId/block/:blockedPlayerId', (req, res) => {
    const { playerId, blockedPlayerId } = req.params;
    const player = activePlayers.get(playerId);

    if (!player) {
        return res.status(404).json({ error: 'Player not found' });
    }

    if (!player.blocked) {
        player.blocked = [];
    }

    if (!player.blocked.includes(blockedPlayerId)) {
        player.blocked.push(blockedPlayerId);
    }

    console.log(`[Settings] ${playerId} blocked ${blockedPlayerId}`);

    res.json({
        success: true,
        message: 'Player blocked',
        blocked: player.blocked
    });
});

// Unblock player
app.delete('/api/settings/:playerId/block/:blockedPlayerId', (req, res) => {
    const { playerId, blockedPlayerId } = req.params;
    const player = activePlayers.get(playerId);

    if (!player || !player.blocked) {
        return res.status(404).json({ error: 'Player or blocked list not found' });
    }

    const index = player.blocked.indexOf(blockedPlayerId);
    if (index > -1) {
        player.blocked.splice(index, 1);
    }

    console.log(`[Settings] ${playerId} unblocked ${blockedPlayerId}`);

    res.json({
        success: true,
        message: 'Player unblocked',
        blocked: player.blocked
    });
});

// Get blocked players list
app.get('/api/settings/:playerId/blocked', (req, res) => {
    const { playerId } = req.params;
    const player = activePlayers.get(playerId);

    if (!player) {
        return res.status(404).json({ error: 'Player not found' });
    }

    res.json({
        playerId: playerId,
        blocked: player.blocked || []
    });
});

// Error handling middleware
app.use((err, req, res, next) => {
    console.error('[Error]', err);
    res.status(500).json({
        error: 'Internal server error',
        message: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
});

// Start server
server.listen(PORT, () => {
    console.log(`
╔════════════════════════════════════════════════════╗
║   Minecraft Voice Chat Server                      ║
║   Server running on http://localhost:${PORT}        ║
║   WebSocket running on ws://localhost:${PORT}       ║
╚════════════════════════════════════════════════════╝
    `);
    console.log(`[Status] Server mode: ${process.env.NODE_ENV || 'development'}`);
    console.log('[Status] Ready to accept connections...\n');
});

// Graceful shutdown
process.on('SIGINT', () => {
    console.log('\n[Status] Shutting down gracefully...');
    server.close(() => {
        console.log('[Status] Server closed');
        process.exit(0);
    });
});

module.exports = { app, wss, activePlayers, activeCalls };
