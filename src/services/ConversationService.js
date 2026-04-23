import ConversationRepository from '../repositories/ConversationRepository.js'
import ParticipantRepository from '../repositories/ParticipantRepository.js'
import MessageRepository from '../repositories/MessageRepository.js'
import UserRepository from '../repositories/UserRepository.js'
import s3Service from './S3Service.js'
import { messageEvents, conversationEvents } from '../events/EventBus.js'
import { MESSAGE_EVENTS, CONVERSATION_EVENTS } from '../events/EventTypes.js'

export class ConversationService {
  normalizeId(value) {
    if (!value) return ''
    if (typeof value === 'object') {
      return String(value._id || value.userId || value.id || '')
    }
    return String(value)
  }

  async mapWithConcurrency(items = [], worker, concurrency = 8) {
    if (!Array.isArray(items) || items.length === 0) {
      return []
    }

    const safeConcurrency = Math.max(1, Math.min(concurrency, items.length))
    const results = new Array(items.length)
    let index = 0

    const runners = Array.from({ length: safeConcurrency }, async () => {
      while (index < items.length) {
        const currentIndex = index
        index += 1
        results[currentIndex] = await worker(items[currentIndex], currentIndex)
      }
    })

    await Promise.all(runners)
    return results
  }

  async findDirectConversationBetweenUsers(userAId, userBId) {
    const userAParticipants = await ParticipantRepository.findByUserId(userAId, 1000)

    if (!Array.isArray(userAParticipants) || userAParticipants.length === 0) {
      return null
    }

    for (const participant of userAParticipants) {
      const conversationId = participant?.conversationId
      if (!conversationId) continue

      const conversation = await ConversationRepository.findById(conversationId)
      if (!conversation) continue

      const type = conversation.type
      if (type !== '1-1' && type !== 'direct') continue

      const participants = await ParticipantRepository.findByConversationId(conversationId, 100)
      const allParticipantIds = (participants || []).map((item) => String(item.userId))
      const activeParticipantIds = (participants || [])
        .filter((item) => !item?.leftAt)
        .map((item) => String(item.userId))

      const hasUserA = allParticipantIds.includes(String(userAId))
      const hasUserB = allParticipantIds.includes(String(userBId))

      if (hasUserA && hasUserB) {
        return {
          ...conversation,
          participants: activeParticipantIds,
          participantRecords: participants,
        }
      }
    }

    return null
  }

  async getOrCreateDirectConversation(userAId, userBId) {
    const existingConversation = await this.findDirectConversationBetweenUsers(userAId, userBId)
    if (existingConversation) {
      return existingConversation
    }

    return this.createConversation('1-1', [userBId], userAId)
  }

  async createConversation(type, participantIds, userId, name = null) {
    const normalizedType = type === 'direct' ? '1-1' : type

    // Validate participants
    if (normalizedType === '1-1' && participantIds.length !== 1) {
      throw new Error('1-1 conversation must have exactly 2 participants')
    }

    if (normalizedType === 'group' && participantIds.length < 2) {
      throw new Error('Group must have at least 2 participants')
    }

    if (normalizedType === '1-1') {
      const targetUserId = participantIds[0]
      const existingConversation = await this.findDirectConversationBetweenUsers(userId, targetUserId)
      if (existingConversation) {
        const participantRecords = existingConversation.participantRecords || []
        const targetParticipantIds = [String(userId), String(targetUserId)]

        for (const participant of participantRecords) {
          if (!targetParticipantIds.includes(String(participant.userId))) {
            continue
          }

          if (participant.leftAt) {
            await ParticipantRepository.reactivateParticipant(
              existingConversation.conversationId,
              participant.userId,
              participant.leftAt
            )
          }
        }

        return existingConversation
      }
    }

    // Create conversation
    const participants = [userId, ...participantIds]
    const conversation = await ConversationRepository.create({
      creatorId: userId,
      type: normalizedType,
      name: normalizedType === 'group' ? name : null,
    })

    // Create participant records
    for (const participantId of participants) {
      await ParticipantRepository.create({
        conversationId: conversation.conversationId,
        userId: participantId,
        role: participantId === userId && normalizedType === 'group' ? 'admin' : 'member',
      })
    }

    // Emit event
    conversationEvents.emit(CONVERSATION_EVENTS.CREATED, {
      conversationId: conversation.conversationId,
      type: normalizedType,
      participants,
    })

    return conversation
  }

  async ensureConversationAccess(conversationId, requesterUserId) {
    const conversation = await ConversationRepository.findById(conversationId)
    if (!conversation) {
      throw new Error('Conversation not found')
    }

    const participant = await ParticipantRepository.findOne(conversationId, requesterUserId)
    if (!participant || participant.leftAt) {
      throw new Error('You do not have access to this conversation')
    }

    return { conversation, participant }
  }

  async ensureGroupConversation(conversationId) {
    const conversation = await ConversationRepository.findById(conversationId)
    if (!conversation) {
      throw new Error('Conversation not found')
    }

    if (conversation.type !== 'group') {
      throw new Error('This operation is only available for group conversations')
    }

    return conversation
  }

  async ensureGroupManager(conversationId, actorUserId, acceptedRoles = ['admin', 'moderator']) {
    const conversation = await this.ensureGroupConversation(conversationId)
    const actorParticipant = await ParticipantRepository.findOne(conversationId, actorUserId)

    if (!actorParticipant || actorParticipant.leftAt) {
      throw new Error('You do not have access to this conversation')
    }

    if (!acceptedRoles.includes(String(actorParticipant.role || 'member'))) {
      throw new Error('You do not have permission to perform this action')
    }

    return { conversation, actorParticipant }
  }

  async getConversationParticipants(conversationId, requesterUserId) {
    await this.ensureConversationAccess(conversationId, requesterUserId)
    const participantRecords = await ParticipantRepository.findByConversationId(conversationId, 200)

    return (participantRecords || [])
      .filter((item) => !item?.leftAt)
      .map((item) => ({
        participantId: item.participantId,
        conversationId: item.conversationId,
        userId: item.userId,
        role: item.role || 'member',
        joinedAt: item.joinedAt,
      }))
  }

  async updateParticipantRole(conversationId, targetUserId, newRole, actorUserId) {
    const normalizedRole = String(newRole || '').trim().toLowerCase()
    if (!['member', 'moderator'].includes(normalizedRole)) {
      throw new Error('Role must be either member or moderator')
    }

    const { conversation } = await this.ensureGroupManager(conversationId, actorUserId, ['admin'])

    const targetParticipant = await ParticipantRepository.findOne(conversationId, targetUserId)
    if (!targetParticipant || targetParticipant.leftAt) {
      throw new Error('Target participant not found in group')
    }

    if (this.normalizeId(conversation.creatorId) === this.normalizeId(targetUserId)) {
      throw new Error('Cannot change role of group owner')
    }

    const previousRole = String(targetParticipant.role || 'member')
    await ParticipantRepository.updateRole(conversationId, targetUserId, normalizedRole)

    conversationEvents.emit(CONVERSATION_EVENTS.PARTICIPANT_ROLE_UPDATED, {
      conversationId,
      targetUserId: this.normalizeId(targetUserId),
      oldRole: previousRole,
      newRole: normalizedRole,
      changedByUserId: this.normalizeId(actorUserId),
    })

    await this.persistRoleChangeSystemMessage({
      conversationId,
      targetUserId,
      oldRole: previousRole,
      newRole: normalizedRole,
    })

    return this.getConversationParticipants(conversationId, actorUserId)
  }

  async resolveUserDisplayName(userId) {
    const normalizedUserId = this.normalizeId(userId)
    if (!normalizedUserId) return 'Thành viên'

    try {
      const profile = await UserRepository.findById(normalizedUserId, false)
      return (
        profile?.nickname ||
        profile?.displayName ||
        profile?.fullName ||
        profile?.username ||
        normalizedUserId
      )
    } catch (_) {
      return normalizedUserId
    }
  }

  buildRoleChangeSystemContent(targetDisplayName, oldRole, newRole) {
    const normalizedOldRole = String(oldRole || 'member').toLowerCase()
    const normalizedNewRole = String(newRole || 'member').toLowerCase()

    if (normalizedNewRole === 'admin' && normalizedOldRole !== 'admin') {
      return `${targetDisplayName} đã được bổ nhiệm làm trưởng nhóm.`
    }

    if (normalizedNewRole === 'moderator' && normalizedOldRole !== 'moderator') {
      return `${targetDisplayName} đã được bổ nhiệm làm phó nhóm.`
    }

    if (normalizedOldRole === 'moderator' && normalizedNewRole === 'member') {
      return `${targetDisplayName} đã bị miễn nhiệm vai trò phó nhóm.`
    }

    if (normalizedOldRole !== normalizedNewRole) {
      return `Vai trò của ${targetDisplayName} đã được cập nhật.`
    }

    return ''
  }

  async persistRoleChangeSystemMessage({ conversationId, targetUserId, oldRole, newRole }) {
    const normalizedConversationId = this.normalizeId(conversationId)
    const normalizedTargetUserId = this.normalizeId(targetUserId)

    if (!normalizedConversationId || !normalizedTargetUserId) {
      return null
    }

    const targetDisplayName = await this.resolveUserDisplayName(normalizedTargetUserId)
    const content = this.buildRoleChangeSystemContent(targetDisplayName, oldRole, newRole)
    if (!content) return null

    const message = await MessageRepository.create({
      conversationId: normalizedConversationId,
      senderId: 'system',
      content,
      type: 'system',
      attachments: [],
      status: 'sent',
      seenBy: [],
      deliveredTo: [],
    })

    await ConversationRepository.update(normalizedConversationId, {
      updatedAt: Number(message?.createdAt || Date.now()),
    })

    messageEvents.emit(MESSAGE_EVENTS.SENT, {
      conversationId: normalizedConversationId,
      message,
    })

    return message
  }

  async updateGroupSettings(conversationId, updateData, actorUserId) {
    await this.ensureGroupManager(conversationId, actorUserId, ['admin', 'moderator'])

    const allowedKeys = [
      'allowMemberEditGroupInfo',
      'adminOnlyMessaging',
      'requiresAdminApproval',
      'newMemberHistoryVisibility',
      'groupNotificationFilter',
    ]

    const previousConversation = await ConversationRepository.findById(conversationId)
    const currentSettings = previousConversation?.groupSettings || {}
    const mergedSettings = { ...currentSettings }

    allowedKeys.forEach((key) => {
      if (Object.prototype.hasOwnProperty.call(updateData || {}, key)) {
        mergedSettings[key] = updateData[key]
      }
    })

    const conversation = await ConversationRepository.update(conversationId, {
      groupSettings: mergedSettings,
    })

    return conversation
  }

  async getBlockedUsers(conversationId, requesterUserId) {
    await this.ensureGroupManager(conversationId, requesterUserId, ['admin', 'moderator'])
    const conversation = await ConversationRepository.findById(conversationId)
    const blockedUserIds = Array.isArray(conversation?.blockedUserIds)
      ? conversation.blockedUserIds
      : []

    return blockedUserIds.map((userId) => this.normalizeId(userId)).filter(Boolean)
  }

  async blockUser(conversationId, targetUserId, actorUserId) {
    await this.ensureGroupManager(conversationId, actorUserId, ['admin', 'moderator'])
    const conversation = await ConversationRepository.findById(conversationId)

    const targetParticipant = await ParticipantRepository.findOne(conversationId, targetUserId)
    if (!targetParticipant || targetParticipant.leftAt) {
      throw new Error('Target user is not an active participant')
    }

    if (String(targetParticipant.role || '') === 'admin') {
      throw new Error('Cannot block group owner/admin')
    }

    const currentBlockedUserIds = Array.isArray(conversation?.blockedUserIds)
      ? conversation.blockedUserIds.map((item) => this.normalizeId(item)).filter(Boolean)
      : []

    const nextBlockedUserIds = [...new Set([...currentBlockedUserIds, this.normalizeId(targetUserId)])]

    await ConversationRepository.update(conversationId, {
      blockedUserIds: nextBlockedUserIds,
    })

    await ParticipantRepository.markAsLeft(conversationId, targetUserId)

    return nextBlockedUserIds
  }

  async unblockUser(conversationId, targetUserId, actorUserId) {
    await this.ensureGroupManager(conversationId, actorUserId, ['admin', 'moderator'])
    const conversation = await ConversationRepository.findById(conversationId)

    const currentBlockedUserIds = Array.isArray(conversation?.blockedUserIds)
      ? conversation.blockedUserIds.map((item) => this.normalizeId(item)).filter(Boolean)
      : []

    const normalizedTargetId = this.normalizeId(targetUserId)
    const nextBlockedUserIds = currentBlockedUserIds.filter((id) => id !== normalizedTargetId)

    await ConversationRepository.update(conversationId, {
      blockedUserIds: nextBlockedUserIds,
    })

    return nextBlockedUserIds
  }

  async leaveGroupConversation(conversationId, actorUserId, options = {}) {
    const { conversation, actorParticipant } = await this.ensureConversationAccess(conversationId, actorUserId)
    const leaveSilently = Boolean(options?.leaveSilently)

    if (conversation.type !== 'group') {
      await ParticipantRepository.markAsLeft(conversationId, actorUserId)
      return {
        conversationId,
        userId: actorUserId,
        leaveSilently,
        dissolved: false,
      }
    }

    const participants = await ParticipantRepository.findByConversationId(conversationId, 300)
    const activeParticipants = (participants || []).filter((item) => !item?.leftAt)

    if (activeParticipants.length <= 1) {
      await ParticipantRepository.deleteByConversationId(conversationId)
      await ConversationRepository.delete(conversationId)

      return {
        conversationId,
        userId: actorUserId,
        leaveSilently,
        dissolved: true,
      }
    }

    if (String(actorParticipant.role || '') === 'admin') {
      const availableMembers = activeParticipants
        .filter((item) => this.normalizeId(item.userId) !== this.normalizeId(actorUserId))

      const preferredSuccessor =
        availableMembers.find((item) => String(item.role || '') === 'moderator') ||
        availableMembers[0]

      if (preferredSuccessor?.userId) {
        const previousRole = String(preferredSuccessor.role || 'member')
        await ParticipantRepository.updateRole(conversationId, preferredSuccessor.userId, 'admin')
        conversationEvents.emit(CONVERSATION_EVENTS.PARTICIPANT_ROLE_UPDATED, {
          conversationId,
          targetUserId: this.normalizeId(preferredSuccessor.userId),
          oldRole: previousRole,
          newRole: 'admin',
          changedByUserId: this.normalizeId(actorUserId),
        })

        await this.persistRoleChangeSystemMessage({
          conversationId,
          targetUserId: preferredSuccessor.userId,
          oldRole: previousRole,
          newRole: 'admin',
        })
      }
    }

    await ParticipantRepository.markAsLeft(conversationId, actorUserId)

    return {
      conversationId,
      userId: actorUserId,
      leaveSilently,
      dissolved: false,
    }
  }

  async dissolveGroupConversation(conversationId, actorUserId) {
    const { conversation } = await this.ensureGroupManager(conversationId, actorUserId, ['admin'])

    if (this.normalizeId(conversation.creatorId) !== this.normalizeId(actorUserId)) {
      throw new Error('Only group owner can dissolve this group')
    }

    const participants = await ParticipantRepository.findByConversationId(conversationId, 300)
    const participantIds = [...new Set(
      (participants || [])
        .filter((item) => !item?.leftAt)
        .map((item) => this.normalizeId(item?.userId))
        .filter(Boolean)
    )]

    conversationEvents.emit(CONVERSATION_EVENTS.DISSOLVED, {
      conversationId,
      participantIds,
      dissolvedByUserId: this.normalizeId(actorUserId),
    })

    await ParticipantRepository.deleteByConversationId(conversationId)
    await ConversationRepository.delete(conversationId)

    return {
      conversationId,
      dissolved: true,
      participantIds,
    }
  }

  async getConversationById(conversationId, requesterUserId = null) {
    try {
      const conversation = await ConversationRepository.findById(conversationId)

      if (!conversation) {
        throw new Error(`Conversation with ID ${conversationId} not found`)
      }

      // Get participants
      const participants = await ParticipantRepository.findByConversationId(conversationId)

      if (requesterUserId) {
        const activeParticipantIds = participants
          .filter((item) => !item?.leftAt)
          .map((item) => String(item.userId))

        if (!activeParticipantIds.includes(String(requesterUserId))) {
          throw new Error('You do not have access to this conversation')
        }
      }

      return {
        ...conversation,
        participants: participants
          .filter((item) => !item?.leftAt)
          .map((item) => item.userId),
      }
    } catch (error) {
      if (error.message.includes('not found') || error.message.includes('do not have access')) {
        throw error
      }
      throw new Error(`Failed to get conversation: ${error.message}`)
    }
  }

  async getUserConversations(userId, limit = 20) {
    // Get all conversations this user is part of
    const participants = await ParticipantRepository.findByUserId(userId)
    const activeParticipants = participants.filter((item) => !item?.leftAt)
    const conversationIds = [...new Set(activeParticipants.map((item) => item.conversationId))]

    if (conversationIds.length === 0) {
      return []
    }

    const [conversationsRaw, participantsByConversation, latestMessagesByConversation] = await Promise.all([
      ConversationRepository.findByIds(conversationIds),
      this.mapWithConcurrency(
        conversationIds,
        async (conversationId) => {
          const records = await ParticipantRepository.findByConversationId(conversationId, 100)
          return [conversationId, records || []]
        },
        8
      ),
      this.mapWithConcurrency(
        conversationIds,
        async (conversationId) => {
          const result = await MessageRepository.getByConversation(conversationId, 1)
          return [conversationId, result?.messages?.[0] || null]
        },
        8
      ),
    ])

    const conversationById = new Map((conversationsRaw || []).map((conv) => [String(conv.conversationId), conv]))
    const participantMap = new Map(participantsByConversation)
    const latestMessageMap = new Map(latestMessagesByConversation)

    // Fetch conversations
    const conversations = []
    for (const conversationId of conversationIds) {
      const conv = conversationById.get(String(conversationId))
      if (!conv) continue

      const participantRecords = participantMap.get(conversationId) || []
      const participant = activeParticipants.find((item) => item.conversationId === conversationId)
      const latestMessage = latestMessageMap.get(conversationId) || null

      const updatedAt = Number(
        latestMessage?.createdAt ||
        latestMessage?.updatedAt ||
        conv?.updatedAt ||
        0
      )
      const clearedAt = Number(participant?.clearedAt || 0)

      // Hide conversation for this user until there is newer activity after clear
      if (clearedAt && updatedAt <= clearedAt) {
        continue
      }

      conversations.push({
        ...conv,
        participants: participantRecords
          .filter((item) => !item?.leftAt)
          .map((item) => item.userId),
        latestMessage,
        lastMessageAt: updatedAt || conv?.updatedAt,
      })
    }

    // Sort by last message time
    conversations.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))

    return conversations.slice(0, limit)
  }

  async addParticipant(conversationId, newParticipantId, addedBy) {
    const { conversation } = await this.ensureGroupManager(conversationId, addedBy, ['admin', 'moderator'])

    const normalizedNewParticipantId = this.normalizeId(newParticipantId)

    // Check if already a participant
    const existingParticipant = await ParticipantRepository.findOne(conversationId, newParticipantId)
    if (existingParticipant) {
      if (!existingParticipant.leftAt) {
        throw new Error('User is already a participant')
      }

      await ParticipantRepository.reactivateParticipant(
        conversationId,
        newParticipantId,
        existingParticipant.leftAt
      )

      conversationEvents.emit(CONVERSATION_EVENTS.PARTICIPANT_ADDED, {
        conversationId,
        participantId: normalizedNewParticipantId,
        addedBy,
      })

      return await this.getConversationById(conversationId)
    }

    const blockedUserIds = Array.isArray(conversation?.blockedUserIds)
      ? conversation.blockedUserIds.map((item) => this.normalizeId(item)).filter(Boolean)
      : []
    if (blockedUserIds.includes(normalizedNewParticipantId)) {
      throw new Error('This user is blocked from this group')
    }

    // Add participant
    await ParticipantRepository.create({
      conversationId,
      userId: newParticipantId,
      role: 'member',
    })

    // Emit event
    conversationEvents.emit(CONVERSATION_EVENTS.PARTICIPANT_ADDED, {
      conversationId,
      participantId: normalizedNewParticipantId,
      addedBy,
    })

    return await this.getConversationById(conversationId)
  }

  async removeParticipant(conversationId, participantId, removedBy = null) {
    const conversation = await ConversationRepository.findById(conversationId)
    if (!conversation) {
      throw new Error('Conversation not found')
    }

    if (conversation.type === 'group' && removedBy) {
      const actor = await ParticipantRepository.findOne(conversationId, removedBy)
      if (!actor || actor.leftAt) {
        throw new Error('You do not have access to this conversation')
      }

      const canRemoveOthers = ['admin', 'moderator'].includes(String(actor.role || 'member'))
      const isSelfRemove = this.normalizeId(participantId) === this.normalizeId(removedBy)
      if (!canRemoveOthers && !isSelfRemove) {
        throw new Error('You do not have permission to remove this participant')
      }
    }

    // Remove participant
    await ParticipantRepository.markAsLeft(conversationId, participantId)

    // Emit event
    conversationEvents.emit(CONVERSATION_EVENTS.PARTICIPANT_REMOVED, {
      conversationId,
      participantId,
    })

    return await this.getConversationById(conversationId)
  }

  async updateConversation(conversationId, updateData, actorUserId = null) {
    const { name, avatar, description } = updateData

    const conversation = await ConversationRepository.findById(conversationId)
    if (!conversation) {
      throw new Error('Conversation not found')
    }

    if (actorUserId && conversation.type === 'group') {
      const actorParticipant = await ParticipantRepository.findOne(conversationId, actorUserId)
      if (!actorParticipant || actorParticipant.leftAt) {
        throw new Error('You do not have access to this conversation')
      }

      const groupSettings = conversation.groupSettings || {}
      const allowMemberEditGroupInfo = Boolean(groupSettings.allowMemberEditGroupInfo)
      const actorRole = String(actorParticipant.role || 'member')

      if (!allowMemberEditGroupInfo && !['admin', 'moderator'].includes(actorRole)) {
        throw new Error('Only admin/moderator can edit group info')
      }
    }

    const updates = {}
    if (name !== undefined) updates.name = name
    if (avatar !== undefined) updates.avatar = avatar
    if (description !== undefined) updates.description = description

    const updatedConversation = await ConversationRepository.update(conversationId, updates)

    // Emit event
    conversationEvents.emit(CONVERSATION_EVENTS.UPDATED, {
      conversationId,
      conversation: updatedConversation,
    })

    return updatedConversation
  }

  async updateConversationAvatar(conversationId, actorUserId, fileBuffer, fileName) {
    if (!fileBuffer || !fileName) {
      throw new Error('Avatar file is required')
    }

    await this.ensureGroupManager(conversationId, actorUserId, ['admin', 'moderator'])

    const avatarUrl = await s3Service.uploadAvatar(actorUserId, fileBuffer, fileName)
    const updatedConversation = await ConversationRepository.update(conversationId, {
      avatar: avatarUrl,
    })

    conversationEvents.emit(CONVERSATION_EVENTS.UPDATED, {
      conversationId,
      conversation: updatedConversation,
    })

    return updatedConversation
  }

  async deleteConversation(conversationId, userId) {
    const conversation = await ConversationRepository.findById(conversationId)
    if (!conversation) {
      throw new Error('Conversation not found')
    }

    const participant = await ParticipantRepository.findOne(conversationId, userId)
    if (!participant || participant.leftAt) {
      throw new Error('Conversation already deleted for this user')
    }

    await ParticipantRepository.clearConversationForUser(conversationId, userId)

    return {
      conversationId,
      deletedForUserId: userId,
      permanentlyDeleted: false,
    }
  }

  async searchConversations(userId, query, limit = 10) {
    // Get user's conversations
    const conversations = await this.getUserConversations(userId, 1000)

    // Filter by name
    return conversations
      .filter(conv => 
        conv.name?.toLowerCase().includes(query.toLowerCase())
      )
      .slice(0, limit)
  }
}

export default new ConversationService()
