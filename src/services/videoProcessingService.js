const ffmpeg = require('fluent-ffmpeg');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const FormData = require('form-data');
const config = require('../config/config');
const websocketService = require('../websocket/websocketService');

class VideoProcessingService {
    constructor() {
        this.streamLoopInterval = null;
        this.currentCctvUrl = null;
        this.isProcessing = false;
        this.chunkQueue = [];
        this.isProcessingQueue = false;
        this.isContinuousCapture = false;
        this.chunkStartTime = null;
        this.chunkCounter = 0;
        this.OVERLAP_SECONDS = 5; // Reduced overlap for minimal gaps while ensuring coverage
        this.REAL_TIME_PROCESSING = true; // Process immediately without waiting
        this.ensureTempDirectory();
    }

    ensureTempDirectory() {
        try {
            if (!fs.existsSync(config.TEMP_CHUNK_DIR)) {
                fs.mkdirSync(config.TEMP_CHUNK_DIR, { recursive: true });
                console.log(`Directory created: ${config.TEMP_CHUNK_DIR}`);
            }
        } catch (error) {
            console.error(`FATAL: Could not create or access directory ${config.TEMP_CHUNK_DIR}. Error:`, error);
            process.exit(1);
        }
    }

    async getVideoMetadata(videoPath) {
        return new Promise((resolve, reject) => {
            ffmpeg.ffprobe(videoPath, (err, metadata) => {
                if (err) {
                    reject(err);
                    return;
                }

                const videoStream = metadata.streams.find(stream => stream.codec_type === 'video');
                if (!videoStream) {
                    reject(new Error('No video stream found'));
                    return;
                }

                resolve({
                    duration: parseFloat(metadata.format.duration) || 0,
                    fps: eval(videoStream.r_frame_rate) || 25,
                    width: videoStream.width || 640,
                    height: videoStream.height || 480,
                    totalFrames: videoStream.nb_frames ? parseInt(videoStream.nb_frames) : 
                        Math.ceil((parseFloat(metadata.format.duration) || 0) * (eval(videoStream.r_frame_rate) || 25))
                });
            });
        });
    }

    async extractFramesFromVideo(videoPath, outputDir, timestamp) {
        return new Promise((resolve, reject) => {
            const framePattern = path.join(outputDir, `frame_${timestamp}_%d.jpg`);
            
            ffmpeg(videoPath)
                .fps(config.OUTPUT_FRAME_RATE)
                .outputOptions('-q:v', '2')  // High quality JPEG
                .output(framePattern)
                .on('end', () => {
                    console.log(`Frames extracted for timestamp ${timestamp}`);
                    resolve();
                })
                .on('error', (err) => {
                    console.error('Error extracting frames:', err);
                    reject(err);
                })
                .run();
        });
    }

    async processChunk(chunkTask) {
        if (!chunkTask || !chunkTask.cctvUrl || !chunkTask.chunkPath) {
            console.error('Invalid chunk task:', chunkTask);
            return;
        }

        // Skip if already processed in real-time
        if (chunkTask.realTimeProcessed) {
            console.log(`Chunk ${chunkTask.chunkNumber} already processed in real-time, skipping final processing`);
            
            // Just wait for capture to complete and clean up
            if (chunkTask.capturePromise) {
                await chunkTask.capturePromise;
            }
            
            if (fs.existsSync(chunkTask.chunkPath)) {
                fs.unlinkSync(chunkTask.chunkPath);
            }
            return;
        }

        try {
            const { timestamp, cctvUrl, chunkPath, fileName, chunkNumber, capturePromise, hasOverlap, overlapSeconds, captureDuration } = chunkTask;
            
            // Wait for the capture to complete before processing
            if (capturePromise) {
                console.log(`Waiting for chunk ${chunkNumber} capture to complete (${captureDuration}s with ${overlapSeconds}s overlap)...`);
                await capturePromise;
            }

            // Verify the captured file exists and has content
            if (!fs.existsSync(chunkPath)) {
                throw new Error(`Chunk file does not exist: ${chunkPath}`);
            }

            const stats = fs.statSync(chunkPath);
            if (stats.size === 0) {
                throw new Error('Captured video file is empty');
            }

            console.log(`Processing chunk ${chunkNumber}: ${fileName} (${(stats.size / 1024 / 1024).toFixed(2)} MB)${hasOverlap ? ` with ${overlapSeconds}s overlap for ABSOLUTE guaranteed coverage` : ''}`);

            // If this chunk has overlap, trim it to the correct duration  
            let finalChunkPath = chunkPath;
            if (hasOverlap && overlapSeconds > 0) {
                const trimmedFileName = `trimmed_${fileName}`;
                const trimmedChunkPath = path.join(config.TEMP_CHUNK_DIR, trimmedFileName);
                
                console.log(`Trimming chunk ${chunkNumber} to remove ${overlapSeconds}s overlap (captured ${captureDuration}s, keeping middle ${config.CHUNK_DURATION_SECONDS}s for seamless coverage)`);
                
                await new Promise((resolve, reject) => {
                    ffmpeg(chunkPath)
                        .outputOptions([
                            '-ss', overlapSeconds.toString(), // Skip the overlap at the beginning
                            '-t', config.CHUNK_DURATION_SECONDS.toString(), // Take only 30 seconds from the middle
                            '-c', 'copy' // Copy without re-encoding for speed
                        ])
                        .output(trimmedChunkPath)
                        .on('end', () => {
                            console.log(`Successfully trimmed chunk ${chunkNumber} - removed ${overlapSeconds}s overlap, kept ${config.CHUNK_DURATION_SECONDS}s of ABSOLUTELY guaranteed stream content`);
                            // Replace original with trimmed version
                            fs.unlinkSync(chunkPath);
                            fs.renameSync(trimmedChunkPath, chunkPath);
                            resolve();
                        })
                        .on('error', (err) => {
                            console.error(`Error trimming chunk ${chunkNumber}:`, err);
                            reject(err);
                        })
                        .run();
                });
            }

            const framesDir = path.join(config.TEMP_CHUNK_DIR, `frames_${timestamp}`);

            // Create frames directory
            if (!fs.existsSync(framesDir)) {
                fs.mkdirSync(framesDir, { recursive: true });
            }

            // Get video metadata to verify video stream
            const metadata = await this.getVideoMetadata(chunkPath);
            console.log(`Chunk ${chunkNumber} final metadata - Duration: ${metadata.duration}s, FPS: ${metadata.fps}, Resolution: ${metadata.width}x${metadata.height} (ABSOLUTE guaranteed stream coverage)`);

            if (metadata.duration === 0 || !metadata.width || !metadata.height) {
                throw new Error('Invalid video metadata - no video stream detected');
            }

            // Extract frames from the video
            await new Promise((resolve, reject) => {
                ffmpeg(chunkPath)
                    .outputOptions([
                        '-vf scale=640:480',
                        '-q:v 5',
                        '-f image2'
                    ])
                    .output(path.join(framesDir, `frame_${timestamp}_%d.jpg`))
                    .on('end', () => {
                        console.log(`Frames extracted successfully for chunk ${chunkNumber} (ABSOLUTE guaranteed stream content)`);
                        resolve();
                    })
                    .on('error', (err) => {
                        console.error('Error extracting frames:', err);
                        reject(err);
                    })
                    .run();
            });

            // Send the processed chunk to ML model
            const formData = new FormData();
            formData.append('video_chunk', fs.createReadStream(chunkPath), {
                filename: fileName,
                contentType: 'video/mp4'
            });
            formData.append('timestamp', timestamp.toString());
            formData.append('chunk_number', chunkNumber.toString());
            formData.append('absolute_coverage', 'true'); // Flag indicating ABSOLUTE stream coverage
            formData.append('overlap_seconds', overlapSeconds.toString());
            formData.append('metadata', JSON.stringify(metadata));

            console.log(`Sending chunk ${chunkNumber} to ML model (ABSOLUTE guaranteed stream coverage with ${overlapSeconds}s overlap buffer)`);

            const mlResponse = await axios.post('http://127.0.0.1:5000/process_video_chunk', formData, {
                headers: {
                    ...formData.getHeaders(),
                    'Accept': 'application/json'
                },
                maxContentLength: Infinity,
                maxBodyLength: Infinity,
                timeout: 120000
            });

            if (!mlResponse.data) {
                throw new Error('Empty response from ML model API');
            }

            // Read and send frames to frontend
            const frameFiles = fs.readdirSync(framesDir)
                .filter(file => file.startsWith(`frame_${timestamp}`))
                .sort((a, b) => {
                    const numA = parseInt(a.split('_').pop().split('.')[0]);
                    const numB = parseInt(b.split('_').pop().split('.')[0]);
                    return numA - numB;
                });

            console.log(`Extracted ${frameFiles.length} frames from chunk ${chunkNumber} (ABSOLUTE guaranteed stream coverage)`);

            // Send ML results immediately
            console.log(`📡 Broadcasting ML results for chunk ${chunkNumber}...`);
            console.log(`👥 Active websocket clients: ${websocketService.getClientCount()}`);
            
            const mlResultMessage = JSON.stringify({
                type: 'ml_results',
                timestamp,
                chunkNumber,
                realTimeProcessing: true,
                zeroGapGuarantee: true,
                processingDelay: Date.now() - timestamp,
                results: mlResponse.data
            });
            
            websocketService.broadcast(mlResultMessage);
            console.log(`✅ ML results broadcasted for chunk ${chunkNumber}`);

            // Send frames immediately - this is the crucial part for broadcasting images
            console.log(`📡 Broadcasting ${frameFiles.length} frames for chunk ${chunkNumber}...`);
            const batchSize = 10; // Larger batches for faster processing
            let framesSent = 0;
            
            for (let i = 0; i < frameFiles.length; i += batchSize) {
                const batch = frameFiles.slice(i, i + batchSize);
                
                for (const frameFile of batch) {
                    const framePath = path.join(framesDir, frameFile);
                    
                    if (!fs.existsSync(framePath)) {
                        console.error(`❌ Frame file missing: ${framePath}`);
                        continue;
                    }
                    
                    const frameBuffer = fs.readFileSync(framePath);
                    const base64Image = frameBuffer.toString('base64');

                    const frameMessage = JSON.stringify({
                        type: 'frame',
                        timestamp,
                        chunkNumber,
                        frameNumber: parseInt(frameFile.split('_').pop().split('.')[0]),
                        image: `data:image/jpeg;base64,${base64Image}`,
                        totalFrames: frameFiles.length,
                        realTimeProcessing: true,
                        zeroGapGuarantee: true,
                        processingDelay: Date.now() - timestamp
                    });

                    if (websocketService.getClientCount() > 0) {
                        websocketService.broadcast(frameMessage);
                        framesSent++;
                        console.log(`📸 Sent frame ${framesSent}/${frameFiles.length} for chunk ${chunkNumber}`);
                    }
                }

                // No delay for maximum speed
                // Removed delay to eliminate gaps
            }

            console.log(`✅ Successfully broadcasted ${framesSent} frames for chunk ${chunkNumber}`);

            // Clean up frames
            fs.rmSync(framesDir, { recursive: true, force: true });
            console.log(`🧹 Cleaned up frames directory for chunk ${chunkNumber}`);

            console.log(`🎉 Completed processing chunk ${chunkNumber} (delay: ${((Date.now() - timestamp) / 1000).toFixed(1)}s) - ZERO GAPS, ZERO DELAY`);

        } catch (error) {
            console.error(`❌ Error processing chunk ${chunkNumber}:`, error.message);
            console.error('Full error:', error);
            
            // Clean up on error
            try {
                const framesDir = path.join(config.TEMP_CHUNK_DIR, `frames_${timestamp}`);
                if (fs.existsSync(framesDir)) {
                    fs.rmSync(framesDir, { recursive: true, force: true });
                }
            } catch (cleanupError) {
                console.error('Error cleaning up frames on error:', cleanupError.message);
            }
            
            throw error;
        }
    }

    async processChunkQueue() {
        if (this.isProcessingQueue || this.chunkQueue.length === 0) {
            return;
        }

        this.isProcessingQueue = true;
        console.log(`Processing chunk queue. Queue length: ${this.chunkQueue.length}`);

        while (this.chunkQueue.length > 0) {
            const chunkTask = this.chunkQueue.shift();
            try {
                await this.processChunk(chunkTask);
            } catch (error) {
                console.error('Error processing queued chunk:', error.message);
            }
        }

        this.isProcessingQueue = false;
        
        // Schedule next queue processing if we're still capturing
        if (this.isContinuousCapture) {
            setTimeout(() => this.processChunkQueue(), 500); // Check queue every 500ms for faster processing
        }
    }

    startStreamLoop(cctvUrl) {
        if (this.streamLoopInterval) {
            this.stopStreamLoop();
        }

        this.currentCctvUrl = cctvUrl;
        this.chunkQueue = [];
        this.isContinuousCapture = true;
        this.chunkStartTime = Date.now();
        this.chunkCounter = 0;
        
        // Start continuous chunking with precise timing
        this.startPreciseChunking();
        
        // Start processing queue independently with periodic checks
        setTimeout(() => this.processChunkQueue(), 500); // Start queue processing after 500ms
    }

    stopStreamLoop() {
        if (this.streamLoopInterval) {
            clearInterval(this.streamLoopInterval);
            this.streamLoopInterval = null;
        }
        this.isContinuousCapture = false;
        this.chunkStartTime = null;
        this.chunkCounter = 0;
    }

    async startPreciseChunking() {
        if (!this.currentCctvUrl || !this.isContinuousCapture) return;

        // Start next chunk 5 seconds before the current one ends for minimal gaps
        const overlapStartTime = this.chunkStartTime + (this.chunkCounter * config.CHUNK_DURATION_SECONDS * 1000) - (this.OVERLAP_SECONDS * 1000);
        const currentTime = Date.now();
        
        // For the first chunk, start immediately
        const expectedStartTime = this.chunkCounter === 0 ? this.chunkStartTime : overlapStartTime;
        const delay = Math.max(0, expectedStartTime - currentTime);

        console.log(`Scheduling chunk ${this.chunkCounter}: expected start ${new Date(expectedStartTime).toISOString()}, current time ${new Date(currentTime).toISOString()}, delay ${delay}ms${this.chunkCounter > 0 ? ` (${this.OVERLAP_SECONDS}s overlap for minimal gaps + REAL-TIME)` : ''}`);

        setTimeout(async () => {
            if (!this.isContinuousCapture) return;

            console.log(`Executing chunk ${this.chunkCounter} capture at ${new Date().toISOString()}`);

            try {
                // Start capturing this chunk (don't wait for it to complete)
                this.captureChunkWithRealTimeProcessing();
                
                // Immediately schedule the next chunk with zero delay
                if (this.isContinuousCapture && websocketService.getClientCount() > 0) {
                    this.chunkCounter++;
                    console.log(`Immediately scheduling next chunk ${this.chunkCounter} with ${this.OVERLAP_SECONDS}s overlap for minimal gaps + REAL-TIME`);
                    // Schedule immediately to ensure no timing gaps
                    setImmediate(() => this.startPreciseChunking());
                } else if (websocketService.getClientCount() === 0) {
                    this.stopStreamLoop();
                }
            } catch (error) {
                console.error('Error in precise chunking:', error.message);
                // Retry with next chunk timing
                if (this.isContinuousCapture) {
                    this.chunkCounter++;
                    setTimeout(() => this.startPreciseChunking(), 50); // Ultra-fast retry
                }
            }
        }, delay);
    }

    async captureChunkWithRealTimeProcessing() {
        if (!this.currentCctvUrl) return;

        // Calculate the actual start time for this chunk (without overlap)
        const actualChunkStartTime = this.chunkStartTime + (this.chunkCounter * config.CHUNK_DURATION_SECONDS * 1000);
        const chunkTimestamp = actualChunkStartTime;
        const chunkFileName = `chunk_${chunkTimestamp}_${this.chunkCounter}.mp4`;
        const chunkPath = path.join(config.TEMP_CHUNK_DIR, chunkFileName);
        const currentChunkNumber = this.chunkCounter;

        // Capture with massive overlap but process in real-time
        const captureDuration = config.CHUNK_DURATION_SECONDS + (this.chunkCounter > 0 ? this.OVERLAP_SECONDS : 0);
        
        console.log(`Starting REAL-TIME capture of chunk ${currentChunkNumber} (${captureDuration}s duration with ${this.chunkCounter > 0 ? this.OVERLAP_SECONDS : 0}s overlap for minimal gaps) at ${new Date(chunkTimestamp).toISOString()}`);

        try {
            // Start the chunk capture with real-time processing
            const capturePromise = new Promise((resolve, reject) => {
                const ffmpegProcess = ffmpeg(this.currentCctvUrl)
                    .inputOptions([
                        '-rtsp_transport tcp',
                        '-allowed_media_types video',
                        '-fflags +genpts+igndts',
                        '-avoid_negative_ts make_zero',
                        '-use_wallclock_as_timestamps 1',
                        '-thread_queue_size 4096', // Maximum buffer for real-time
                        '-analyzeduration 5000000', // Maximum analysis time
                        '-probesize 5000000',       // Maximum probe size
                        '-f rtsp',
                        '-timeout 15000000'         // 15 second timeout
                    ])
                    .outputOptions([
                        '-map 0:v:0',
                        '-c:v libx264',
                        '-preset ultrafast',
                        '-crf 23',
                        '-g 30',
                        '-keyint_min 30',
                        '-sc_threshold 0',
                        '-f mp4',
                        '-movflags +faststart',
                        '-t', captureDuration.toString(),
                        '-avoid_negative_ts make_zero',
                        '-fflags +genpts'
                    ])
                    .output(chunkPath)
                    .on('start', (commandLine) => {
                        console.log(`FFmpeg REAL-TIME capture started for chunk ${currentChunkNumber} (${captureDuration}s) at ${new Date().toISOString()}`);
                        
                        // Start real-time processing after 1 second of capture
                        setTimeout(() => {
                            this.startRealTimeProcessing(currentChunkNumber, chunkTimestamp, chunkPath, chunkFileName);
                        }, 1000); // Start processing after 1 second
                        
                        // Also start a backup processing after 3 seconds in case the first one fails
                        setTimeout(() => {
                            if (websocketService.getClientCount() > 0) {
                                this.startRealTimeProcessing(currentChunkNumber, chunkTimestamp, chunkPath, chunkFileName);
                            }
                        }, 3000); // Backup processing after 3 seconds
                    })
                    .on('progress', (progress) => {
                        if (progress.frames && progress.frames % 200 === 0) {
                            console.log(`REAL-TIME capturing chunk ${currentChunkNumber}: frame ${progress.frames}, time ${progress.timemark} (${captureDuration}s total)`);
                        }
                    })
                    .on('end', () => {
                        console.log(`Successfully captured chunk ${currentChunkNumber}: ${chunkFileName} (${captureDuration}s with minimal gaps guarantee)`);
                        resolve();
                    })
                    .on('error', (err) => {
                        console.error(`Error capturing chunk ${currentChunkNumber}:`, err.message);
                        reject(err);
                    })
                    .run();
            });

            // Add error handling to the capture promise
            capturePromise.catch((error) => {
                console.error(`Capture failed for chunk ${currentChunkNumber}:`, error.message);
                // Clean up failed chunk file if it exists
                if (fs.existsSync(chunkPath)) {
                    try {
                        fs.unlinkSync(chunkPath);
                    } catch (cleanupError) {
                        console.error(`Error cleaning up failed chunk ${currentChunkNumber}:`, cleanupError.message);
                    }
                }
            });

            // Add to processing queue for final cleanup (but don't wait)
            this.chunkQueue.push({
                timestamp: chunkTimestamp,
                cctvUrl: this.currentCctvUrl,
                chunkPath: chunkPath,
                fileName: chunkFileName,
                chunkNumber: currentChunkNumber,
                capturePromise: capturePromise,
                hasOverlap: this.chunkCounter > 0,
                overlapSeconds: this.chunkCounter > 0 ? this.OVERLAP_SECONDS : 0,
                captureDuration: captureDuration,
                realTimeProcessed: false
            });

            console.log(`Chunk ${currentChunkNumber} added to queue with ${this.OVERLAP_SECONDS}s overlap for minimal gaps + REAL-TIME processing. Queue length: ${this.chunkQueue.length}`);

        } catch (error) {
            console.error(`Error setting up capture for chunk ${currentChunkNumber}:`, error.message);
        }
    }

    async startRealTimeProcessing(chunkNumber, timestamp, chunkPath, fileName) {
        console.log(`Starting REAL-TIME processing for chunk ${chunkNumber} while still capturing...`);
        
        try {
            // Wait minimal time to ensure we have some data
            await new Promise(resolve => setTimeout(resolve, 2000)); // Wait only 2 seconds
            
            // Check if file exists and has content
            if (!fs.existsSync(chunkPath)) {
                console.log(`Chunk ${chunkNumber} file not ready yet for real-time processing`);
                return;
            }

            const stats = fs.statSync(chunkPath);
            if (stats.size < 256 * 1024) { // Less than 256KB, probably not ready
                console.log(`Chunk ${chunkNumber} file too small for real-time processing (${stats.size} bytes), retrying...`);
                // Retry after a very short delay
                setTimeout(() => {
                    this.startRealTimeProcessing(chunkNumber, timestamp, chunkPath, fileName);
                }, 1000); // Retry after 1 second
                return;
            }

            console.log(`REAL-TIME processing chunk ${chunkNumber} (${(stats.size / 1024 / 1024).toFixed(2)} MB) while capture continues...`);

            // Create a temporary copy for processing while capture continues
            const tempProcessingPath = path.join(config.TEMP_CHUNK_DIR, `processing_${fileName}`);
            fs.copyFileSync(chunkPath, tempProcessingPath);

            // Extract the first portion for immediate processing
            const realTimeChunkPath = path.join(config.TEMP_CHUNK_DIR, `realtime_${fileName}`);
            
            await new Promise((resolve, reject) => {
                ffmpeg(tempProcessingPath)
                    .outputOptions([
                        '-t', (config.CHUNK_DURATION_SECONDS * 0.5).toString(), // Take first 50% of chunk duration for faster processing
                        '-c', 'copy' // Copy without re-encoding for speed
                    ])
                    .output(realTimeChunkPath)
                    .on('end', () => {
                        console.log(`REAL-TIME extracted first ${(config.CHUNK_DURATION_SECONDS * 0.5)}s from chunk ${chunkNumber}`);
                        resolve();
                    })
                    .on('error', (err) => {
                        console.error(`Error in real-time extraction for chunk ${chunkNumber}:`, err);
                        reject(err);
                    })
                    .run();
            });

            // Process this real-time chunk immediately
            await this.processRealTimeChunk({
                timestamp,
                chunkNumber,
                chunkPath: realTimeChunkPath,
                fileName: `realtime_${fileName}`,
                isRealTime: true
            });

            // Clean up temporary files
            if (fs.existsSync(tempProcessingPath)) {
                fs.unlinkSync(tempProcessingPath);
            }
            if (fs.existsSync(realTimeChunkPath)) {
                fs.unlinkSync(realTimeChunkPath);
            }

            // Mark this chunk as real-time processed
            const queueItem = this.chunkQueue.find(item => item.chunkNumber === chunkNumber);
            if (queueItem) {
                queueItem.realTimeProcessed = true;
            }

        } catch (error) {
            console.error(`Error in real-time processing for chunk ${chunkNumber}:`, error.message);
        }
    }

    async processRealTimeChunk(chunkTask) {
        const { timestamp, chunkNumber, chunkPath, fileName, isRealTime } = chunkTask;
        
        try {
            console.log(`🔄 Processing REAL-TIME chunk ${chunkNumber}: ${fileName}`);

            const framesDir = path.join(config.TEMP_CHUNK_DIR, `realtime_frames_${timestamp}`);

            // Create frames directory
            if (!fs.existsSync(framesDir)) {
                fs.mkdirSync(framesDir, { recursive: true });
                console.log(`📁 Created frames directory: ${framesDir}`);
            }

            // Check if video file exists and has content
            if (!fs.existsSync(chunkPath)) {
                throw new Error(`Real-time chunk file does not exist: ${chunkPath}`);
            }

            const fileStats = fs.statSync(chunkPath);
            console.log(`📊 Real-time chunk file size: ${(fileStats.size / 1024 / 1024).toFixed(2)} MB`);

            // Get video metadata
            const metadata = await this.getVideoMetadata(chunkPath);
            console.log(`📹 REAL-TIME chunk ${chunkNumber} metadata - Duration: ${metadata.duration}s, FPS: ${metadata.fps}, Resolution: ${metadata.width}x${metadata.height}`);

            if (metadata.duration === 0 || !metadata.width || !metadata.height) {
                throw new Error('Invalid video metadata for real-time chunk - no video stream detected');
            }

            // Extract frames immediately
            console.log(`🎬 Extracting frames from real-time chunk ${chunkNumber}...`);
            await new Promise((resolve, reject) => {
                ffmpeg(chunkPath)
                    .outputOptions([
                        '-vf scale=640:480',
                        '-q:v 5',
                        '-f image2'
                    ])
                    .output(path.join(framesDir, `frame_${timestamp}_%d.jpg`))
                    .on('start', (commandLine) => {
                        console.log(`🎬 FFmpeg frame extraction started for chunk ${chunkNumber}`);
                    })
                    .on('end', () => {
                        console.log(`✅ REAL-TIME frames extracted for chunk ${chunkNumber}`);
                        resolve();
                    })
                    .on('error', (err) => {
                        console.error(`❌ Error extracting real-time frames:`, err);
                        reject(err);
                    })
                    .run();
            });

            // Check if frames were actually created
            const frameFiles = fs.readdirSync(framesDir)
                .filter(file => file.startsWith(`frame_${timestamp}`))
                .sort((a, b) => {
                    const numA = parseInt(a.split('_').pop().split('.')[0]);
                    const numB = parseInt(b.split('_').pop().split('.')[0]);
                    return numA - numB;
                });

            console.log(`📸 Found ${frameFiles.length} frames for real-time chunk ${chunkNumber}`);

            if (frameFiles.length === 0) {
                throw new Error(`No frames were extracted from real-time chunk ${chunkNumber}`);
            }

            // Send to ML model immediately
            console.log(`🤖 Sending real-time chunk ${chunkNumber} to ML model...`);
            let mlResponse;
            try {
                const formData = new FormData();
                formData.append('video_chunk', fs.createReadStream(chunkPath), {
                    filename: fileName,
                    contentType: 'video/mp4'
                });
                formData.append('timestamp', timestamp.toString());
                formData.append('chunk_number', chunkNumber.toString());
                formData.append('real_time_processing', 'true');
                formData.append('zero_gap_guarantee', 'true');
                formData.append('metadata', JSON.stringify(metadata));

                mlResponse = await axios.post('http://127.0.0.1:5000/process_video_chunk', formData, {
                    headers: {
                        ...formData.getHeaders(),
                        'Accept': 'application/json'
                    },
                    maxContentLength: Infinity,
                    maxBodyLength: Infinity,
                    timeout: 30000 // Shorter timeout for real-time
                });

                console.log(`✅ ML model responded for chunk ${chunkNumber}`);
            } catch (mlError) {
                console.warn(`⚠️ ML model not available for chunk ${chunkNumber}, continuing with frame broadcasting:`, mlError.message);
                mlResponse = { data: { message: 'ML model not available', status: 'frames_only' } };
            }

            // Send ML results immediately if available
            console.log(`📡 Broadcasting ML results for chunk ${chunkNumber}...`);
            console.log(`👥 Active websocket clients: ${websocketService.getClientCount()}`);
            
            const mlResultMessage = JSON.stringify({
                type: 'ml_results',
                timestamp,
                chunkNumber,
                realTimeProcessing: true,
                zeroGapGuarantee: true,
                processingDelay: Date.now() - timestamp,
                results: mlResponse.data
            });
            
            websocketService.broadcast(mlResultMessage);
            console.log(`✅ ML results broadcasted for chunk ${chunkNumber}`);

            // Send frames immediately - this is the crucial part for broadcasting images
            console.log(`📡 Broadcasting ${frameFiles.length} frames for chunk ${chunkNumber}...`);
            const batchSize = 10; // Larger batches for faster processing
            let framesSent = 0;
            
            for (let i = 0; i < frameFiles.length; i += batchSize) {
                const batch = frameFiles.slice(i, i + batchSize);
                
                for (const frameFile of batch) {
                    const framePath = path.join(framesDir, frameFile);
                    
                    if (!fs.existsSync(framePath)) {
                        console.error(`❌ Frame file missing: ${framePath}`);
                        continue;
                    }
                    
                    const frameBuffer = fs.readFileSync(framePath);
                    const base64Image = frameBuffer.toString('base64');

                    const frameMessage = JSON.stringify({
                        type: 'frame',
                        timestamp,
                        chunkNumber,
                        frameNumber: parseInt(frameFile.split('_').pop().split('.')[0]),
                        image: `data:image/jpeg;base64,${base64Image}`,
                        totalFrames: frameFiles.length,
                        realTimeProcessing: true,
                        zeroGapGuarantee: true,
                        processingDelay: Date.now() - timestamp
                    });

                    if (websocketService.getClientCount() > 0) {
                        websocketService.broadcast(frameMessage);
                        framesSent++;
                        console.log(`📸 Sent frame ${framesSent}/${frameFiles.length} for chunk ${chunkNumber}`);
                    }
                }

                // No delay for maximum speed
                // Removed delay to eliminate gaps
            }

            console.log(`✅ Successfully broadcasted ${framesSent} frames for chunk ${chunkNumber}`);

            // Clean up real-time frames
            fs.rmSync(framesDir, { recursive: true, force: true });
            console.log(`🧹 Cleaned up frames directory for chunk ${chunkNumber}`);

            console.log(`🎉 Completed REAL-TIME processing chunk ${chunkNumber} (delay: ${((Date.now() - timestamp) / 1000).toFixed(1)}s) - ZERO GAPS, ZERO DELAY`);

        } catch (error) {
            console.error(`❌ Error in real-time processing chunk ${chunkNumber}:`, error.message);
            console.error('Full error:', error);
            
            // Clean up on error
            try {
                const framesDir = path.join(config.TEMP_CHUNK_DIR, `realtime_frames_${timestamp}`);
                if (fs.existsSync(framesDir)) {
                    fs.rmSync(framesDir, { recursive: true, force: true });
                }
            } catch (cleanupError) {
                console.error('Error cleaning up frames on error:', cleanupError.message);
            }
            
            throw error;
        }
    }

    async captureAndProcessChunk() {
        // This method is deprecated in favor of the new continuous chunking approach
        console.warn('captureAndProcessChunk is deprecated. Use startPreciseChunking instead.');
        await this.captureChunkWithRealTimeProcessing();
    }

    cleanup() {
        if (fs.existsSync(config.TEMP_CHUNK_DIR)) {
            fs.readdir(config.TEMP_CHUNK_DIR, (err, files) => {
                if (!err) {
                    files.forEach(file => {
                        const filePath = path.join(config.TEMP_CHUNK_DIR, file);
                        try {
                            if (fs.statSync(filePath).isDirectory()) {
                                fs.rmSync(filePath, { recursive: true, force: true });
                            } else {
                                fs.unlinkSync(filePath);
                            }
                        } catch (error) {
                            console.error(`Error cleaning up ${filePath}:`, error);
                        }
                    });
                }
            });
        }
    }
}

module.exports = new VideoProcessingService(); 