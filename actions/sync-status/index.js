/*
 * Adobe App Builder Action
 * AiChatbot – Sync status (with failure details)
 */

const { Core } = require('@adobe/aio-sdk')
const stateLib = require('@adobe/aio-lib-state')

const SYNC_STATE_KEY = 'aichatbot.sync.state'

async function main(params) {
  const logger = Core.Logger('sync-status', { level: params.LOG_LEVEL || 'info' })

  try {
    const state = await stateLib.init()
    const result = await state.get(SYNC_STATE_KEY)

    if (!result || !result.value) {
      return {
        statusCode: 200,
        body: { state: 'IDLE', total: 0, processed: 0, failed: 0, processedOffset: 0, lastError: null, failedSkus: [] }
      }
    }

    const s = JSON.parse(result.value)

    return {
      statusCode: 200,
      body: {
        state: s.state,
        total: s.total,
        processed: s.processed,
        failed: s.failed,
        processedOffset: s.processedOffset,           // exact resume pointer
        currentPage: Math.floor((s.processedOffset || 0) / (s.pageSize || 20)) + 1,
        pageSize: s.pageSize,
        startedAt: s.startedAt,
        resumedAt: s.resumedAt || null,
        completedAt: s.completedAt || null,
        lastError: s.lastError || null,               // { message, page, offset, at }
        failedSkus: s.failedSkus || []                // [{ sku, page, offset, reason }]
      }
    }
  } catch (error) {
    logger.error(error.message)
    return { statusCode: 500, body: { state: 'FAILED', error: error.message } }
  }
}

exports.main = main