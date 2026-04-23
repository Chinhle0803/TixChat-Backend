import joi from 'joi'

export const registerValidation = (data) => {
  const schema = joi.object({
    username: joi.string().alphanum().min(3).max(30).required().messages({
      'string.alphanum': 'Username must contain only alphanumeric characters',
      'string.min': 'Username must be at least 3 characters',
      'string.max': 'Username must be at most 30 characters',
    }),
    email: joi.string().email().required().messages({
      'string.email': 'Please provide a valid email',
    }),
    password: joi.string().min(6).required().messages({
      'string.min': 'Password must be at least 6 characters',
    }),
    confirmPassword: joi.string().valid(joi.ref('password')).required().messages({
      'any.only': 'Passwords do not match',
    }),
    fullName: joi.string().min(2).max(100).required().messages({
      'string.min': 'Full name must be at least 2 characters',
    }),
  })

  return schema.validate(data)
}

export const loginValidation = (data) => {
  const schema = joi.object({
    email: joi.string().email().required(),
    password: joi.string().required(),
  })

  return schema.validate(data)
}

export const updateProfileValidation = (data) => {
  const schema = joi.object({
    fullName: joi.string().min(2).max(100),
    displayName: joi.string().min(2).max(100),
    bio: joi.string().max(500),
    avatar: joi.string().uri(),
  }).min(1)

  return schema.validate(data)
}

export const createConversationValidation = (data) => {
  const schema = joi.object({
    type: joi.string().valid('1-1', 'group').required(),
    participantIds: joi.array().items(joi.string()).min(1).required(),
    name: joi.string().when('type', {
      is: 'group',
      then: joi.required(),
      otherwise: joi.forbidden(),
    }),
  })

  return schema.validate(data)
}

export const sendMessageValidation = (data) => {
  const schema = joi.object({
    conversationId: joi.string().required(),
    content: joi.string().max(5000).required().messages({
      'string.max': 'Message must not exceed 5000 characters',
    }),
    replyTo: joi.string().allow(null, '').optional(),
    clientMessageId: joi.string().max(128).optional(),
  })

  return schema.validate(data)
}

export const forgotPasswordValidation = (data) => {
  const schema = joi.object({
    email: joi.string().email().required().messages({
      'string.email': 'Please provide a valid email',
    }),
  })

  return schema.validate(data)
}

export const resetPasswordValidation = (data) => {
  const schema = joi.object({
    email: joi.string().email().required(),
    token: joi.string().required(),
    newPassword: joi.string().min(6).required().messages({
      'string.min': 'Password must be at least 6 characters',
    }),
    confirmPassword: joi.string().valid(joi.ref('newPassword')).required().messages({
      'any.only': 'Passwords do not match',
    }),
  })

  return schema.validate(data)
}

export const changePasswordValidation = (data) => {
  const schema = joi.object({
    currentPassword: joi.string().required().messages({
      'any.required': 'Current password is required',
    }),
    newPassword: joi.string().min(6).required().messages({
      'string.min': 'New password must be at least 6 characters',
    }),
    confirmPassword: joi.string().valid(joi.ref('newPassword')).required().messages({
      'any.only': 'Passwords do not match',
    }),
  })

  return schema.validate(data)
}

export const updateAvatarValidation = (data) => {
  const schema = joi.object({
    // File validation is handled by multer middleware
  })

  return schema.validate(data)
}
