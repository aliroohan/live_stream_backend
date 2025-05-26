const path = require('path');

module.exports = {
    PORT: process.env.PORT || 3000,
    ML_MODEL_API_URL_CHUNK: 'http://localhost:5000/process_video_chunk',
    CHUNK_DURATION_SECONDS: 10,
    OUTPUT_FRAME_RATE: 10,
    TEMP_CHUNK_DIR: path.join(__dirname, '../../temp_chunks'),
    WEBSOCKET: {
        PING_INTERVAL: 30000,
        PING_TIMEOUT: 5000
    }
}; 