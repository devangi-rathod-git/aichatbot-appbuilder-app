/*
 * Adobe App Builder Action
 * AiChatbot – Process one page of products (product-level resume)
 */

const fetch = globalThis.fetch ? globalThis.fetch.bind(globalThis) : require('node-fetch')
const { Core } = require('@adobe/aio-sdk')
const stateLib = require('@adobe/aio-lib-state')
const { getCommerceToken, getCommerceApiUrl, getCommerceScopeHeaders } = require('../utils')

const SETTINGS_KEY = 'aichatbot.settings'
const SYNC_STATE_KEY = 'aichatbot.sync.state'
const SYNC_TTL_SECONDS = 7200

async function main(params) {
  const logger = Core.Logger('sync-chunk', { level: params.LOG_LEVEL || 'debug' })

  try {
    const state = await stateLib.init()

    const settingsResult = await state.get(SETTINGS_KEY)
    if (!settingsResult || !settingsResult.value) {
      return errorResponse(400, 'Settings not configured. Please save settings first.')
    }
    const settings = JSON.parse(settingsResult.value)

    const statusResult = await state.get(SYNC_STATE_KEY)
    if (!statusResult || !statusResult.value) {
      return {
        statusCode: 200,
        body: {
          state: 'STARTING',
          total: 0,
          processed: 0,
          processedOffset: 0,
          failed: 0
        }
      }
    }
    const syncState = JSON.parse(statusResult.value)

    if (syncState.state !== 'IN_PROGRESS') {
      return {
        statusCode: 200,
        body: {
          done: true,
          state: syncState.state,
          processed: syncState.processed,
          failed: syncState.failed,
          total: syncState.total
        }
      }
    }

    const pageSize = Number(syncState.pageSize) || 20
    const processedOffset = Number(syncState.processedOffset) || 0

    const currentPage = Math.floor(processedOffset / pageSize) + 1
    const skipWithinPage = processedOffset % pageSize

    let products
    try {
      products = await fetchWithRetry(
        () => fetchMagentoProducts(params, currentPage, pageSize),
        3,
        logger
      )
    } catch (fetchError) {
      syncState.state = 'FAILED'
      syncState.lastError = {
        message: fetchError.message,
        page: currentPage,
        offset: processedOffset,
        at: new Date().toISOString()
      }
      await state.put(SYNC_STATE_KEY, JSON.stringify(syncState), { ttl: SYNC_TTL_SECONDS })
      logger.error(`🔥 Magento fetch failed on page ${currentPage}: ${fetchError.message}`)
      return errorResponse(500, `Magento fetch failed on page ${currentPage}: ${fetchError.message}`)
    }

    if (!products.length) {
      syncState.state = 'COMPLETED'
      syncState.completedAt = new Date().toISOString()
      syncState.lastError = null
      await state.put(SYNC_STATE_KEY, JSON.stringify(syncState), { ttl: SYNC_TTL_SECONDS })
      return {
        statusCode: 200,
        body: { done: true, state: syncState.state, processed: syncState.processed, failed: syncState.failed, total: syncState.total }
      }
    }

    const productsToProcess = products.slice(skipWithinPage)
    logger.info(`⚙️ Page ${currentPage}: ${products.length} fetched, skipping ${skipWithinPage} already synced, processing ${productsToProcess.length}`)

    for (const product of productsToProcess) {
      try {
        const embedding = await generateEmbedding(product, settings)
        await ensureCollection(settings, embedding.length)
        const payload = buildProductPayload(product, settings, params)
        await storeInQdrant(product.id, embedding, payload, settings, logger)

        syncState.processedOffset += 1
        syncState.processed += 1

        await state.put(SYNC_STATE_KEY, JSON.stringify(syncState), { ttl: SYNC_TTL_SECONDS })

        logger.info(`✅ ${product.sku} (${syncState.processedOffset}/${syncState.total})`)
      } catch (error) {
        logger.error(`❌ Failed ${product.sku}: ${error.message}`)
        syncState.failed += 1
        if (!syncState.failedSkus) syncState.failedSkus = []
        syncState.failedSkus.push({
          sku: product.sku,
          page: currentPage,
          offset: syncState.processedOffset,
          reason: error.message
        })
        await state.put(SYNC_STATE_KEY, JSON.stringify(syncState), { ttl: SYNC_TTL_SECONDS })
      }
    }

    const done = syncState.processedOffset >= syncState.total || products.length < pageSize

    if (done) {
      syncState.state = 'COMPLETED'
      syncState.completedAt = new Date().toISOString()
      syncState.lastError = null
      logger.info('🎉 Sync completed!')
      await state.put(SYNC_STATE_KEY, JSON.stringify(syncState), { ttl: SYNC_TTL_SECONDS })
    }

    return {
      statusCode: 200,
      body: {
        done,
        state: syncState.state,
        currentPage,
        processedOffset: syncState.processedOffset,
        processed: syncState.processed,
        failed: syncState.failed,
        total: syncState.total
      }
    }
  } catch (error) {
    logger.error('🔥 Chunk processing failed')
    logger.error(error.stack || error.message)
    return errorResponse(500, error.message)
  }
}

async function fetchWithRetry(fn, retries, logger) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fn()
    } catch (err) {
      if (attempt === retries) throw err
      const delay = attempt * 2000
      logger.warn(`⚠️ Attempt ${attempt} failed (${err.message}), retrying in ${delay}ms...`)
      await new Promise(r => setTimeout(r, delay))
    }
  }
}

async function fetchMagentoProducts(params, currentPage, pageSize) {
  const { COMMERCE_BASE_URL } = params
  if (!COMMERCE_BASE_URL) throw new Error('Missing Adobe Commerce Base URL')
  const token = await getCommerceToken(params)

  const url = getCommerceApiUrl(COMMERCE_BASE_URL, 'products')
  const queryString = new URLSearchParams({
    'searchCriteria[currentPage]': String(currentPage),
    'searchCriteria[pageSize]': String(pageSize),
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
  return data.items || []
}

async function generateEmbedding(product, settings) {
  const attributes = (settings.productAttributes || '').split(',').map(a => a.trim()).filter(Boolean)
  let productText = `Product: ${product.name}\nSKU: ${product.sku}\n`
  if (product.custom_attributes) {
    for (const attr of attributes) {
      const customAttr = product.custom_attributes.find(ca => ca.attribute_code === attr)
      if (customAttr) productText += `${attr}: ${customAttr.value}\n`
    }
  }
  const response = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: { Authorization: `Bearer ${settings.openaiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'text-embedding-ada-002', input: productText })
  })
  if (!response.ok) throw new Error(`OpenAI API error: ${response.status}`)
  const data = await response.json()
  return data.data[0].embedding
}

async function ensureCollection(settings, vectorSize) {
  const baseUrl = settings.vectorDbUrl
  const apiKey = settings.vectorDbApiKey || ''
  const check = await fetch(`${baseUrl}/collections/products`, {
    headers: { 'api-key': apiKey }
  })
  if (check.status === 404) {
    const createRes = await fetch(`${baseUrl}/collections/products`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'api-key': apiKey
      },
      body: JSON.stringify({ vectors: { size: vectorSize, distance: 'Cosine' } })
    })
    if (!createRes.ok) throw new Error(`Failed to create collection: ${await createRes.text()}`)
  }
}

function buildProductPayload(product, settings, params) {
  const payload = {
    sku: product.sku,
    name: product.name,
    price: product.price,
    visibility: product.visibility,
    status: product.status,
    type_id: product.type_id
  }

  const attributes = (settings.productAttributes || '')
    .split(',')
    .map(a => a.trim())
    .filter(Boolean)

  if (Array.isArray(product.custom_attributes)) {
    for (const attr of attributes) {
      const value = getCustomAttributeValue(product, attr)
      if (value === undefined || value === null || value === '') continue
      payload[attr] = value
    }
  }

  const baseUrl = String(params.COMMERCE_BASE_URL || '').replace(/\/$/, '')
  const urlKey = getCustomAttributeValue(product, 'url_key')
  if (typeof urlKey === 'string' && urlKey.trim()) {
    payload.url_key = urlKey
    payload.productUrl = `${baseUrl}/${urlKey}.html`
    payload.url = payload.productUrl
  }

  const imageCandidate = pickFirstValidImage([
    payload.image,
    payload.small_image,
    payload.thumbnail,
    getCustomAttributeValue(product, 'image'),
    getCustomAttributeValue(product, 'small_image'),
    getCustomAttributeValue(product, 'thumbnail'),
    getMediaGalleryImage(product)
  ])

  if (imageCandidate) {
    payload.imageUrl = imageCandidate.startsWith('http')
      ? imageCandidate
      : `${baseUrl}/media/catalog/product${imageCandidate}`
    payload.image = payload.imageUrl
  }

  const configurableOptions = getConfigurableOptions(product)
  if (configurableOptions.length > 0) {
    payload.configurable_options = configurableOptions
    const colorOption = configurableOptions.find(opt => String(opt.label || '').toLowerCase().includes('color'))
    if (colorOption) payload.color_option_count = Number(colorOption.optionCount || 0)
  }

  return payload
}

function pickFirstValidImage(candidates) {
  for (const candidate of candidates) {
    if (typeof candidate !== 'string') continue
    const value = candidate.trim()
    if (!value || value === 'no_selection') continue
    return value
  }
  return undefined
}

function getCustomAttributeValue(product, code) {
  if (!Array.isArray(product.custom_attributes)) return undefined
  const attr = product.custom_attributes.find(ca => ca.attribute_code === code)
  return attr?.value
}

function getMediaGalleryImage(product) {
  if (!Array.isArray(product.media_gallery_entries) || product.media_gallery_entries.length === 0) {
    return undefined
  }
  const first = product.media_gallery_entries.find(item => item?.file)
  return first?.file
}

function getConfigurableOptions(product) {
  const options = product?.extension_attributes?.configurable_product_options
  if (!Array.isArray(options) || options.length === 0) return []
  return options.map(opt => ({
    attributeId: opt?.attribute_id,
    label: opt?.label || '',
    optionCount: Array.isArray(opt?.values) ? opt.values.length : 0
  }))
}

async function storeInQdrant(productId, embedding, payload, settings, logger) {
  const url = `${settings.vectorDbUrl}/collections/products/points`
  const response = await fetch(url, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      'api-key': settings.vectorDbApiKey || ''
    },
    body: JSON.stringify({
      points: [{ id: productId, vector: embedding, payload }]
    })
  })
  if (!response.ok) throw new Error(`Qdrant error: ${response.status} - ${await response.text()}`)
  logger.debug(`Stored ${payload.sku || productId} in Qdrant`)
}

function errorResponse(statusCode, message) {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: { success: false, error: true, message } }
}

exports.main = main
