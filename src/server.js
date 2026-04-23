import express from 'express'
import { createServer } from 'http'
import { Server } from 'socket.io'
import cors from 'cors'
import connectDB from './db/connection.js'
import config from './config/index.js'
import { initializeSocketHandlers } from './socket/handlers.js'
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js'
import { setIO } from './utils/ioInstance.js'

// Import routes
import authRoutes from './routes/auth.js'
import userRoutes from './routes/user.js'
import conversationRoutes from './routes/conversation.js'
import messageRoutes from './routes/message.js'

const app = express()

const devLocalhostOriginPattern = /^https?:\/\/(localhost|127\.0\.0\.1|192\.168\.\d{1,3}\.\d{1,3})(:\d+)?$/i

const isAllowedOrigin = (origin) => {
  if (!origin) return true

  if (Array.isArray(config.frontendOrigins) && config.frontendOrigins.includes(origin)) {
    return true
  }

  if (origin === config.frontendUrl) {
    return true
  }

  if (config.nodeEnv !== 'production' && devLocalhostOriginPattern.test(origin)) {
    return true
  }

  return false
}

const corsOriginHandler = (origin, callback) => {
  if (isAllowedOrigin(origin)) {
    callback(null, true)
    return
  }

  callback(new Error(`Origin ${origin} is not allowed by CORS`))
}

const httpServer = createServer(app)
const io = new Server(httpServer, {
  cors: {
    origin: corsOriginHandler,
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    credentials: true,
  },
})

// Set global io instance to avoid circular imports
setIO(io)
console.log('✅ Socket.IO instance set globally')

// Middleware
app.use(
  cors({
    origin: corsOriginHandler,
    credentials: true,
  })
)

app.use(express.json())
app.use(express.urlencoded({ extended: true }))

// Health check
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'OK' })
})

// API Routes
app.use('/api/auth', authRoutes)
app.use('/api/users', userRoutes)
app.use('/api/conversations', conversationRoutes)
app.use('/api/messages', messageRoutes)

// Socket.IO
initializeSocketHandlers(io)

// Error handling
app.use(notFoundHandler)
app.use(errorHandler)

// Connect to database and start server
const startServer = async () => {
  try {
    await connectDB()

    httpServer.listen(config.port, '0.0.0.0', () => {
      console.log(`
        🚀 Server is running!
        📍 Port: ${config.port}
        🌍 Environment: ${config.nodeEnv}
        💾 Database: AWS DynamoDB (${config.awsRegion})
      `)
    })
  } catch (err) {
    console.error('Failed to start server:', err)
    process.exit(1)
  }
}

startServer()

export { app }
