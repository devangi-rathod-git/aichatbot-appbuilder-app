/*
 * Adobe App Builder Action
 * AiChatbot – Start (or resume) product sync
 */

const isTestEnv = process.env.NODE_ENV === 'test' || process.env.JEST_WORKER_ID
const fetch = isTestEnv
  ? require('node-fetch')
  : (globalThis.fetch ? globalThis.fetch.bind(globalThis) : require('node-fetch'))
const { Core } = require('@adobe/aio-sdk')
const stateLib = require('@adobe/aio-lib-state')
const { getCommerceToken, getCommerceApiUrl, getCommerceScopeHeaders } = require('../utils')

const SETTINGS_KEY = 'aichatbot.settings'
const SYNC_STATE_KEY = 'aichatbot.sync.state'
const DEFAULT_PAGE_SIZE = 20
const SYNC_TTL_SECONDS = 7200

async function main(params) {
  const logger = Core.Logger('sync-start', { level: params.LOG_LEVEL || 'debug' })

  try {
    logger.info('🚀 Starting product sync')
    const state = await stateLib.init()

    const settingsResult = await state.get(SETTINGS_KEY)
    if (!settingsResult || !settingsResult.value) {
      return errorResponse(400, 'Settings not configured. Please save settings first.')
    }

    const existing = await state.get(SYNC_STATE_KEY)
    if (existing && existing.value) {
      const existingState = JSON.parse(existing.value)

      // Auto-resume if previously FAILED
      if (existingState.state === 'FAILED' || params.resume === true || params.resume === 'true') {
        if (existingState.state === 'FAILED') {
          logger.info(`♻️ Resuming failed sync from offset ${existingState.processedOffset} (${existingState.processed}/${existingState.total} already processed)`)
          existingState.state = 'IN_PROGRESS'
          existingState.lastError = null
          existingState.resumedAt = new Date().toISOString()
          await state.put(SYNC_STATE_KEY, JSON.stringify(existingState), { ttl: SYNC_TTL_SECONDS })

          return {
            statusCode: 200,
            body: {
              success: true,
              message: 'Sync resumed',
              resumedFromOffset: existingState.processedOffset,
              processed: existingState.processed,
              total: existingState.total,
              pageSize: existingState.pageSize
            }
          }
        }
      }

      // Already running — don't reset
      if (existingState.state === 'IN_PROGRESS') {
        logger.info('⚠️ Sync already in progress')
        return {
          statusCode: 200,
          body: {
            success: true,
            message: 'Sync already in progress',
            alreadyRunning: true,
            processedOffset: existingState.processedOffset,
            processed: existingState.processed,
            total: existingState.total
          }
        }
      }
    }

    // Fresh start
    logger.info('📥 Fetching Magento product count')
    const total = await fetchMagentoProductCount(params, logger)
    const pageSize = normalizePageSize(params.SYNC_PAGE_SIZE)
    logger.info(`📦 Found ${total} products`)

    const syncState = {
      state: total === 0 ? 'COMPLETED' : 'IN_PROGRESS',
      total,
      processed: 0,
      failed: 0,
      processedOffset: 0,       // ← absolute count of successfully synced products
      pageSize,
      lastError: null,
      failedSkus: [],
      startedAt: new Date().toISOString(),
      resumedAt: null,
      completedAt: total === 0 ? new Date().toISOString() : null
    }

    await state.put(SYNC_STATE_KEY, JSON.stringify(syncState), { ttl: SYNC_TTL_SECONDS })

    return {
      statusCode: 200,
      body: { success: true, message: 'Sync started', total, pageSize }
    }
  } catch (error) {
    logger.error('🔥 Sync start failed')
    logger.error(error.stack || error.message)
    return errorResponse(500, error.message)
  }
}

async function fetchMagentoProductCount(params, logger) {
  const { COMMERCE_BASE_URL } = params
  if (!COMMERCE_BASE_URL) throw new Error('Missing Adobe Commerce Base URL')
  const token = await getCommerceToken(params)

  const url = getCommerceApiUrl(COMMERCE_BASE_URL, 'products')
  const queryString = new URLSearchParams({
    'searchCriteria[currentPage]': '1',
    'searchCriteria[pageSize]': '1',
    'searchCriteria[filter_groups][0][filters][0][field]': 'visibility',
    'searchCriteria[filter_groups][0][filters][0][value]': '2,3,4',
    'searchCriteria[filter_groups][0][filters][0][condition_type]': 'in'
  }).toString()

  const response = await fetch(`${url}?${queryString}`, {
    method: 'GET',
    headers: Object.assign({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, getCommerceScopeHeaders(params), params && params.IMS_ORG_ID ? { 'x-gw-ims-org-id': params.IMS_ORG_ID } : {})
  })
  if (!response.ok) throw new Error(`Adobe Commerce API error: ${response.status}`)
  const data = await response.json()
  const totalCount = Number(data.total_count || 0)
  logger.info(`✅ Adobe Commerce total_count: ${totalCount}`)
  return totalCount
}

function normalizePageSize(rawPageSize) {
  const parsed = Number(rawPageSize)
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_PAGE_SIZE
  return Math.min(100, Math.floor(parsed))
}

function errorResponse(statusCode, message) {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: { success: false, error: true, message } }
}

exports.main = main
