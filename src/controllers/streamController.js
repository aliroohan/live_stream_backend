const videoProcessingService = require('../services/videoProcessingService');
const websocketService = require('../websocket/websocketService');
const fs = require('fs');
const config = require('../config/config');
const axios = require('axios');

class StreamController {
    async startStream(req, res) {
        const cctvUrl  = "rtsp://localhost:8554/mystream"
        if (!cctvUrl) {
            return res.status(400).json({ error: 'cctvUrl is required' });
        }

        videoProcessingService.currentCctvUrl = cctvUrl;
        
        if (websocketService.getClientCount() > 0) {
            videoProcessingService.startStreamLoop(cctvUrl);
            res.status(200).json({ message: 'Stream processing loop started/restarted. Frames will be sent via WebSocket.' });
        } else {
            res.status(200).json({ message: 'CCTV URL received. Stream will start when a client connects.' });
        }
    }

    stopStream(req, res) {
        videoProcessingService.stopStreamLoop();
        res.status(200).json({
            message: 'Stream processing loop stopped.',
            remainingChunks: videoProcessingService.chunkQueue.length
        });
    }

    getHealth(req, res) {
        res.status(200).json({
            status: 'ok',
            isProcessingQueue: videoProcessingService.isProcessingQueue,
            queueLength: videoProcessingService.chunkQueue.length,
            hasClients: websocketService.getClientCount() > 0,
            currentUrl: videoProcessingService.currentCctvUrl,
            isStreamRunning: !!videoProcessingService.streamLoopInterval
        });
    }

    getQueueStatus(req, res) {
        res.status(200).json({
            queueLength: videoProcessingService.chunkQueue.length,
            isProcessingQueue: videoProcessingService.isProcessingQueue,
            oldestChunk: videoProcessingService.chunkQueue.length > 0 ? 
                new Date(videoProcessingService.chunkQueue[0].timestamp).toISOString() : null,
            newestChunk: videoProcessingService.chunkQueue.length > 0 ? 
                new Date(videoProcessingService.chunkQueue[videoProcessingService.chunkQueue.length - 1].timestamp).toISOString() : null
        });
    }

    async testMlModel(req, res) {
        try {
            const response = await axios.get(config.ML_MODEL_API_URL_CHUNK.replace('/process_video_chunk', '/health'), {
                timeout: 5000
            });
            res.status(200).json({
                status: 'ML model reachable',
                response: response.data
            });
        } catch (error) {
            res.status(500).json({
                status: 'ML model unreachable',
                error: error.message
            });
        }
    }

    clearQueue(req, res) {
        const clearedCount = videoProcessingService.chunkQueue.length;
        videoProcessingService.chunkQueue = [];
        res.status(200).json({
            message: `Cleared ${clearedCount} chunks from queue`,
            clearedCount
        });
    }

    getSystemStatus(req, res) {
        const tempDirExists = fs.existsSync(config.TEMP_CHUNK_DIR);
        let tempDirSize = 0;
        let tempFileCount = 0;

        if (tempDirExists) {
            try {
                const files = fs.readdirSync(config.TEMP_CHUNK_DIR);
                tempFileCount = files.length;
                for (const file of files) {
                    const filePath = path.join(config.TEMP_CHUNK_DIR, file);
                    try {
                        const stats = fs.statSync(filePath);
                        if (stats.isFile()) {
                            tempDirSize += stats.size;
                        }
                    } catch (e) {
                        // Ignore individual file errors
                    }
                }
            } catch (e) {
                // Ignore directory read errors
            }
        }

        res.status(200).json({
            server: {
                uptime: process.uptime(),
                memoryUsage: process.memoryUsage(),
                pid: process.pid
            },
            stream: {
                currentUrl: videoProcessingService.currentCctvUrl,
                isRunning: !!videoProcessingService.streamLoopInterval,
                chunkDuration: config.CHUNK_DURATION_SECONDS,
                outputFrameRate: config.OUTPUT_FRAME_RATE
            },
            queue: {
                length: videoProcessingService.chunkQueue.length,
                isProcessing: videoProcessingService.isProcessingQueue,
                oldestChunk: videoProcessingService.chunkQueue.length > 0 ? 
                    new Date(videoProcessingService.chunkQueue[0].timestamp).toISOString() : null,
                newestChunk: videoProcessingService.chunkQueue.length > 0 ? 
                    new Date(videoProcessingService.chunkQueue[videoProcessingService.chunkQueue.length - 1].timestamp).toISOString() : null
            },
            clients: {
                count: websocketService.getClientCount()
            },
            storage: {
                tempDirExists,
                tempDirPath: config.TEMP_CHUNK_DIR,
                tempFileCount,
                tempDirSizeMB: (tempDirSize / (1024 * 1024)).toFixed(2)
            },
            mlModel: {
                url: config.ML_MODEL_API_URL_CHUNK
            }
        });
    }
}

module.exports = new StreamController();