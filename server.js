require('./config');

const express = require('express');
const cors = require('cors');
const path = require('path');
const http = require('http');
const WebSocket = require('ws');
const { runBatchGhostOps, runGhostOps } = require('./ghostops');

const app = express();
const port = Number.parseInt(process.env.PORT || '4000', 10);
const host = process.env.HOST || '127.0.0.1';

app.use(cors());
app.use(express.json());

const publicDir = path.join(__dirname, 'public');
app.use(express.static(publicDir));

let activeWs = null;
let isRunning = false;

function broadcast(type, data) {
  try {
    if (!activeWs || activeWs.readyState !== WebSocket.OPEN) return;
    activeWs.send(
      JSON.stringify({
        type,
        data,
        ts: Date.now(),
      })
    );
  } catch {
    // ignore websocket send failures
  }
}

app.post('/api/command', async (req, res) => {
  try {
    const { command } = req.body || {};

    if (!command || typeof command !== 'string') {
      return res.status(400).json({
        success: false,
        message: 'Missing or invalid "command" field in request body.',
      });
    }

    if (!activeWs || activeWs.readyState !== WebSocket.OPEN) {
      return res.status(409).json({
        success: false,
        message: 'No active Mission Control dashboard connected (WebSocket not connected).',
      });
    }

    if (isRunning) {
      return res.status(429).json({
        success: false,
        message: 'GhostOps is already running a mission. Please wait.',
      });
    }

    console.log('\x1b[36m%s\x1b[0m', `🎯 Received mission goal: "${command}"`);
    isRunning = true;

    const userCommand = req.body.command.toLowerCase();

    if (userCommand.includes('backlog') || userCommand.includes('back lock') || userCommand.includes('batch')) {
      broadcast('log', '🚀 BATCH MODE INITIATED: Processing 5 tickets...');

      const backlog = [
        { name: 'Jordan Wu', status: 'Resolved', remark: 'Refunded RM 50 to card.' },
        { name: 'Ariana Cole', status: 'Investigating', remark: 'Escalated to Level 2 tech.' },
        { name: 'Marcus Tan', status: 'Pending Customer', remark: 'Waiting for customer device logs.' },
        { name: 'Siti Nurhaliza', status: 'Investigating', remark: 'Core platform team preparing hotfix.' },
        { name: 'David Lee', status: 'Resolved', remark: 'Incident mitigated and customer notified.' },
      ];

      await runBatchGhostOps(backlog, broadcast);

      broadcast('log', '🎉 FULL BATCH PROCESSING COMPLETE!');
      isRunning = false;
      return res.json({ success: true, message: 'Batch complete' });
    } else {
      await runGhostOps(req.body.command, broadcast);
      isRunning = false;
      return res.json({ success: true, message: 'Goal achieved' });
    }
  } catch (err) {
    console.error('\x1b[31m%s\x1b[0m', '💥 Error handling /api/command:', err);
    isRunning = false;
    return res.status(500).json({
      success: false,
      message: err.message || 'Internal server error',
    });
  }
});

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

wss.on('connection', (ws) => {
  activeWs = ws;
  console.log('\x1b[32m%s\x1b[0m', '🛰️ Mission Control connected (WebSocket).');

  broadcast('log', '✅ Connected to GhostOps Mission Control stream.');

  ws.on('close', () => {
    console.log('\x1b[33m%s\x1b[0m', '📴 Mission Control disconnected (WebSocket).');
    if (activeWs === ws) activeWs = null;
  });
});

server.listen(port, host, () => {
  console.log('\x1b[32m%s\x1b[0m', `Server running on http://${host}:${port}`);
});

server.on('error', (err) => {
  console.error('\x1b[31m%s\x1b[0m', `💥 Failed to start server on ${host}:${port}`, err);
});
