const WebSocket = require('ws');
const config = require('../config/config');

class WebSocketService {
    constructor() {
        this.clients = new Set();
        this.wss = null;
        this.videoProcessingService = null; // Will be set after initialization to avoid circular dependency
    }

    initialize(server) {
        this.wss = new WebSocket.Server({ server });
        this.setupEventHandlers();
    }

    setVideoProcessingService(videoProcessingService) {
        this.videoProcessingService = videoProcessingService;
    }

    setupEventHandlers() {
        this.wss.on('connection', (ws) => {
            console.log('Client connected to WebSocket');
            this.clients.add(ws);

            // Automatically start stream when first client connects
            if (this.clients.size === 1 && this.videoProcessingService && this.videoProcessingService.currentCctvUrl) {
                console.log('🚀 First client connected - automatically starting stream...');
                this.videoProcessingService.startStreamLoop(this.videoProcessingService.currentCctvUrl);
            }

            ws.on('message', (message) => {
                console.log('Received message from client:', message.toString());
                if (message.toString() === 'REQUEST_STREAM_RESTART') {
                    if (this.videoProcessingService && this.videoProcessingService.currentCctvUrl) {
                        console.log('🔄 Client requested stream restart...');
                        this.videoProcessingService.startStreamLoop(this.videoProcessingService.currentCctvUrl);
                    }
                }
            });

            ws.on('close', () => {
                console.log('Client disconnected');
                this.clients.delete(ws);
                
                // Automatically stop stream when all clients disconnect
                if (this.clients.size === 0) {
                    console.log('🛑 All clients disconnected - automatically stopping stream...');
                    if (this.videoProcessingService) {
                        this.videoProcessingService.stopStreamLoop();
                    }
                }
            });

            ws.on('error', (error) => {
                console.error('WebSocket error:', error);
                this.clients.delete(ws);
                
                // Check if we need to stop stream after error
                if (this.clients.size === 0) {
                    console.log('🛑 All clients disconnected due to errors - automatically stopping stream...');
                    if (this.videoProcessingService) {
                        this.videoProcessingService.stopStreamLoop();
                    }
                }
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
                    // Remove client if send fails
                    this.clients.delete(client);
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