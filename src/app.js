const express = require('express');
const http = require('http');
const cors = require('cors');
const dotenv = require('dotenv');
const config = require('./config/config');
const websocketService = require('./websocket/websocketService');
const videoProcessingService = require('./services/videoProcessingService');
const streamRoutes = require('./routes/streamRoutes');
const dbConfig = require('./config/dbConfig');
const userRoutes = require('./routes/userRoutes');

dotenv.config();


const app = express();
app.use(cors());
app.use(express.json());

// Connect to MongoDB
dbConfig.run();

// Routes
// app.use('/api/stream', streamRoutes);
app.use('/api/user', userRoutes);

app.get('/', (req, res) => {
    res.send('Hello World!');
});

// const server = http.createServer(app);

// // Initialize WebSocket
// websocketService.initialize(server);

// // Set up the video processing service reference for automatic stream management
// websocketService.setVideoProcessingService(videoProcessingService);

// // Setup graceful shutdown
// function gracefulShutdown() {
//     console.log('Initiating graceful shutdown...');
//     videoProcessingService.stopStreamLoop();
//     videoProcessingService.cleanup();
//     websocketService.close();
    
//     server.close(() => {
//         console.log('Server shut down gracefully.');
//         process.exit(0);
//     });

//     setTimeout(() => {
//         console.error('Graceful shutdown timed out. Forcing exit.');
//         process.exit(1);
//     }, 30000);
// }

// process.on('SIGINT', gracefulShutdown);
// process.on('SIGTERM', gracefulShutdown);

server.listen(config.PORT, () => {
    console.log(`Backend server listening on http://localhost:${config.PORT}`);
});

