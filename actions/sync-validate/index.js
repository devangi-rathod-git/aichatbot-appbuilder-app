/*
 * Adobe App Builder Action
 * AiChatbot – Validate sync prerequisites
 */

const { Core } = require('@adobe/aio-sdk')
const stateLib = require('@adobe/aio-lib-state')
const { getCommerceToken } = require('../utils')

const SETTINGS_KEY = 'aichatbot.settings'

async function main(params) {
  const logger = Core.Logger('sync-validate', {
    level: params.LOG_LEVEL || 'debug'
  })

  try {
    logger.info('✅ Validating sync prerequisites')

    // Validate Commerce credentials (supports both PaaS and SaaS)
    try {
      await getCommerceToken(params)
    } catch (e) {
      return errorResponse(400, e.message)
    }

    // Load settings from State API
    const state = await stateLib.init()
    const settingsResult = await state.get(SETTINGS_KEY)
    
    if (!settingsResult || !settingsResult.value) {
      return errorResponse(400, 'Settings not configured. Please save settings first.')
    }

    const settings = JSON.parse(settingsResult.value)

    // Check OpenAI API key
    if (!settings.openaiKey) {
      return errorResponse(400, 'Missing OpenAI API key in settings')
    }

    // Check Qdrant URL
    if (!settings.vectorDbUrl) {
      return errorResponse(400, 'Missing Qdrant URL in settings')
    }

    logger.info('✅ All prerequisites validated successfully')

    return {
      statusCode: 200,
      body: {
        success: true,
        message: 'Validation successful',
        config: {
          magentoConfigured: true,
          openaiConfigured: true,
          qdrantConfigured: true
        }
      }
    }
  } catch (error) {
    logger.error('🔥 Validation failed')
    logger.error(error.stack || error.message)
    return errorResponse(500, error.message)
  }
}

function errorResponse(statusCode, message) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json'
    },
    body: {
      success: false,
      error: true,
      message: message
    }
  }
}

exports.main = main