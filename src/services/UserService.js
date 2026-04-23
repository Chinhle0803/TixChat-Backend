import UserRepository from '../repositories/UserRepository.js'
import conversationService from './ConversationService.js'
import { userEvents } from '../events/EventBus.js'
import { USER_EVENTS } from '../events/EventTypes.js'
import { hashPassword, comparePassword } from '../utils/passwordUtils.js'
import S3Service from './S3Service.js'

export class UserService {
  async getUserById(userId) {
    const user = await UserRepository.findById(userId, false)

    if (!user) {
      throw new Error('User not found')
    }

    return user
  }

  async getUserByUsername(username) {
    const user = await UserRepository.findByUsername(username, false)

    if (!user) {
      throw new Error('User not found')
    }

    return user
  }

  async updateProfile(userId, updateData) {
    const { fullName, displayName, bio, avatar } = updateData

    const updates = {}
    if (fullName !== undefined) updates.fullName = fullName
    if (displayName !== undefined) updates.fullName = displayName // Use displayName as fullName
    if (bio !== undefined) updates.bio = bio
    if (avatar !== undefined) updates.avatar = avatar

    const user = await UserRepository.update(userId, updates)

    // Emit event
    userEvents.emit(USER_EVENTS.PROFILE_UPDATED, {
      userId: user.userId,
      user: user,
    })

    return user
  }

  async searchUsers(query, limit = 10) {
    // Note: DynamoDB doesn't support full-text search like MongoDB
    // This is a limitation - you may want to implement ElasticSearch or similar
    const { users } = await UserRepository.getAll(limit)
    
    const filtered = users.filter(user => 
      user.username?.toLowerCase().includes(query.toLowerCase()) ||
      user.fullName?.toLowerCase().includes(query.toLowerCase())
    )

    return filtered.slice(0, limit)
  }

  async setOnlineStatus(userId, isOnline) {
    const user = await UserRepository.update(userId, {
      isOnline,
      lastSeen: Date.now(),
    })

    const eventType = isOnline ? USER_EVENTS.ONLINE : USER_EVENTS.OFFLINE

    userEvents.emit(eventType, {
      userId: user.userId,
      username: user.username,
      isOnline,
    })

    return user
  }

  async addFriend(userId, friendId) {
    // Check if already friends
    let user = await UserRepository.findById(userId)
    if (user.friends && user.friends.includes(friendId)) {
      throw new Error('Already friends')
    }

    // Add friend relationship (bidirectional)
    user = await UserRepository.addFriend(userId, friendId)
    const friend = await UserRepository.addFriend(friendId, userId)

    // Emit event
    userEvents.emit(USER_EVENTS.FRIEND_ADDED, {
      userId,
      friendId,
    })

    return { user, friend }
  }

  async sendFriendRequest(userId, friendId) {
    if (!friendId) {
      throw new Error('Friend ID is required')
    }

    if (userId === friendId) {
      throw new Error('Cannot send friend request to yourself')
    }

    const user = await UserRepository.findById(userId)
    if (user?.friends?.includes(friendId)) {
      throw new Error('Already friends')
    }

    const pendingOutgoing = user?.friendRequestsSent || []
    if (pendingOutgoing.includes(friendId)) {
      throw new Error('Friend request already sent')
    }

    await UserRepository.sendFriendRequest(userId, friendId)

    userEvents.emit(USER_EVENTS.FRIEND_REQUEST_SENT, {
      userId,
      friendId,
    })

    return true
  }

  async getPendingFriendRequests(userId) {
    const requestIds = await UserRepository.getFriendRequestsReceived(userId)
    return requestIds
  }

  async acceptFriendRequest(userId, requesterId) {
    await UserRepository.acceptFriendRequest(userId, requesterId)

    const conversation = await conversationService.getOrCreateDirectConversation(
      userId,
      requesterId
    )

    userEvents.emit(USER_EVENTS.FRIEND_REQUEST_ACCEPTED, {
      userId,
      requesterId,
    })

    return {
      accepted: true,
      conversation,
    }
  }

  async rejectFriendRequest(userId, requesterId) {
    await UserRepository.rejectFriendRequest(userId, requesterId)

    userEvents.emit(USER_EVENTS.FRIEND_REQUEST_REJECTED, {
      userId,
      requesterId,
    })

    return true
  }

  async removeFriend(userId, friendId) {
    const user = await UserRepository.removeFriend(userId, friendId)
    await UserRepository.removeFriend(friendId, userId)

    // Emit event
    userEvents.emit(USER_EVENTS.FRIEND_REMOVED, {
      userId,
      friendId,
    })

    return user
  }

  async blockUser(userId, blockUserId) {
    const user = await UserRepository.blockUser(userId, blockUserId)
    return user
  }

  async unblockUser(userId, blockUserId) {
    const user = await UserRepository.unblockUser(userId, blockUserId)
    return user
  }

  async getOnlineUsers(userIds = null) {
    const users = await UserRepository.getOnlineUsers(100)
    
    if (userIds && userIds.length > 0) {
      return users.filter(user => userIds.includes(user.userId))
    }

    return users
  }

  async getFriendsList(userId) {
    const user = await UserRepository.findById(userId)
    if (!user) {
      throw new Error('User not found')
    }

    return user.friends || []
  }

  /**
   * Get current user profile
   * @param {string} userId - User ID
   * @returns {Promise<Object>} User profile data
   */
  async getProfile(userId) {
    const user = await UserRepository.findById(userId, false)
    if (!user) {
      throw new Error('User not found')
    }
    return user
  }

  /**
   * Change user password
   * @param {string} userId - User ID
   * @param {string} currentPassword - Current password
   * @param {string} newPassword - New password
   * @returns {Promise<Object>} Updated user object
   */
  async changePassword(userId, currentPassword, newPassword) {
    // Get user with password
    const user = await UserRepository.findByIdWithPassword(userId)
    if (!user) {
      throw new Error('User not found')
    }

    // Verify current password
    const isPasswordValid = await comparePassword(currentPassword, user.password)
    if (!isPasswordValid) {
      throw new Error('Current password is incorrect')
    }

    // Hash new password
    const hashedPassword = await hashPassword(newPassword)

    // Update password
    const updatedUser = await UserRepository.update(userId, {
      password: hashedPassword,
    })

    // Emit event
    userEvents.emit(USER_EVENTS.PASSWORD_CHANGED, {
      userId: user.userId,
    })

    return updatedUser
  }

  /**
   * Update user avatar
   * @param {string} userId - User ID
   * @param {Buffer} fileBuffer - File buffer
   * @param {string} fileName - Original file name
   * @returns {Promise<Object>} Updated user object with new avatar URL
   */
  async updateAvatar(userId, fileBuffer, fileName) {
    // Get current user
    const user = await UserRepository.findById(userId, false)
    if (!user) {
      throw new Error('User not found')
    }

    // Upload to S3 and delete old avatar
    const newAvatarUrl = await S3Service.replaceAvatar(
      userId,
      fileBuffer,
      fileName,
      user.avatar
    )

    // Update user avatar URL in database
    const updatedUser = await UserRepository.update(userId, {
      avatar: newAvatarUrl,
    })

    // Emit event
    userEvents.emit(USER_EVENTS.AVATAR_UPDATED, {
      userId: user.userId,
      avatarUrl: newAvatarUrl,
    })

    return updatedUser
  }
}

export default new UserService()
