const { 
    default: makeWASocket, 
    useMultiFileAuthState, 
    DisconnectReason, 
    jidNormalizedUser,
    getContentType 
} = require('@whiskeysockets/baileys');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const express = require('express');
const multer = require('multer');
const QRCode = require('qrcode');
const pino = require('pino');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const FormData = require('form-data');
const mimeTypes = require('mime-types');
const sharp = require('sharp');

// Initialize Express app
const app = express();
app.use(express.json());
app.use(express.static('public'));

// Configure multer for file uploads
const upload = multer({
    dest: './uploads/',
    limits: { fileSize: 10 * 1024 * 1024 }, // 10MB limit
    fileFilter: (req, file, cb) => {
        const allowedTypes = /jpeg|jpg|png|gif|mp4|mov|avi|pdf|doc|docx/;
        const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
        const mimetype = allowedTypes.test(file.mimetype);
        
        if (mimetype && extname) {
            return cb(null, true);
        } else {
            cb(new Error('Invalid file type'));
        }
    }
});

// Initialize Google AI
const genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY || 'your-google-api-key');
const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });

// Global variables
let sock;
let qrCodeString = '';
let connectionState = 'disconnected';
let retryCount = 0;
const maxRetries = 5;
const retryDelay = 5000; // 5 seconds

// Logger configuration
const logger = pino({ 
    level: process.env.LOG_LEVEL || 'info',
    transport: {
        target: 'pino-pretty',
        options: {
            colorize: true,
            translateTime: 'SYS:standard'
        }
    }
});

// Ensure directories exist
const ensureDirectoriesExist = () => {
    const dirs = ['./auth_info_baileys', './uploads', './public'];
    dirs.forEach(dir => {
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
            logger.info(`Created directory: ${dir}`);
        }
    });
};

// Initialize WhatsApp connection
const initializeWhatsApp = async () => {
    try {
        ensureDirectoriesExist();
        
        // Get authentication state
        const { state, saveCreds } = await useMultiFileAuthState('./auth_info_baileys');
        
        // Create socket connection with proper configuration
        sock = makeWASocket({
            auth: state,
            printQRInTerminal: false, // We'll handle QR code display manually
            logger: pino({ level: 'silent' }), // Reduce noise in logs
            browser: ['WhatsApp Bot', 'Chrome', '10.0'], // Proper browser identification
            defaultQueryTimeoutMs: 60000, // 60 second timeout
            keepAliveIntervalMs: 30000, // Keep alive every 30 seconds
            markOnlineOnConnect: true,
            syncFullHistory: false, // Don't sync full chat history
            generateHighQualityLinkPreview: true,
            getMessage: async (key) => {
                // Handle message retrieval for message reactions/replies
                return { conversation: 'Message not found' };
            }
        });

        // Handle credential updates
        sock.ev.on('creds.update', saveCreds);

        // Handle connection updates with proper QR code generation
        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr, receivedPendingNotifications } = update;
            
            logger.info('Connection update:', { connection, qr: !!qr });
            connectionState = connection || 'unknown';

            // Handle QR code display
            if (qr) {
                try {
                    // Generate QR code for terminal
                    const qrTerminal = await QRCode.toString(qr, { 
                        type: 'terminal',
                        errorCorrectionLevel: 'M',
                        width: 50,
                        margin: 2
                    });
                    
                    // Generate QR code as data URL for web display
                    const qrDataUrl = await QRCode.toDataURL(qr, {
                        errorCorrectionLevel: 'M',
                        type: 'image/png',
                        quality: 0.92,
                        margin: 1,
                        color: {
                            dark: '#000000FF',
                            light: '#FFFFFFFF'
                        },
                        width: 300
                    });
                    
                    qrCodeString = qrDataUrl;
                    
                    console.log('\n' + '='.repeat(60));
                    console.log('📱 SCAN THIS QR CODE WITH YOUR WHATSAPP:');
                    console.log('='.repeat(60));
                    console.log(qrTerminal);
                    console.log('='.repeat(60));
                    console.log('🌐 Or visit: http://localhost:3000/qr to see QR code in browser');
                    console.log('='.repeat(60) + '\n');
                    
                    // Reset retry count on new QR
                    retryCount = 0;
                    
                } catch (error) {
                    logger.error('Error generating QR code:', error);
                    console.log('\n❌ Error generating QR code. Please restart the application.\n');
                }
            }

            // Handle successful connection
            if (connection === 'open') {
                logger.info('✅ WhatsApp connection opened successfully');
                console.log('\n🎉 WhatsApp Bot is now connected and ready!');
                console.log('📱 You can now send messages to your bot.\n');
                retryCount = 0;
                qrCodeString = ''; // Clear QR code
            }

            // Handle connection close/failure
            if (connection === 'close') {
                const shouldReconnect = (lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
                const reason = lastDisconnect?.error?.output?.statusCode;
                
                logger.info('Connection closed:', {
                    reason: reason,
                    shouldReconnect: shouldReconnect,
                    retryCount: retryCount
                });

                if (shouldReconnect && retryCount < maxRetries) {
                    retryCount++;
                    const delay = retryDelay * retryCount; // Exponential backoff
                    
                    console.log(`\n⏳ Connection lost. Retrying in ${delay/1000} seconds... (Attempt ${retryCount}/${maxRetries})`);
                    
                    setTimeout(() => {
                        initializeWhatsApp();
                    }, delay);
                } else if (reason === DisconnectReason.loggedOut) {
                    console.log('\n🚪 Device logged out. Please delete auth_info_baileys folder and restart.');
                    logger.info('Device logged out, cleaning auth state');
                    // Clean auth state
                    try {
                        if (fs.existsSync('./auth_info_baileys')) {
                            fs.rmSync('./auth_info_baileys', { recursive: true, force: true });
                        }
                    } catch (error) {
                        logger.error('Error cleaning auth state:', error);
                    }
                    process.exit(1);
                } else {
                    console.log('\n❌ Max retry attempts reached. Please restart the application.');
                    logger.error('Max retry attempts reached');
                    process.exit(1);
                }
            }
        });

        // Handle incoming messages
        sock.ev.on('messages.upsert', async (m) => {
            try {
                const message = m.messages[0];
                if (!message.key.fromMe && m.type === 'notify') {
                    await handleIncomingMessage(message);
                }
            } catch (error) {
                logger.error('Error handling incoming message:', error);
            }
        });

        // Handle group updates
        sock.ev.on('groups.update', (updates) => {
            logger.info('Group updates:', updates.length);
        });

        // Handle presence updates
        sock.ev.on('presence.update', ({ id, presences }) => {
            logger.debug('Presence update:', { id, presences });
        });

        // Handle contacts update
        sock.ev.on('contacts.update', (update) => {
            logger.debug('Contacts update:', update.length);
        });

    } catch (error) {
        logger.error('Error initializing WhatsApp:', error);
        console.log('\n❌ Failed to initialize WhatsApp connection. Please check your configuration.');
        
        // Retry after delay
        if (retryCount < maxRetries) {
            retryCount++;
            const delay = retryDelay * retryCount;
            console.log(`⏳ Retrying in ${delay/1000} seconds... (Attempt ${retryCount}/${maxRetries})`);
            setTimeout(() => {
                initializeWhatsApp();
            }, delay);
        } else {
            console.log('❌ Max retry attempts reached. Exiting...');
            process.exit(1);
        }
    }
};

// Handle incoming messages
const handleIncomingMessage = async (message) => {
    try {
        const from = message.key.remoteJid;
        const messageType = getContentType(message.message);
        let messageText = '';

        // Extract message text based on type
        switch (messageType) {
            case 'conversation':
                messageText = message.message.conversation;
                break;
            case 'extendedTextMessage':
                messageText = message.message.extendedTextMessage.text;
                break;
            case 'imageMessage':
                messageText = message.message.imageMessage.caption || 'Image received';
                break;
            case 'videoMessage':
                messageText = message.message.videoMessage.caption || 'Video received';
                break;
            case 'documentMessage':
                messageText = `Document received: ${message.message.documentMessage.fileName || 'Unknown'}`;
                break;
            default:
                messageText = 'Unsupported message type';
        }

        logger.info('Received message:', { from, messageType, text: messageText.substring(0, 50) });

        // Send typing indicator
        await sock.sendPresenceUpdate('composing', from);

        // Generate AI response
        const aiResponse = await generateAIResponse(messageText, messageType, message);

        // Send typing indicator off
        await sock.sendPresenceUpdate('paused', from);

        // Send response
        if (aiResponse) {
            await sock.sendMessage(from, { text: aiResponse });
            logger.info('Response sent successfully');
        }

    } catch (error) {
        logger.error('Error handling message:', error);
        try {
            await sock.sendMessage(message.key.remoteJid, { 
                text: 'Sorry, I encountered an error processing your message. Please try again.' 
            });
        } catch (sendError) {
            logger.error('Error sending error message:', sendError);
        }
    }
};

// Generate AI response using Google Gemini
const generateAIResponse = async (messageText, messageType, originalMessage) => {
    try {
        let prompt = `You are a helpful WhatsApp AI assistant. 
        User message: "${messageText}"
        Message type: ${messageType}
        
        Please provide a helpful, concise response (max 500 characters):`;

        const result = await model.generateContent(prompt);
        const response = await result.response;
        return response.text();

    } catch (error) {
        logger.error('Error generating AI response:', error);
        return 'Hello! I received your message but encountered an issue generating a response. Please try again.';
    }
};

// Express routes
app.get('/', (req, res) => {
    res.send(`
        
        
        
            WhatsApp Bot Status
            
            
            
                body { font-family: Arial, sans-serif; max-width: 800px; margin: 0 auto; padding: 20px; background: #f5f5f5; }
                .container { background: white; padding: 30px; border-radius: 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
                .status { padding: 15px; border-radius: 5px; margin: 20px 0; font-weight: bold; }
                .connected { background: #d4edda; color: #155724; border: 1px solid #c3e6cb; }
                .disconnected { background: #f8d7da; color: #721c24; border: 1px solid #f5c6cb; }
                .pending { background: #fff3cd; color: #856404; border: 1px solid #ffeaa7; }
                .button { display: inline-block; padding: 10px 20px; background: #007bff; color: white; text-decoration: none; border-radius: 5px; margin: 10px 0; }
                .button:hover { background: #0056b3; }
                h1 { color: #333; text-align: center; }
                .info { background: #e7f3ff; padding: 15px; border-left: 4px solid #007bff; margin: 20px 0; }
            
        
        
            
                🤖 WhatsApp Bot Control Panel
                
                
                    📊 Status: ${connectionState.toUpperCase()}
                
                
                
                    📱 Bot Information:
                    • Connection State: ${connectionState}
                    • Retry Count: ${retryCount}/${maxRetries}
                    • QR Code Available: ${qrCodeString ? 'Yes' : 'No'}
                
                
                📱 View QR Code
                🔄 Refresh Status
                
                
                    📋 Instructions:
                    1. If status shows "disconnected", click "View QR Code"
                    2. Scan the QR code with WhatsApp on your phone
                    3. Go to WhatsApp > Settings > Linked Devices > Link a Device
                    4. Scan the QR code displayed on this page
                    5. Wait for connection confirmation
                
            
            
                // Auto-refresh every 10 seconds
                setTimeout(() => window.location.reload(), 10000);
            
        

        
    `);
});

// Function to get status CSS class
const getStatusClass = () => {
    switch (connectionState) {
        case 'open': return 'connected';
        case 'connecting': return 'pending';
        case 'close':
        case 'disconnected': return 'disconnected';
        default: return 'pending';
    }
};

app.get('/qr', (req, res) => {
    if (!qrCodeString) {
        res.send(`
            
            
            
                QR Code - WhatsApp Bot
                
                
                
                    body { font-family: Arial, sans-serif; text-align: center; background: #f5f5f5; padding: 20px; }
                    .container { background: white; padding: 30px; border-radius: 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); max-width: 500px; margin: 0 auto; }
                    .warning { background: #fff3cd; color: #856404; padding: 15px; border-radius: 5px; border: 1px solid #ffeaa7; margin: 20px 0; }
                
            
            
                
                    📱 QR Code Scanner
                    
                        ⚠️ No QR code available at the moment.
                        The bot might already be connected or is in the process of connecting.
                    
                    Current Status: ${connectionState}
                    ← Back to Status
                
                
                    // Auto-refresh every 5 seconds
                    setTimeout(() => window.location.reload(), 5000);
                
            
            
        `);
    } else {
        res.send(`
            
            
            
                QR Code - WhatsApp Bot
                
                
                
                    body { font-family: Arial, sans-serif; text-align: center; background: #f5f5f5; padding: 20px; }
                    .container { background: white; padding: 30px; border-radius: 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); max-width: 500px; margin: 0 auto; }
                    .qr-code { margin: 20px 0; }
                    .instructions { background: #e7f3ff; padding: 15px; border-left: 4px solid #007bff; margin: 20px 0; text-align: left; }
                    .step { margin: 10px 0; }
                
            
            
                
                    📱 Scan QR Code
                    
                        
                    
                    
                    
                        📋 How to connect:
                        1. Open WhatsApp on your phone
                        2. Go to Settings → Linked Devices
                        3. Tap "Link a Device"
                        4. Scan this QR code
                        5. Wait for connection confirmation
                    
                    
                    ← Back to Status
                
                
                    // Auto-refresh every 30 seconds (QR codes expire)
                    setTimeout(() => window.location.reload(), 30000);
                
            
            
        `);
    }
});

app.get('/status', (req, res) => {
    res.json({
        status: connectionState,
        hasQR: !!qrCodeString,
        retryCount: retryCount,
        maxRetries: maxRetries,
        timestamp: new Date().toISOString()
    });
});

// File upload endpoint
app.post('/upload', upload.single('file'), (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'No file uploaded' });
        }

        res.json({
            message: 'File uploaded successfully',
            filename: req.file.filename,
            originalname: req.file.originalname,
            size: req.file.size,
            mimetype: req.file.mimetype
        });
    } catch (error) {
        logger.error('Upload error:', error);
        res.status(500).json({ error: 'Upload failed' });
    }
});

// Graceful shutdown handling
const gracefulShutdown = (signal) => {
    console.log(`\n📴 Received ${signal}. Shutting down gracefully...`);
    
    if (sock) {
        try {
            sock.end();
        } catch (error) {
            logger.error('Error closing socket:', error);
        }
    }
    
    // Close server
    server.close(() => {
        console.log('🔴 Server closed successfully');
        process.exit(0);
    });
    
    // Force close after 10 seconds
    setTimeout(() => {
        console.log('⚠️  Forced shutdown');
        process.exit(1);
    }, 10000);
};

// Handle process signals
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
    logger.error('Uncaught Exception:', error);
    gracefulShutdown('uncaughtException');
});

process.on('unhandledRejection', (reason, promise) => {
    logger.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

// Start the application
const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => {
    console.log('\n' + '='.repeat(60));
    console.log('🚀 WhatsApp Bot Server Starting...');
    console.log('='.repeat(60));
    console.log(`📊 Server running on: http://localhost:${PORT}`);
    console.log(`📱 QR Code page: http://localhost:${PORT}/qr`);
    console.log(`🔧 Status API: http://localhost:${PORT}/status`);
    console.log('='.repeat(60));
    console.log('⏳ Initializing WhatsApp connection...\n');
    
    // Initialize WhatsApp connection
    initializeWhatsApp();
});

module.exports = { app, sock };
