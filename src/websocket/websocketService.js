const WebSocket = require('ws');
const config = require('../config/config');

class WebSocketService {
    constructor() {
        this.clients = new Set();
        this.wss = null;
    }

    initialize(server) {
        this.wss = new WebSocket.Server({ server });
        this.setupEventHandlers();
    }

    setupEventHandlers() {
        this.wss.on('connection', (ws) => {
            console.log('Client connected to WebSocket');
            this.clients.add(ws);

            ws.on('message', (message) => {
                console.log('Received message from client:', message.toString());
                if (message.toString() === 'REQUEST_STREAM_RESTART') {
                    this.emit('streamRestart');
                }
            });

            ws.on('close', () => {
                console.log('Client disconnected');
                this.clients.delete(ws);
                if (this.clients.size === 0) {
                    this.emit('noClients');
                }
            });

            ws.on('error', (error) => {
                console.error('WebSocket error:', error);
                this.clients.delete(ws);
            });
        });
    }

    broadcast(data) {
        this.clients.forEach(client => {
            if (client.readyState === WebSocket.OPEN) {
                try {
                    client.send(data);
                } catch (e) {
                    console.error("Error broadcasting to client:", e);
                }
            }
        });
    }

    getClientCount() {
        return this.clients.size;
    }

    close() {
        if (this.wss) {
            this.wss.clients.forEach(client => client.terminate());
            this.wss.close();
        }
    }
}

module.exports = new WebSocketService(); 