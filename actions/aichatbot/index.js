/*
 * Adobe App Builder Action
 * AiChatbot – Full port of PHP + Python chatbot logic
 * Includes: intent detection, vector search, product inquiry,
 *           comparison, context tracking, HTML responses
 */

const fetch = globalThis.fetch ? globalThis.fetch.bind(globalThis) : require('node-fetch')
const { Core } = require('@adobe/aio-sdk')
const stateLib = require('@adobe/aio-lib-state')
const { getCommerceToken, getCommerceApiUrl, getCommerceScopeHeaders } = require('../utils')

// ─── Constants ───────────────────────────────────────────────────────────────
const SETTINGS_KEY = 'aichatbot.settings'
const OPENAI_CHAT_MODEL = 'gpt-4o'
const OPENAI_MINI_MODEL = 'gpt-4o-mini'
const OPENAI_EMBED_MODEL = 'text-embedding-ada-002'

// ─── Entry Point ─────────────────────────────────────────────────────────────
async function main(params) {
  const logger = Core.Logger('aichatbot', { level: params.LOG_LEVEL || 'info' })

  try {
    logger.info('✅ Action invoked')

    const { operation, payload = {} } = params

    if (!operation) return errorResponse(400, 'Missing operation')

    const state = await stateLib.init()

    switch (operation) {
      case 'settings-save': return await saveSettings(state, payload, logger, params)
      case 'settings-get': return await getSettings(state, logger)
      case 'chat-ask': return await chatAsk(state, payload, logger, params)
      default: return errorResponse(400, `Unsupported operation: ${operation}`)
    }
  } catch (error) {
    logger.error('🔥 Action crashed: ' + (error.stack || error.message))
    return errorResponse(500, error.message)
  }
}

// ─── Settings Save ────────────────────────────────────────────────────────────
async function saveSettings(state, data, logger, params) {
  logger.info('💾 saveSettings()')

  if (!data || typeof data !== 'object') {
    return errorResponse(400, 'Invalid settings payload')
  }

  // Email validation
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

  if (!data.chatbotEmail) {
    return errorResponse(400, 'Chatbot email is required')
  }

  if (!emailRegex.test(data.chatbotEmail)) {
    return errorResponse(400, 'Invalid email address')
  }

  if (!data.chatbotWhatsapp) {
    return errorResponse(400, 'Chatbot WhatsApp number is required')
  }

  const attributes = (data.productAttributes || '')
    .split(',')
    .map(a => a.trim())
    .filter(Boolean)

  const invalidAttributes = await validateAttributes(attributes, params, logger)

  if (invalidAttributes.length > 0) {
    return errorResponse(400, `Invalid product attributes: ${invalidAttributes.join(', ')}`)
  }

  await state.put(SETTINGS_KEY, JSON.stringify(data), { ttl: stateLib.MAX_TTL })

  logger.info('💾 Settings saved')

  return {
    statusCode: 200,
    body: { success: true, message: 'Settings saved successfully' }
  }
}

async function validateAttributes(attributes, params, logger) {
  const { COMMERCE_BASE_URL } = params
  if (!COMMERCE_BASE_URL) throw new Error('Missing Adobe Commerce Base URL')
  const token = await getCommerceToken(params)

  const invalid = []
  for (const attr of attributes) {
    const url = getCommerceApiUrl(COMMERCE_BASE_URL, `products/attributes/${encodeURIComponent(attr)}`)
    const res = await fetch(url, {
      headers: Object.assign({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, getCommerceScopeHeaders(params), params && params.IMS_ORG_ID ? { 'x-gw-ims-org-id': params.IMS_ORG_ID } : {})
    })
    if (!res.ok) {
      logger.warn(`❌ Attribute validation request failed for ${attr}: HTTP ${res.status}`)
      if (res.status === 401 || res.status === 403) {
        throw new Error(`Adobe Commerce authorization failed (HTTP ${res.status}). Verify COMMERCE_ACCESS_TOKEN is an active PaaS integration token with Catalog product permissions.`)
      }
      invalid.push(attr)
    }
    else logger.info(`✅ Valid attribute: ${attr}`)
  }
  return invalid
}

// ─── Settings Get ─────────────────────────────────────────────────────────────
async function getSettings(state, logger) {
  const result = await state.get(SETTINGS_KEY)
  logger.info('📥 Settings loaded')

  let settings = {}
  if (result?.value) {
    try { settings = typeof result.value === 'string' ? JSON.parse(result.value) : result.value }
    catch (e) { logger.warn('Failed to parse settings: ' + e.message) }
  }
  return { statusCode: 200, body: settings }
}

// ─── Chat Ask (Main Router) ───────────────────────────────────────────────────
async function chatAsk(state, payload, logger, params) {
  const question = String(payload?.question || '').trim()
  const history = Array.isArray(payload?.history) ? payload.history : []
  const lastProducts = Array.isArray(payload?.lastProducts) ? payload.lastProducts : []

  if (!question) return errorResponse(400, 'Missing question')

  // Load settings
  const settingsResult = await state.get(SETTINGS_KEY)
  if (!settingsResult?.value) return errorResponse(400, 'Settings not configured. Please save settings first.')

  let settings
  try { settings = typeof settingsResult.value === 'string' ? JSON.parse(settingsResult.value) : settingsResult.value }
  catch (e) { return errorResponse(500, `Invalid settings: ${e.message}`) }

  if (!settings?.openaiKey) return errorResponse(400, 'Missing OpenAI API key in settings')

  const indexedAttributes = (settings.productAttributes || '')
    .split(',').map(a => a.trim()).filter(Boolean)
  const productLimit = Number(settings.productLimit) || 5

  logger.info(`🗨️  Question: ${question}`)

  // ── STEP 1: PHP-style intent detection ──────────────────────────────────────
  const intent = await detectIntent(question, history, settings.openaiKey, logger)
  logger.info(`🧩 Intent: ${intent.category}`)

  if (lastProducts.length > 0 && isProductReferenceQuery(question)) {
    intent.category = 'product_question'
  }

  // ── STEP 2: Route ────────────────────────────────────────────────────────────
  switch (intent.category) {
    case 'informational':
      return handleInformational(question, history, lastProducts, intent, settings, indexedAttributes, productLimit, logger)

    case 'informational_with_products':
      return handleInformational(question, history, lastProducts, intent, settings, indexedAttributes, productLimit, logger)

    case 'product_search':
      return handleProductSearch(question, history, lastProducts, intent, settings, indexedAttributes, productLimit, logger)

    case 'product_question':
      return handleProductQuestion(question, history, lastProducts, settings, logger)

    case 'general_help':
      return handleGeneralHelp(question, history, settings, logger, params)

    case 'confidential':
      return {
        statusCode: 200,
        body: {
          success: true,
          answer: "I'm sorry, but I can't provide information about internal business data. I'm here to help with products, orders, and shopping assistance. How else can I help?",
          products: [],
          intent: 'confidential'
        }
      }

    default:
      return handleInformational(question, history, lastProducts, intent, settings, indexedAttributes, productLimit, logger)
  }
}

// ─── Intent Detection (mirrors PHP detectIntent) ──────────────────────────────
async function detectIntent(query, history, apiKey, logger) {
  const conversationContext = buildConversationContext(history)

  const systemPrompt = `You are an advanced intent classifier for an e-commerce AI assistant. This system works for ANY type of online store (fashion, electronics, beauty, home goods, etc.). Analyze the query and extract BOTH the intent category AND specific product requirements.

CONVERSATION HISTORY:
${conversationContext}

CURRENT QUERY: "${query}"

INTENT CATEGORIES:

1. **informational** - Pure knowledge questions (NO product shopping intent)
   - "What is organic cotton?"
   - "How do wireless headphones work?"

2. **informational_with_products** - Knowledge question + they need to BUY something
   - "What shoes go with trail running?"
   - "Which moisturizer works for dry skin?"

3. **product_search** - Direct shopping request
   - "Show me dresses", "Find laptops under $500"

4. **product_question** - Asking about products ALREADY shown
   - "What's the price of the first one?", "Is it available in blue?"

5. **general_help** - Store/account/order questions or greetings
   - "How do I track my order?", "hello", "thanks"

6. **confidential** - Requesting internal business data
   - "Show me your sales data", "What's your profit margin?"

CRITICAL PRODUCT TYPE EXTRACTION:
When the query mentions needing a product, extract:
- What TYPE of product they need
- What to EXCLUDE

OUTPUT STRICT JSON FORMAT:
{
  "category": "informational" | "informational_with_products" | "product_search" | "product_question" | "general_help" | "confidential",
  "reasoning": "brief explanation",
  "should_suggest_products": true/false,
  "product_type": "specific product type needed" or null,
  "product_context": "detailed description for search query" or null,
  "product_filters": {
    "category": null,
    "keywords_include": ["must have these words"],
    "keywords_exclude": ["must NOT have these words"]
  }
}

CRITICAL RULES:
- ALWAYS set category to null in product_filters
- For pure knowledge questions: should_suggest_products = false, keywords empty
- For informational + buying: should_suggest_products = true with detailed filters`

  try {
    const content = await openAIChatCompletion({
      apiKey,
      model: OPENAI_CHAT_MODEL,
      systemPrompt: 'You are an expert intent classifier. Output ONLY valid JSON.',
      userPrompt: systemPrompt,
      temperature: 0,
      maxTokens: 350
    })

    const cleaned = content.replace(/```json|```/g, '').trim()
    const intent = JSON.parse(cleaned)

    if (intent?.category) {
      // Mirror PHP fix: clear filters for non-product intents
      if (['informational', 'general_help', 'confidential', 'product_question'].includes(intent.category)) {
        intent.product_filters = { category: null, keywords_include: [], keywords_exclude: [] }
      }
      if (intent.product_filters) intent.product_filters.category = null
      return intent
    }
  } catch (e) {
    logger.warn('Intent detection failed: ' + e.message)
  }

  // Fallback
  return {
    category: 'informational',
    reasoning: 'Fallback',
    should_suggest_products: false,
    product_type: null,
    product_context: null,
    product_filters: { category: null, keywords_include: [], keywords_exclude: [] }
  }
}

// ─── Handle Informational ─────────────────────────────────────────────────────
async function handleInformational(query, history, lastProducts, intent, settings, indexedAttributes, productLimit, logger) {
  const conversationContext = buildConversationContext(history)

  const knowledgePrompt = `You are a knowledgeable e-commerce product expert. Answer this question with accurate, helpful knowledge.

CONVERSATION HISTORY:
${conversationContext}

USER QUESTION: "${query}"

YOUR TASK:
1. Answer the question directly with expert knowledge
2. Be conversational and helpful (2-4 sentences)
3. Use 1-2 emojis if appropriate
4. DO NOT mention specific product names yet
5. DO NOT say "would you like to see products"

CRITICAL FORMATTING RULES:
- Write in natural flowing paragraphs, NOT bullet lists
- Return plain text only
- DO NOT use HTML tags
- DO NOT use markdown syntax
- Keep it conversational

NOW ANSWER: "${query}"`

  let knowledgeAnswer = ''
  try {
    knowledgeAnswer = await openAIChatCompletion({
      apiKey: settings.openaiKey,
      model: OPENAI_CHAT_MODEL,
      systemPrompt: 'You are a knowledgeable product expert. Be helpful and accurate.',
      userPrompt: knowledgePrompt,
      temperature: 0.7,
      maxTokens: 400
    })
  } catch (e) {
    knowledgeAnswer = "I'd be happy to help! Could you provide more details?"
  }

  let products = []

  if (intent.should_suggest_products && intent.product_context && settings.vectorDbUrl) {
    const searchIntent = {
      query: intent.product_context,
      product_filters: intent.product_filters || {},
      gender_filter: null,
      price_filter: null
    }

    products = await searchProducts(searchIntent, settings, indexedAttributes, productLimit, logger)

    // Enhance answer with product names
    if (products.length > 0) {
      const productList = products.slice(0, 5)
        .map((p, i) => `${i + 1}. ${p.name}${p.price > 0.01 ? ' - $' + p.price : ''}`)
        .join('\n')

      const enhancePrompt = `You are enhancing an expert answer with specific product recommendations.

      ORIGINAL EXPERT ANSWER:
      ${knowledgeAnswer}

      AVAILABLE PRODUCTS:
      ${productList}

      Add 1-2 sentences at the end mentioning these specific products by name naturally.
      Example: "For example, check out the [Product Name] or [Product Name]."
      Enhanced answer:`

      try {
        knowledgeAnswer = await openAIChatCompletion({
          apiKey: settings.openaiKey,
          model: OPENAI_MINI_MODEL,
          systemPrompt: 'You are a product expert. Enhance the answer naturally.',
          userPrompt: enhancePrompt,
          temperature: 0.7,
          maxTokens: 150
        })
      } catch (e) { /* keep original */ }
    }
  }

  return {
    statusCode: 200,
    body: { success: true, answer: knowledgeAnswer, products, intent: intent.category, source: 'openai-informational' }
  }
}

// ───                                                                                                      Handle Product Search ────────────────────────────────────────────────────
async function handleProductSearch(query, history, lastProducts, intent, settings, indexedAttributes, productLimit, logger) {
  if (!settings.vectorDbUrl) {
    const answer = await answerGeneral(query, settings)
    return { statusCode: 200, body: { success: true, answer, products: [], intent: 'product_search', source: 'openai-general' } }
  }

  // Extract cumulative search context (mirrors Python extract_search_context_with_ai)
  const searchContext = await extractSearchContext(history, query, settings.openaiKey, logger)

  // Build Python-style intent for vector search
  const pythonIntent = await buildSearchIntent(query, history, lastProducts, settings.openaiKey, logger)

  // Override query with accumulated context if available
  if (searchContext && !searchContext.isNew) {
    pythonIntent.query = searchContext.finalQuery
    logger.info(`🔄 Context query: ${pythonIntent.query}`)
  }

  if (!pythonIntent.price_filter) {
    pythonIntent.price_filter = extractPriceFilterFromQuery(pythonIntent.query || query)
  } else {
    pythonIntent.price_filter = normalizePriceFilter(pythonIntent.price_filter)
  }

  // Apply PHP-style filter validation: clear stale filters
  const filters = intent.product_filters || {}
  if (filters.keywords_include?.length > 0) {
    const queryLower = query.toLowerCase()
    const hasMatch = filters.keywords_include.some(kw => queryLower.includes(kw.toLowerCase()))
    if (!hasMatch) {
      filters.keywords_include = []
      filters.keywords_exclude = []
    }
  }

  const products = await searchProducts(pythonIntent, settings, indexedAttributes, productLimit, logger)

  // Apply PHP keyword filters post-search
  const filteredProducts = applyProductFilters(products, filters, logger)
  const constraintQuery = pythonIntent.query || query
  const constrainedProducts = applyExplicitQueryConstraints(constraintQuery, filteredProducts, logger)

  const answer = await generateSearchAnswer(query, constrainedProducts, pythonIntent, history, settings, logger)

  return {
    statusCode: 200,
    body: { success: true, answer, products: constrainedProducts, intent: 'product_search', source: 'vector-search' }
  }
}

// ─── Handle Product Question ──────────────────────────────────────────────────
async function handleProductQuestion(query, history, lastProducts, settings, logger) {
  const referencedProduct = resolveReferencedProduct(query, lastProducts)
  if (referencedProduct) {
    const name = referencedProduct.name || 'that product'
    const url = referencedProduct.url || referencedProduct.productUrl || ''
    const linkText = url ? ` You can view it here: ${url}` : ''
    return {
      statusCode: 200,
      body: {
        success: true,
        answer: `Great choice. The item you referenced is "${name}".${linkText}`,
        products: [],
        intent: 'product_question',
        source: 'product-reference'
      }
    }
  }

  const conversationContext = buildConversationContext(history)
  const productsContext = lastProducts.length > 0 ? JSON.stringify(lastProducts, null, 2) : 'No products shown'

  const systemPrompt = `You are helping a customer ask about products they just saw.

CONVERSATION:
${conversationContext}

PRODUCTS SHOWN:
${productsContext}

QUESTION: "${query}"

Answer their question about the shown products. Be specific and reference product names/positions.
Use ONLY facts that appear in PRODUCTS SHOWN.

STRICT FACTUAL RULES:
- Never infer color/size/stock/options from product type or assumptions
- If a requested detail is not present in PRODUCTS SHOWN, reply exactly:
  "That information isn't listed in the synced product data."
- When possible, include the product URL from PRODUCTS SHOWN for verification

FORMATTING RULES:
- Return plain text only
- DO NOT use HTML tags
- DO NOT use markdown syntax

Answer:`

  try {
    const message = await openAIChatCompletion({
      apiKey: settings.openaiKey,
      model: OPENAI_MINI_MODEL,
      systemPrompt: 'You are a helpful product assistant.',
      userPrompt: systemPrompt,
      temperature: 0,
      maxTokens: 300
    })
    return { statusCode: 200, body: { success: true, answer: message, products: [], intent: 'product_question', source: 'openai' } }
  } catch (e) {
    return { statusCode: 200, body: { success: true, answer: "Could you clarify which product you're asking about?", products: [], intent: 'product_question', source: 'openai' } }
  }
}

// ─── Handle General Help ──────────────────────────────────────────────────────
async function handleGeneralHelp(query, history, settings, logger, params) {
  const queryLower = query.trim().toLowerCase()
  const awaitingOrderTrackingDetails = history
    .slice(-4)
    .some(m => String(m?.role || '').toLowerCase() === 'assistant' && /order number.*email/i.test(String(m?.content || '')))

  const isTrackingIntent = isOrderTrackingIntent(queryLower)
  const trackingInput = extractOrderTrackingInput(query)

  if (isTrackingIntent && (!trackingInput.orderNumber || !trackingInput.email)) {
    return {
      statusCode: 200,
      body: {
        success: true,
        answer: 'Please provide your order number and email address to track your order.',
        products: [],
        intent: 'general_help',
        source: 'order-tracking',
        awaitingOrderTracking: true
      }
    }
  }

  if (awaitingOrderTrackingDetails || (trackingInput.orderNumber && trackingInput.email)) {
    if (!trackingInput.orderNumber || !trackingInput.email) {
      const missing = !trackingInput.orderNumber ? 'order number' : 'email address'
      return {
        statusCode: 200,
        body: {
          success: true,
          answer: `Please share your ${missing} so I can track your order.`,
          products: [],
          intent: 'general_help',
          source: 'order-tracking',
          awaitingOrderTracking: true
        }
      }
    }

    if (!isValidEmail(trackingInput.email)) {
      return {
        statusCode: 200,
        body: {
          success: true,
          answer: 'Please enter a valid email address.',
          products: [],
          intent: 'general_help',
          source: 'order-tracking',
          awaitingOrderTracking: true
        }
      }
    }

    try {
      const trackedOrder = await fetchOrderByIncrementId(params, trackingInput.orderNumber)
      if (!trackedOrder) {
        return {
          statusCode: 200,
          body: {
            success: true,
            answer: `I couldn't find an order with number ${trackingInput.orderNumber}. Please re-check the order number and try again.`,
            products: [],
            intent: 'general_help',
            source: 'order-tracking',
            awaitingOrderTracking: false
          }
        }
      }

      const fetchedEmail = String(trackedOrder.customer_email || '').trim().toLowerCase()
      const enteredEmail = String(trackingInput.email || '').trim().toLowerCase()
      if (!fetchedEmail || fetchedEmail !== enteredEmail) {
        return {
          statusCode: 200,
          body: {
            success: true,
            answer: `The entered email address (${trackingInput.email}) does not match the order email address. Please use the email used while placing order ${trackingInput.orderNumber}.`,
            products: [],
            intent: 'general_help',
            source: 'order-tracking',
            awaitingOrderTracking: true
          }
        }
      }

      const orderDate = trackedOrder.created_at ? new Date(trackedOrder.created_at).toLocaleDateString('en-US') : 'N/A'
      const status = normalizeOrderStatus(trackedOrder.status)
      const total = Number(trackedOrder.grand_total || 0).toFixed(2)
      const currency = trackedOrder.order_currency_code || ''
      const orderInfoUrl = buildOrderInfoUrl(params, trackedOrder)
      const trackingSummary = [
        [
          'Order Tracking Request:',
          `Order No. ${trackingInput.orderNumber},`,
          `Email: ${trackingInput.email}`,
          `Thank you! I'm now looking up order ${trackingInput.orderNumber} associated with ${trackingInput.email}. Please wait a moment.`
        ].join('\n'),
        [
          `Order ${trackedOrder.increment_id || trackingInput.orderNumber} is currently ${status}. Placed on ${orderDate}. Total: ${currency ? `${currency} ` : '$'}${total}.`,
          `your order info link is here : [Your order Info.](${orderInfoUrl})`
        ].join('\n')
      ]

      return {
        statusCode: 200,
        body: {
          success: true,
          answer: trackingSummary,
          products: [],
          intent: 'general_help',
          source: 'order-tracking',
          awaitingOrderTracking: false
        }
      }
    } catch (e) {
      logger.warn(`Order tracking failed: ${e.message}`)
      const status = Number(e?.status || 0)
      const isAuthError = status === 401 || status === 403 || /isn't authorized|not authorized/i.test(String(e?.message || ''))
      const answer = isAuthError
        ? 'Order tracking API is not authorized. Please update COMMERCE_ACCESS_TOKEN permissions for order view access and try again.'
        : 'I could not fetch order status right now. Please try again in a moment.'
      return {
        statusCode: 200,
        body: {
          success: true,
          answer,
          products: [],
          intent: 'general_help',
          source: 'order-tracking',
          awaitingOrderTracking: false
        }
      }
    }
  }

  // Quick greeting check for short queries
  if (query.split(' ').length <= 3) {
    try {
      const isGreeting = await openAIChatCompletion({
        apiKey: settings.openaiKey,
        model: OPENAI_MINI_MODEL,
        systemPrompt: 'You are a classifier. Answer ONLY yes or no.',
        userPrompt: `Is this a simple greeting or thank you? Answer ONLY 'yes' or 'no'.\n\nMessage: "${query}"`,
        temperature: 0,
        maxTokens: 5
      })
      if (isGreeting.trim().toLowerCase() === 'yes') {
        const responses = [
          'Hi! How can I help you today?',
          'Hello! What can I assist you with?',
          'Hey there! How can I help?',
          'Hi! What are you looking for today?'
        ]
        const answer = responses[Math.floor(Math.random() * responses.length)]
        return { statusCode: 200, body: { success: true, answer, products: [], intent: 'general_help', source: 'openai' } }
      }
    } catch (e) { /* continue */ }
  }

  const conversationContext = buildConversationContext(history)

  const systemPrompt = `You are a friendly customer service assistant.

CONVERSATION:
${conversationContext}

QUESTION: "${query}"

CRITICAL RULES:
1. Be brief and helpful (1-2 sentences only)
2. DO NOT list store pages or links unless specifically asked
3. DO NOT use bullet points or lists
4. Write in natural flowing text
5. Be conversational and warm

FORMATTING RULES:
- Return plain text only
- DO NOT use HTML tags
- DO NOT use markdown syntax

Response:`

  try {
    const answer = await openAIChatCompletion({
      apiKey: settings.openaiKey,
      model: OPENAI_MINI_MODEL,
      systemPrompt: 'You are a friendly customer service assistant.',
      userPrompt: systemPrompt,
      temperature: 0.8,
      maxTokens: 100
    })
    return { statusCode: 200, body: { success: true, answer, products: [], intent: 'general_help', source: 'openai' } }
  } catch (e) {
    return { statusCode: 200, body: { success: true, answer: 'Hi! How can I help you today?', products: [], intent: 'general_help', source: 'openai' } }
  }
}

function isOrderTrackingIntent(queryLower) {
  const q = String(queryLower || '')
  return /track.*order|order.*track|order status|status of my order|where is my order|track my order/.test(q)
}

function extractOrderTrackingInput(query) {
  const text = String(query || '')
  const emailMatch = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)
  const email = emailMatch ? emailMatch[0].trim().toLowerCase() : ''

  let orderNumber = ''
  const explicitPatterns = [
    /order\s*(?:number|no|#)\s*[:\-]?\s*([A-Za-z0-9-]{4,})/i,
    /order\s*[:\-]\s*([A-Za-z0-9-]{4,})/i,
    /order\s+([0-9]{4,})/i
  ]
  for (const pattern of explicitPatterns) {
    const match = text.match(pattern)
    if (match && match[1]) {
      orderNumber = match[1]
      break
    }
  }
  if (!orderNumber) {
    const hash = text.match(/#\s*([A-Za-z0-9-]{4,})/)
    if (hash && hash[1]) orderNumber = hash[1]
  }
  if (!orderNumber) {
    const candidates = text.match(/[A-Za-z0-9-]{4,}/g) || []
    const likely = candidates.find(token => /\d{3,}/.test(token))
    orderNumber = likely || ''
  }

  return { orderNumber: orderNumber.trim(), email }
}

async function fetchOrderByIncrementId(params, orderNumber) {
  const { COMMERCE_BASE_URL } = params || {}
  if (!COMMERCE_BASE_URL) {
    throw new Error('Missing Adobe Commerce Base URL for order tracking')
  }
  const token = await getCommerceToken(params)

  const response = await fetch(getCommerceApiUrl(COMMERCE_BASE_URL, `orders/${encodeURIComponent(String(orderNumber))}`), {
    method: 'GET',
    headers: Object.assign({
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    }, getCommerceScopeHeaders(params), params && params.IMS_ORG_ID ? { 'x-gw-ims-org-id': params.IMS_ORG_ID } : {})
  })

  if (response.status === 404) {
    return null
  }

  if (!response.ok) {
    let apiMessage = `Adobe Commerce API error: ${response.status}`
    try {
      const errorPayload = await response.json()
      if (errorPayload?.message) {
        apiMessage = `Adobe Commerce API error: ${response.status} - ${errorPayload.message}`
      }
    } catch (e) { /* keep default message */ }
    const error = new Error(apiMessage)
    error.status = response.status
    throw error
  }

  const data = await response.json()
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    return data
  }
  return null
}

function buildOrderInfoUrl(params, order) {
  const { COMMERCE_STORE_BASE_URL, COMMERCE_BASE_URL } = params || {}
  const entityId = Number(order?.entity_id || 0)
  if (!entityId) return ''

  const rawBase = String(COMMERCE_STORE_BASE_URL || COMMERCE_BASE_URL || '').trim()
  if (!rawBase) return ''

  const normalizedBase = rawBase
    .replace(/\/rest(?:\/V1)?\/?$/i, '')
    .replace(/\/$/, '')

  return `${normalizedBase}/sales/order/view/order_id/${entityId}/`
}

function isValidEmail(email) {
  const value = String(email || '').trim()
  return /^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$/i.test(value)
}

function normalizeOrderStatus(rawStatus) {
  const s = String(rawStatus || '').toLowerCase()
  if (!s) return 'in progress'
  const map = {
    pending: 'pending',
    processing: 'processing',
    complete: 'complete',
    closed: 'closed',
    canceled: 'canceled',
    holded: 'on hold',
    payment_review: 'under payment review'
  }
  return map[s] || s.replace(/_/g, ' ')
}

function normalizePriceFilter(raw) {
  if (!raw || typeof raw !== 'object') return null
  const op = String(raw.op || '').toLowerCase()
  const value = Number(raw.value)
  if (!Number.isFinite(value)) return null
  if (op === 'lt' || op === 'gt') return { op, value }
  if (op === 'lte') return { op: 'lt', value: value + 0.000001 }
  if (op === 'gte') return { op: 'gt', value: value - 0.000001 }
  if (op === 'range') {
    const min = Number(raw.min)
    const max = Number(raw.max)
    if (Number.isFinite(min) && Number.isFinite(max)) {
      return { op: 'range', min, max }
    }
  }
  return null
}

function extractPriceFilterFromQuery(query) {
  const q = String(query || '').toLowerCase()
  if (!q) return null

  const between = q.match(/between\s*\$?\s*([\d,.]+)\s*(?:and|to)\s*\$?\s*([\d,.]+)/i)
  if (between) {
    const min = Number(String(between[1]).replace(/,/g, ''))
    const max = Number(String(between[2]).replace(/,/g, ''))
    if (Number.isFinite(min) && Number.isFinite(max)) return { op: 'range', min, max }
  }

  const under = q.match(/(?:under|below|less than|upto|up to|max(?:imum)?|<=|<)\s*\$?\s*([\d,.]+)/i)
  if (under) {
    const value = Number(String(under[1]).replace(/,/g, ''))
    if (Number.isFinite(value)) return { op: 'lt', value }
  }

  const over = q.match(/(?:over|above|more than|greater than|>=|>|at least|min(?:imum)?)\s*\$?\s*([\d,.]+)/i)
  if (over) {
    const value = Number(String(over[1]).replace(/,/g, ''))
    if (Number.isFinite(value)) return { op: 'gt', value }
  }

  return null
}

// ─── Extract Search Context (mirrors Python extract_search_context_with_ai) ───
async function extractSearchContext(history, currentQuery, apiKey, logger) {
  if (!history || history.length < 2) return null

  const conversation = history.slice(-10).map(msg =>
    msg.role === 'user' ? `User: ${msg.content}` : 'Assistant: [showed products]'
  ).join('\n')

  const contextPrompt = `You are a search refinement analyzer. Extract accumulated FILTERS from this conversation.

CONVERSATION:
${conversation}

CURRENT QUERY: "${currentQuery}"

TASK: Determine what FILTERS the user has accumulated, and if they're changing PRODUCT TYPE.

FILTERS are: colors, sizes, materials, brands, features, price ranges
PRODUCT TYPES are: tshirts, hoodies, bags, phones, shoes, etc.

OUTPUT FORMAT - Return JSON:
{
  "accumulated_filters": ["filter1", "filter2"],
  "new_product_type": "product" or null,
  "final_query": "combined search query"
}

EXAMPLES:
- "show me tshirts" → "only red" → final_query: "red tshirts"
- "show me tshirts" → "only red" → "v-neck" → final_query: "red v-neck tshirts"
- "show me bags" → "show me laptops instead" → final_query: "NEW"

If completely new search, final_query should be "NEW".
YOUR ANSWER (JSON only):`

  try {
    const content = await openAIChatCompletion({
      apiKey,
      model: OPENAI_MINI_MODEL,
      systemPrompt: 'You are a search context analyzer. Output ONLY valid JSON.',
      userPrompt: contextPrompt,
      temperature: 0,
      maxTokens: 150
    })

    const cleaned = content.replace(/```json|```/g, '').trim()
    const result = JSON.parse(cleaned)
    const finalQuery = result.final_query || ''

    if (finalQuery.toUpperCase() === 'NEW') {
      logger.info('🆕 New search detected, ignoring context')
      return { isNew: true, finalQuery: currentQuery }
    }

    logger.info(`🔄 Context: ${JSON.stringify(result.accumulated_filters)} → "${finalQuery}"`)
    return { isNew: false, finalQuery, filters: result.accumulated_filters || [] }
  } catch (e) {
    logger.warn('Context extraction failed: ' + e.message)
    return null
  }
}

// ─── Build Python-style Search Intent ────────────────────────────────────────
async function buildSearchIntent(query, history, lastProducts, apiKey, logger) {
  const conversationContext = buildConversationContext(history)

  const productsContext = lastProducts.length > 0
    ? '\n\nRECENTLY SHOWN PRODUCTS:\n' + lastProducts.map((p, i) => `${i + 1}. '${p.name}' (SKU: ${p.sku})`).join('\n')
    : ''

  const systemPrompt = `You are an intelligent intent classifier for an e-commerce chatbot.

CONVERSATION HISTORY:
${conversationContext}
${productsContext}

CURRENT QUERY: "${query}"

OUTPUT ONLY JSON:
{
  "type": "chat"|"search"|"product_inquiry"|"comparison",
  "query": "CUMULATIVE search terms combining all user constraints",
  "is_refinement": true|false,
  "position_reference": "first"|"second"|"third"|"last"|null,
  "position_references": ["first","last"]|null,
  "specific_sku": "SKU if mentioned"|null,
  "gender_filter": "men"|"women"|"kids"|null,
  "price_filter": {"op":"lt"|"gt","value":number}|null
}

CRITICAL FOR "query": Combine ALL accumulated constraints from history.`

  try {
    const content = await openAIChatCompletion({
      apiKey,
      model: OPENAI_MINI_MODEL,
      systemPrompt: 'You are an intent classifier. Output ONLY valid JSON.',
      userPrompt: systemPrompt,
      temperature: 0,
      maxTokens: 200
    })

    const cleaned = content.replace(/```json|```/g, '').trim()
    const parsed = JSON.parse(cleaned)

    // Resolve position references for product_inquiry
    if (parsed.type === 'product_inquiry' && lastProducts.length > 0) {
      const posMap = { first: 0, '1st': 0, second: 1, '2nd': 1, third: 2, '3rd': 2, fourth: 3, last: -1 }
      const ref = parsed.position_reference
      if (ref && posMap[ref] !== undefined) {
        const pos = posMap[ref] === -1 ? lastProducts.length - 1 : posMap[ref]
        const product = lastProducts[pos]
        if (product) {
          parsed.specific_sku = product.sku
          parsed.resolved_product = product
          parsed.mode = 'context'
        }
      }
    }

    // Resolve comparison position references
    if (parsed.type === 'comparison' && lastProducts.length >= 2) {
      const posMap = { first: 0, '1st': 0, one: 0, second: 1, '2nd': 1, two: 1, third: 2, '3rd': 2, three: 2, last: -1 }
      const refs = parsed.position_references || []
      if (refs.length >= 2) {
        const selected = refs.map(r => {
          const pos = posMap[r] === -1 ? lastProducts.length - 1 : posMap[r]
          return lastProducts[pos]
        }).filter(Boolean)
        if (selected.length >= 2) parsed.products_to_compare = selected
      } else {
        parsed.products_to_compare = lastProducts
      }
    }

    if (!parsed.price_filter) {
      parsed.price_filter = extractPriceFilterFromQuery(query)
    } else {
      parsed.price_filter = normalizePriceFilter(parsed.price_filter)
    }

    return parsed
  } catch (e) {
    logger.warn('buildSearchIntent failed: ' + e.message)
    return { type: 'search', query, gender_filter: null, price_filter: extractPriceFilterFromQuery(query), mode: 'search' }
  }
}

// ─── Vector Search (Qdrant) ───────────────────────────────────────────────────
async function searchProducts(intent, settings, indexedAttributes, productLimit, logger) {
  const queryText = intent.query || ''
  const genderFilter = intent.gender_filter
  const specificSku = intent.specific_sku
  const priceFilter = normalizePriceFilter(intent.price_filter)

  logger.info(`🔍 Vector search: "${queryText}" | gender: ${genderFilter} | sku: ${specificSku}`)
  const keepVariants = shouldKeepVariants(queryText)

  // MODE 2: Return cached resolved product
  if (intent.mode === 'context' && intent.resolved_product) {
    logger.info('✅ MODE 2: Returning cached product')
    return [intent.resolved_product]
  }

  // Generate embedding
  let embedding = []
  try {
    embedding = await createEmbedding(queryText, settings.openaiKey)
  } catch (e) {
    logger.warn('❌ Failed to generate embedding: ' + e.message)
    return []
  }
  if (!embedding || embedding.length === 0) {
    logger.warn('❌ Failed to generate embedding')
    return []
  }

  const vectorDbUrl = settings.vectorDbUrl
  if (!vectorDbUrl) return []

  // Build where clause for price filter
  let filter = null
  if (priceFilter) {
    try {
      if (priceFilter.op === 'range') {
        filter = { must: [{ key: 'price', range: { gte: priceFilter.min, lte: priceFilter.max } }] }
      } else {
        const { op, value } = priceFilter
        filter = { must: [{ key: 'price', range: op === 'lt' ? { lt: value } : { gt: value } }] }
      }
    } catch (e) { /* ignore */ }
  }

  // SKU-specific search
  if (specificSku) {
    const results = await qdrantSearch(vectorDbUrl, embedding, productLimit * 4, filter, logger, settings.vectorDbApiKey)
    logger.info(`🎯 SKU lookup trace: looking for "${specificSku}" in ${results.length} candidates`)
    const hit = results.find(h => h.payload?.sku === specificSku)
    if (hit) {
      logger.info(`✅ SKU matched directly: ${hit.payload?.sku} | name="${hit.payload?.name || ''}"`)
      return [normalizeProduct(hit)]
    }
    logger.info(`❌ SKU not found in vector candidates: "${specificSku}"`)
    return []
  }

  // General vector search - fetch more candidates for filtering
  const candidates = await qdrantSearch(vectorDbUrl, embedding, productLimit * 10, filter, logger, settings.vectorDbApiKey)
  if (!candidates.length) return []

  const bestDist = candidates[0].score
  const threshold = bestDist > 0.7 ? 0.4 : bestDist > 0.5 ? 0.5 : 0.6

  logger.info(`📊 Best score: ${bestDist.toFixed(3)} | Threshold: ${threshold.toFixed(3)}`)

  // Extract meaningful search terms
  const stopWords = new Set(['the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of', 'with', 'by', 'show', 'me', 'find', 'get', 'i', 'want'])
  const queryTerms = queryText.toLowerCase().split(/\s+/).filter(t => t.length > 2 && !stopWords.has(t))
  const normalizedTerms = queryTerms.map(normalizeSearchTerm).filter(Boolean)
  const typoMap = { bagpack: 'backpack', bagpacks: 'backpack', 'waterbottle': 'bottle', tshirt: 'shirt', 't-shirt': 'shirt' }
  const expandedTerms = new Set([
    ...queryTerms,
    ...normalizedTerms,
    ...queryTerms.map(t => typoMap[t]).filter(Boolean),
    ...normalizedTerms.map(t => typoMap[t]).filter(Boolean)
  ])
  const expandedTermsList = [...expandedTerms]

  logger.info(`🧪 Search terms used for field matching: ${JSON.stringify(expandedTermsList)}`)
  logger.info(`🧪 Indexed attributes in settings: ${JSON.stringify(indexedAttributes || [])}`)

  const products = []
  let rejectedCount = 0
  let tracedCandidates = 0
  const traceLimit = 12

  for (const hit of candidates) {
    if (hit.score < threshold) {
      if (tracedCandidates < traceLimit) {
        const payload = hit.payload || {}
        logger.info(`⏭️ Rejected by score: sku=${payload.sku || '-'} | name="${payload.name || ''}" | score=${Number(hit.score || 0).toFixed(3)} < threshold=${threshold.toFixed(3)}`)
        tracedCandidates += 1
      }
      continue
    }

    if (!isVisibleProduct(hit.payload)) {
      logger.info(`⏭️ Rejected by visibility/status: sku=${hit.payload?.sku || '-'} | visibility=${hit.payload?.visibility} | status=${hit.payload?.status}`)
      continue
    }

    if (tracedCandidates < traceLimit) {
      const trace = buildFieldMatchTrace(hit.payload || {}, expandedTermsList, indexedAttributes)
      logger.info(`🔎 Candidate trace: sku=${trace.sku} | name="${trace.name}" | score=${Number(hit.score || 0).toFixed(3)} | matched_fields=${trace.matchedFields.join(', ') || 'none'} | terms=${JSON.stringify(trace.matchedTermsByField)}`)
      tracedCandidates += 1
    }

    // Gender filter
    if (genderFilter) {
      const cat = (hit.payload?.category_names || '').toLowerCase()
      if (genderFilter === 'men' && cat.includes('women') && !cat.includes('men')) {
        logger.info(`⏭️ Rejected by gender filter(men): sku=${hit.payload?.sku || '-'} | category="${hit.payload?.category_names || ''}"`)
        continue
      }
      if (genderFilter === 'women' && cat.includes('men') && !cat.includes('women')) {
        logger.info(`⏭️ Rejected by gender filter(women): sku=${hit.payload?.sku || '-'} | category="${hit.payload?.category_names || ''}"`)
        continue
      }
      if (genderFilter === 'kids' && !cat.includes('kid') && !cat.includes('child')) {
        logger.info(`⏭️ Rejected by gender filter(kids): sku=${hit.payload?.sku || '-'} | category="${hit.payload?.category_names || ''}"`)
        continue
      }
    }

    // Attribute filtering (strict)
    if (indexedAttributes.length > 0) {
      const indexedSearchText = buildIndexedAttributeSearchText(hit.payload || {}, indexedAttributes)
      const hasMatch = [...expandedTerms].some(term => indexedSearchText.includes(term))
      if (!hasMatch) {
        rejectedCount++
        logger.info(`⏭️ Rejected by indexed-attribute filter: sku=${hit.payload?.sku || '-'} | name="${hit.payload?.name || ''}"`)
        continue
      }
    }

    logger.info(`✅ Accepted: sku=${hit.payload?.sku || '-'} | name="${hit.payload?.name || ''}"`)
    const normalized = normalizeProduct(hit)
    if (priceFilter) {
      const priceValue = Number(normalized.price || 0)
      if (!Number.isFinite(priceValue) || priceValue <= 0) {
        continue
      }
      if (priceFilter.op === 'lt' && priceValue >= priceFilter.value) continue
      if (priceFilter.op === 'gt' && priceValue <= priceFilter.value) continue
      if (priceFilter.op === 'range' && (priceValue < priceFilter.min || priceValue > priceFilter.max)) continue
    }
    products.push(normalized)
    if (products.length >= productLimit) break
  }

  logger.info(`✅ ${products.length} products (${rejectedCount} rejected)`)

  // Smart fallback: if strict filtering returned 0, retry without attribute filter
  if (products.length === 0 && indexedAttributes.length > 0 && rejectedCount > 0) {
    logger.info('🔄 Fallback: retrying without attribute filter')
    const fallback = []
    for (const hit of candidates) {
      if (hit.score < threshold) continue
      if (genderFilter) {
        const cat = (hit.payload?.category_names || '').toLowerCase()
        if (genderFilter === 'men' && cat.includes('women')) continue
        if (genderFilter === 'women' && cat.includes('men')) continue
      }
      if (!isVisibleProduct(hit.payload)) continue
      const normalized = normalizeProduct(hit)
      if (priceFilter) {
        const priceValue = Number(normalized.price || 0)
        if (!Number.isFinite(priceValue) || priceValue <= 0) {
          continue
        }
        if (priceFilter.op === 'lt' && priceValue >= priceFilter.value) continue
        if (priceFilter.op === 'gt' && priceValue <= priceFilter.value) continue
        if (priceFilter.op === 'range' && (priceValue < priceFilter.min || priceValue > priceFilter.max)) continue
      }
      fallback.push(normalized)
      if (fallback.length >= productLimit) break
    }
    const dedupedFallback = keepVariants ? fallback : dedupeVariantProducts(fallback, logger)
    return dedupedFallback.slice(0, productLimit)
  }

  const dedupedProducts = keepVariants ? products : dedupeVariantProducts(products, logger)
  return dedupedProducts.slice(0, productLimit)
}

function buildFieldMatchTrace(payload, terms, indexedAttributes) {
  const name = String(payload.name || '')
  const sku = String(payload.sku || '')
  const category = String(payload.category_names || '')
  const description = String(payload.description_text || '')

  const indexedValues = []
  for (const attr of indexedAttributes || []) {
    const raw = payload[attr]
    if (raw === undefined || raw === null || raw === '') continue
    indexedValues.push(`${attr}:${Array.isArray(raw) ? raw.join(', ') : String(raw)}`)
  }
  const indexedText = indexedValues.join(' | ')

  const fields = {
    name: name.toLowerCase(),
    sku: sku.toLowerCase(),
    category: category.toLowerCase(),
    indexed_attributes: indexedText.toLowerCase(),
    description_text: description.toLowerCase()
  }

  const matchedTermsByField = {}
  const matchedFields = []
  for (const [fieldName, fieldValue] of Object.entries(fields)) {
    const matches = terms.filter(t => fieldValue.includes(t))
    if (matches.length > 0) {
      matchedFields.push(fieldName)
      matchedTermsByField[fieldName] = matches
    }
  }

  return { sku, name, matchedFields, matchedTermsByField }
}

function buildIndexedAttributeSearchText(payload, indexedAttributes) {
  const core = [
    payload?.name || '',
    payload?.sku || '',
    payload?.category_names || '',
    payload?.description_text || ''
  ].join(' ')

  if (!indexedAttributes || indexedAttributes.length === 0) {
    return normalizeTextForMatch(core)
  }

  const indexedValues = []
  for (const attr of indexedAttributes) {
    const raw = payload?.[attr]
    if (raw === undefined || raw === null || raw === '') continue
    indexedValues.push(Array.isArray(raw) ? raw.join(' ') : String(raw))
  }

  return normalizeTextForMatch([core, indexedValues.join(' ')].join(' '))
}

function isVisibleProduct(payload) {
  if (!payload) return true
  const visibility = Number(payload.visibility)
  if (Number.isFinite(visibility) && visibility > 0 && visibility === 1) return false

  const status = Number(payload.status)
  if (Number.isFinite(status) && status > 0 && status !== 1) return false

  return true
}

function normalizeSearchTerm(term) {
  const t = String(term || '').trim().toLowerCase()
  if (!t) return ''
  if (t.length > 5 && t.endsWith('ing')) return t.slice(0, -3)
  if (t.length > 4 && t.endsWith('ed')) return t.slice(0, -2)
  if (t.length > 4 && t.endsWith('es')) return t.slice(0, -2)
  if (t.length > 3 && t.endsWith('s')) return t.slice(0, -1)
  return t
}

function shouldKeepVariants(queryText) {
  const q = String(queryText || '').toLowerCase()
  if (!q) return false
  // If user asks for variant-level constraints, keep size/color-specific results.
  return /\b(size|sizes|small|medium|large|xl|xxl|xs|waist|inseam)\b/.test(q)
}

function dedupeVariantProducts(products, logger) {
  const seen = new Set()
  const deduped = []

  for (const product of products || []) {
    const key = buildVariantGroupKey(product)
    if (seen.has(key)) continue
    seen.add(key)
    deduped.push(product)
  }

  if (deduped.length !== products.length) {
    logger.info(`🧹 Variant dedupe applied: kept ${deduped.length} of ${products.length}`)
  }
  return deduped
}

function buildVariantGroupKey(product) {
  const name = String(product?.name || '')
  const sku = String(product?.sku || '')
  const url = String(product?.url || product?.productUrl || '')

  // Prefer grouping by canonicalized name (remove likely trailing variant tokens).
  const canonicalName = name
    .replace(/-(xxxl|xxl|xl|xs|s|m|l)\b/ig, '')
    .replace(/-(black|white|blue|red|green|yellow|pink|purple|navy|maroon)\b/ig, '')
    .replace(/-{2,}/g, '-')
    .replace(/-$/, '')
    .trim()
    .toLowerCase()

  if (canonicalName) return `name:${canonicalName}`
  if (url) return `url:${url.toLowerCase()}`
  if (sku) return `sku:${sku.split('-').slice(0, 2).join('-').toLowerCase()}`
  return `raw:${JSON.stringify(product || {})}`
}

function applyExplicitQueryConstraints(query, products, logger) {
  const constraints = extractQueryConstraints(query)
  if (!constraints.hasAny) return products

  const filtered = (products || []).filter(product => {
    const category = String(product?.category_names || '').toLowerCase()
    const sku = String(product?.sku || '').toLowerCase()
    const searchable = normalizeTextForMatch([
      product?.name || '',
      product?.sku || '',
      product?.category_names || '',
      JSON.stringify(product?.attributes || {})
    ].join(' '))

    if (constraints.gender === 'women') {
      const genderMatched = category.includes('women') || category.includes('female') || sku.startsWith('ws')
      if (!genderMatched) return false
    }
    if (constraints.gender === 'men') {
      const genderMatched = category.includes('men') || category.includes('male') || sku.startsWith('ms')
      if (!genderMatched) return false
    }
    if (constraints.gender === 'kids') {
      const genderMatched = category.includes('kid') || category.includes('child') || category.includes('junior')
      if (!genderMatched) return false
    }

    if (constraints.colors.length > 0) {
      const hasColor = constraints.colors.some(color => searchable.includes(color))
      if (!hasColor) return false
    }

    if (constraints.productTerms.length > 0) {
      const hasType = constraints.productTerms.some(term => searchable.includes(term))
      if (!hasType) return false
    }

    if (constraints.price) {
      const priceValue = Number(product?.price || 0)
      if (!Number.isFinite(priceValue) || priceValue <= 0) return false
      if (constraints.price.op === 'lt' && priceValue >= constraints.price.value) return false
      if (constraints.price.op === 'gt' && priceValue <= constraints.price.value) return false
      if (constraints.price.op === 'range' && (priceValue < constraints.price.min || priceValue > constraints.price.max)) return false
    }

    return true
  })

  logger.info(`🎯 Explicit constraint filter: kept ${filtered.length}/${products.length} for query="${query}" with constraints=${JSON.stringify(constraints)}`)
  return filtered
}

function extractQueryConstraints(query) {
  const q = String(query || '').toLowerCase()
  const colors = ['black', 'white', 'blue', 'red', 'green', 'yellow', 'pink', 'purple', 'navy', 'maroon', 'grey', 'gray']
  const productTerms = [
    'tee', 'tees', 'tshirt', 'tshirts', 't-shirt', 't-shirts', 'shirt', 'top', 'tank', 'tank top',
    'pant', 'pants', 'short', 'shorts', 'jacket', 'hoodie', 'bag', 'bags', 'backpack', 'backpacks', 'shoe', 'shoes'
  ].map(normalizeTextForMatch)

  let gender = null
  if (/\bwomen\b|\bwomen's\b|\bfemale\b|\blad(y|ies)\b/.test(q)) gender = 'women'
  else if (/\bmen\b|\bmen's\b|\bmale\b/.test(q)) gender = 'men'
  else if (/\bkids?\b|\bchildren\b|\bjuniors?\b/.test(q)) gender = 'kids'

  const normalizedQuery = normalizeTextForMatch(q)
  const matchedColors = colors.filter(color => normalizedQuery.includes(color))
  const matchedTerms = productTerms.filter(term => normalizedQuery.includes(term))
  const price = extractPriceFilterFromQuery(q)

  return {
    hasAny: !!gender || matchedColors.length > 0 || matchedTerms.length > 0 || !!price,
    gender,
    colors: matchedColors,
    productTerms: matchedTerms,
    price
  }
}

function normalizeTextForMatch(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function isProductReferenceQuery(query) {
  const q = String(query || '').toLowerCase()
  return /\b(last|first|second|third|fourth|1st|2nd|3rd|4th)\b/.test(q) || /\b(that|this)\s+one\b/.test(q)
}

function resolveReferencedProduct(query, products) {
  if (!products || products.length === 0) return null
  const q = String(query || '').toLowerCase()
  const posMap = {
    first: 0, '1st': 0,
    second: 1, '2nd': 1,
    third: 2, '3rd': 2,
    fourth: 3, '4th': 3,
    last: -1
  }

  for (const key of Object.keys(posMap)) {
    if (q.includes(key)) {
      const idx = posMap[key] === -1 ? products.length - 1 : posMap[key]
      return products[idx] || null
    }
  }

  if (/\b(that|this)\s+one\b/.test(q)) {
    return products[products.length - 1] || null
  }

  return null
}

// ─── Qdrant HTTP Search ───────────────────────────────────────────────────────
async function qdrantSearch(vectorDbUrl, vector, limit, filter, logger, apiKey) {
  const url = `${vectorDbUrl.replace(/\/$/, '')}/collections/products/points/search`
  try {
    const body = { vector, limit, with_payload: true, with_vector: false }
    if (filter) body.filter = filter

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'api-key': apiKey || '' },
      body: JSON.stringify(body)
    })
    if (!res.ok) { logger.warn(`Qdrant error: ${res.status}`); return [] }
    const data = await res.json()
    return Array.isArray(data?.result) ? data.result : []
  } catch (e) {
    logger.warn('Qdrant search failed: ' + e.message)
    return []
  }
}

// ─── Normalize Qdrant Hit to Product Object ───────────────────────────────────
function normalizeProduct(hit) {
  const payload = hit.payload || {}
  const resolvedUrl = payload.productUrl || payload.url || '#'
  const resolvedImage = payload.imageUrl || payload.image || ''
  const priceValue = Number(String(payload.price || '').replace(/[^0-9.]/g, ''))
  const attributes = extractAttributesFromPayload(payload)
  return {
    name: payload.name || '',
    sku: payload.sku || '',
    price: Number.isFinite(priceValue) ? priceValue : 0,
    category_names: payload.category_names || '',
    image: resolvedImage,
    imageUrl: resolvedImage,
    url: resolvedUrl,
    productUrl: resolvedUrl,
    attributes,
    score: hit.score || 0
  }
}

function extractAttributesFromPayload(payload) {
  const attrs = {}
  const reserved = new Set([
    'name', 'sku', 'price', 'category_names', 'image', 'imageUrl', 'url', 'productUrl', 'url_key',
    'description_text', 'attributes'
  ])

  if (payload.attributes && typeof payload.attributes === 'object') {
    Object.assign(attrs, payload.attributes)
  }

  for (const [key, value] of Object.entries(payload)) {
    if (reserved.has(key)) continue
    attrs[key] = value
  }

  return attrs
}

// ─── Filter Product Text to Configured Attributes ────────────────────────────
function filterProductText(text, indexedAttrs) {
  if (!indexedAttrs || indexedAttrs.length === 0) return text
  const coreFields = ['Product:', 'SKU:', 'Link:', 'Image:', 'Price:', 'Category:']
  return text.split('\n').filter(line => {
    if (coreFields.some(f => line.startsWith(f))) return true
    return indexedAttrs.some(attr => line.toLowerCase().includes(attr.toLowerCase().replace('_', ' ')))
  }).join('\n')
}

// ─── Apply PHP-style Keyword Filters ─────────────────────────────────────────
function applyProductFilters(products, filters, logger) {
  if (!filters || !products.length) return products
  if (!filters.keywords_include?.length && !filters.keywords_exclude?.length) return products

  logger.info(`🔍 Applying keyword filters: include=${JSON.stringify(filters.keywords_include)} exclude=${JSON.stringify(filters.keywords_exclude)}`)

  return products.filter(p => {
    const searchable = normalizeTextForMatch([p.name, p.category_names, JSON.stringify(p.attributes || {})].join(' '))

    if (filters.keywords_include?.length > 0) {
      const hasInclude = filters.keywords_include.some(kw => {
        const variants = buildKeywordVariants(kw)
        return variants.some(v => searchable.includes(v))
      })
      if (!hasInclude) return false
    }

    if (filters.keywords_exclude?.length > 0) {
      const hasExclude = filters.keywords_exclude.some(kw => {
        const variants = buildKeywordVariants(kw)
        return variants.some(v => searchable.includes(v))
      })
      if (hasExclude) return false
    }

    return true
  })
}

function buildKeywordVariants(keyword) {
  const normalized = normalizeTextForMatch(keyword)
  const variants = new Set()
  if (normalized) variants.add(normalized)

  for (const token of normalized.split(' ')) {
    if (token.length > 3 && token.endsWith('s')) {
      variants.add(token.slice(0, -1))
    }
    if (token.length > 4 && token.endsWith('es')) {
      variants.add(token.slice(0, -2))
    }
  }

  return [...variants]
}

// ─── Generate Search Answer (warm, personal tone) ────────────────────────────
async function generateSearchAnswer(query, products, intent, history, settings, logger) {
  if (!products.length) return generateNotFoundMessage(query)

  const isRefinement = intent.is_refinement || /only|just|specifically|available in|that has/.test(query.toLowerCase())

  const recentHistory = history.slice(-3).map(m => `${m.role}: ${m.content.slice(0, 100)}`).join('\n')

  const userTone = history.length > 0
    ? (/thanks|thank|awesome|great|love|perfect/i.test(history[history.length - 1]?.content || '') ? 'happy'
      : /help|please|need|looking/i.test(history[history.length - 1]?.content || '') ? 'seeking_help'
        : 'neutral')
    : 'neutral'

  const prompt = `You are a friendly shopping assistant. Generate a warm, personal intro message before showing product results.

RECENT CONVERSATION:
${recentHistory || 'First interaction'}

USER TONE: ${userTone}
IS REFINEMENT? ${isRefinement}
CURRENT QUERY: "${query}"

Found ${products.length} products — they will be displayed visually below your message.

RULES:
1. Maximum 12-18 words — warm, not rambling
2. Use "you"/"your" to make it personal
3. Use 1-2 emojis if natural
4. NEVER list product names or counts — they're shown visually below
5. End with a colon ":"
6. Tone: ${userTone === 'happy' ? 'Enthusiastic!' : userTone === 'seeking_help' ? 'Supportive!' : 'Friendly and warm!'}
7. If refinement: "Here's exactly what you're looking for:" or "Perfect! Here are the [color] options:"

Generate ONLY the warm intro message:`

  try {
    const msg = await openAIChatCompletion({
      apiKey: settings.openaiKey,
      model: OPENAI_MINI_MODEL,
      systemPrompt: 'You are a friendly shopping assistant.',
      userPrompt: prompt,
      temperature: 0.8,
      maxTokens: 50
    })
    let clean = msg.replace(/["*]/g, '').trim()
    if (!clean.endsWith(':')) clean += ':'
    return clean
  } catch (e) {
    return isRefinement
      ? "Here's exactly what you're looking for:"
      : "I found some great options for you:"
  }
}

// ─── Product Inquiry Answer ───────────────────────────────────────────────────
async function generateProductInquiryAnswer(query, product, settings, logger) {
  if (!product) return "I couldn't find that product. Could you clarify which one?"

  const attrs = product.attributes || {}
  const price = product.price
  let productContext = `PRODUCT: ${product.name}\nURL: ${product.url}\nPRICE: ${price > 0 ? '$' + price : 'Multiple options available'}\n\nATTRIBUTES:\n`

  for (const [k, v] of Object.entries(attrs)) {
    const display = k.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
    productContext += `- ${display}: ${Array.isArray(v) ? v.join(', ') : v}\n`
  }

  const prompt = `You are a helpful product assistant. Answer the user's question about this product using ONLY the information provided.

${productContext}

USER QUESTION: "${query}"

RULES:
1. Answer ONLY from the product data above — never make up information
2. Mention the product URL directly in plain text when relevant: ${product.url}
3. Be natural, friendly, and concise (2-3 sentences max)
4. If info doesn't exist: say "That information isn't listed" and suggest checking product page

Answer:`

  try {
    return await openAIChatCompletion({
      apiKey: settings.openaiKey,
      model: OPENAI_MINI_MODEL,
      systemPrompt: 'You are a factual product assistant.',
      userPrompt: prompt,
      temperature: 0.3,
      maxTokens: 150
    })
  } catch (e) {
    return `Here's ${product.name}. Check this product page for full details: ${product.url}`
  }
}

// ─── Product Comparison ───────────────────────────────────────────────────────
async function generateComparisonAnswer(query, products, settings, logger) {
  if (!products || products.length < 2) {
    return "I need at least 2 products to compare. Could you show me some products first?"
  }

  const context = products.slice(0, 5).map((p, i) => {
    const skip = new Set(['small_image', 'thumbnail', 'required_options', 'has_options', 'meta_title', 'meta_keyword', 'meta_description'])
    const attrs = Object.entries(p.attributes || {})
      .filter(([k, v]) => !skip.has(k) && v)
      .map(([k, v]) => `${k.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())}: ${Array.isArray(v) ? v.join(', ') : v}`)
      .join('\n')

    const priceStr = (!p.price || p.price < 0.01) ? 'Multiple options available (view product page)' : `$${p.price}`
    return `Product ${i + 1}: ${p.name}\nURL: ${p.url}\nPrice: ${priceStr}\n${attrs}`
  }).join('\n\n')

  const prompt = `Compare these products based on their actual attributes. Be factual and helpful.

${context}

USER ASKED: "${query}"

IMPORTANT PRICE HANDLING:
- If price shows "Multiple options available" → say "pricing varies by option", NOT "$0"

RULES:
1. Only use attributes listed above — never invent features
2. Highlight 2-3 key differences per product
3. Keep everything in plain text and include product URLs directly when needed
4. Be concise (4-5 sentences max)

Generate comparison:`

  try {
    return await openAIChatCompletion({
      apiKey: settings.openaiKey,
      model: OPENAI_MINI_MODEL,
      systemPrompt: 'You are a product comparison expert.',
      userPrompt: prompt,
      temperature: 0.7,
      maxTokens: 250
    })
  } catch (e) {
    return products.map((p, i) => {
      const price = (!p.price || p.price < 0.01) ? 'Multiple options' : `$${p.price}`
      return `${i + 1}. [${p.name}](${p.url}) — ${price}`
    }).join('\n') + '\n\nCheck the product pages for detailed specifications.'
  }
}

// ─── Not Found Message ────────────────────────────────────────────────────────
function generateNotFoundMessage(query) {
  const q = query.toLowerCase()
  const typeMap = { guitar: 'guitars', laptop: 'laptops', shoe: 'shoes', bag: 'bags', dress: 'dresses', phone: 'phones' }
  for (const [key, label] of Object.entries(typeMap)) {
    if (q.includes(key)) return `I couldn't find exact matches for "${query}". Would you like to browse our ${label} or try a different search term?`
  }
  return `I couldn't find what you're looking for. Try different keywords, check spelling, or ask me about popular products!`
}

// ─── Conversation Context Builder (mirrors PHP buildConversationContext) ───────
function buildConversationContext(history) {
  if (!history || history.length === 0) return 'No previous conversation.'
  return history.slice(-6).map(m => `${m.role.toUpperCase()}: ${m.content}`).join('\n')
}

// ─── General Answer (fallback when no vector DB) ──────────────────────────────
async function answerGeneral(question, settings) {
  const botName = settings?.botName || 'Assistant'
  return openAIChatCompletion({
    apiKey: settings.openaiKey,
    model: OPENAI_CHAT_MODEL,
    systemPrompt: `You are ${botName}, a helpful ecommerce assistant. Be concise and helpful.`,
    userPrompt: question
  })
}

// ─── OpenAI Embedding ─────────────────────────────────────────────────────────
async function createEmbedding(input, apiKey) {
  const res = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: OPENAI_EMBED_MODEL, input })
  })
  if (!res.ok) throw new Error(`Embedding failed: ${res.status}`)
  const data = await res.json()
  return data?.data?.[0]?.embedding || []
}

// ─── OpenAI Chat Completion ───────────────────────────────────────────────────
async function openAIChatCompletion({ apiKey, model, systemPrompt, userPrompt, temperature = 0.2, maxTokens = 1000 }) {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      temperature,
      max_tokens: maxTokens,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ]
    })
  })
  if (!res.ok) throw new Error(`OpenAI chat failed: ${res.status} - ${await res.text()}`)
  const data = await res.json()
  return data?.choices?.[0]?.message?.content?.trim() || 'Sorry, I could not generate a response.'
}

// ─── Error Helper ─────────────────────────────────────────────────────────────
function errorResponse(statusCode, message) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: { success: false, error: true, message }
  }
}

exports.main = main
