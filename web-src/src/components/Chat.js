/* 
* <license header>
*/

import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useSettings } from '../hooks/useSettings'
import { callAction } from '../utils'
import './Chat.css'

const defaultSettings = {
  botName: 'Assistant',
  greetingText: 'Hi! How can I help you today?',
  chatbotWhatsapp: '',
  chatbotEmail: '',
  botImage: '',
  enableOrderTracking: true,
  enableWhatsapp: true,
  enableEmail: true,
  enableOrderInfo: true
}

const makeMessage = (text, from, options = {}) => ({
  id: Date.now() + Math.random(),
  text,
  from,
  time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
  products: Array.isArray(options.products) ? options.products : []
})

const decodeHtmlEntities = (value) => {
  const text = String(value || '')
  if (!text) return ''
  if (typeof document !== 'undefined') {
    const el = document.createElement('textarea')
    el.innerHTML = text
    return el.value
  }
  return text
    .replace(/&trade;/gi, '™')
    .replace(/&reg;/gi, '®')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
}

const normalizeAssistantText = (text) => {
  return decodeHtmlEntities(String(text || ''))
    .replace(/<[^>]+>/g, '')
    .trim()
}

const renderInlineWithLinks = (value, keyPrefix) => {
  const text = String(value || '')
  const regex = /(https?:\/\/[^\s]+)/g
  const parts = text.split(regex)

  return parts.map((part, index) => {
    if (!/^https?:\/\//.test(part)) return <React.Fragment key={`${keyPrefix}-txt-${index}`}>{part}</React.Fragment>
    let url = part
    let trailing = ''
    const match = part.match(/^(https?:\/\/[^\s]+?)([).,!?:;]+)$/)
    if (match) {
      url = match[1]
      trailing = match[2]
    }
    return (
      <React.Fragment key={`${keyPrefix}-lnk-${index}`}>
        <a
          href={url}
          target='_blank'
          rel='noopener noreferrer'
          onClick={(event) => event.stopPropagation()}
        >
          {url}
        </a>
        {trailing}
      </React.Fragment>
    )
  })
}

const buildWhatsappLink = (rawNumber) => {
  const digits = String(rawNumber || '').replace(/[^\d]/g, '')
  if (!digits) return ''
  return `https://api.whatsapp.com/send/?phone=${digits}&text&type=phone_number&app_absent=0`
}

const buildEmailLink = (rawEmail) => {
  const email = String(rawEmail || '').trim()
  if (!email) return ''
  return `mailto:${encodeURIComponent(email)}`
}

const renderTextWithLinks = (text) => {
  const value = String(text || '')
  const markdownRegex = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g
  const nodes = []
  let lastIndex = 0
  let match
  let segmentIndex = 0

  while ((match = markdownRegex.exec(value)) !== null) {
    const [full, label, url] = match
    const start = match.index
    const end = start + full.length

    if (start > lastIndex) {
      const before = value.slice(lastIndex, start)
      nodes.push(...renderInlineWithLinks(before, `seg-${segmentIndex}`))
      segmentIndex += 1
    }

    nodes.push(
      <a
        key={`md-${segmentIndex}`}
        href={url}
        target='_blank'
        rel='noopener noreferrer'
        onClick={(event) => event.stopPropagation()}
      >
        {label}
      </a>
    )
    segmentIndex += 1
    lastIndex = end
  }

  if (lastIndex < value.length) {
    nodes.push(...renderInlineWithLinks(value.slice(lastIndex), `seg-${segmentIndex}`))
  }

  return nodes
}

const buildHistoryPayload = (messages) => {
  return messages
    .filter(m => typeof m?.text === 'string' && m.text.trim())
    .map(m => ({
      role: m.from === 'user' ? 'user' : 'assistant',
      content: m.text
    }))
}

const getLastProductsPayload = (messages) => {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg?.from === 'agent' && Array.isArray(msg.products) && msg.products.length > 0) {
      return msg.products
    }
  }
  return []
}

const getProductLink = (product) => {
  if (typeof product?.productUrl === 'string' && product.productUrl.startsWith('http')) {
    return product.productUrl
  }
  if (typeof product?.url === 'string' && product.url.startsWith('http')) {
    return product.url
  }
  return ''
}

const getProductImageSrc = (product) => {
  const candidates = [
    product?.imageUrl,
    product?.image,
    product?.small_image,
    product?.thumbnail
  ].filter(value => typeof value === 'string' && value.trim())

  const baseFromProductLink = (() => {
    const link = getProductLink(product)
    if (!link) return ''
    try {
      return new URL(link).origin
    } catch {
      return ''
    }
  })()

  for (const rawValue of candidates) {
    const value = rawValue.trim()
    if (value.startsWith('http')) return value
    if (!baseFromProductLink) continue

    // Magento image attributes are often `/x/y/file.jpg` paths under `/media/catalog/product`.
    if (value.startsWith('/media/')) {
      return `${baseFromProductLink}${value}`
    }
    if (value.startsWith('/')) {
      return `${baseFromProductLink}/media/catalog/product${value}`
    }
  }
  return ''
}

export const Chat = ({ runtime, ims }) => {
  const { loadSettings } = useSettings(runtime, ims)
  const inputRef = useRef(null)
  const orderNumberRef = useRef(null)
  const bodyRef = useRef(null)
  const sliderDragRef = useRef({ active: false, startX: 0, startScrollLeft: 0 })
  const suppressCardClickRef = useRef(false)

  const [isChatOpen, setIsChatOpen] = useState(false)
  const [inputValue, setInputValue] = useState('')
  const [messages, setMessages] = useState([])
  const [chatSettings, setChatSettings] = useState(defaultSettings)
  const [isSending, setIsSending] = useState(false)
  const [orderTrackingForm, setOrderTrackingForm] = useState({
    enabled: false,
    orderNumber: '',
    email: ''
  })

  useEffect(() => {
    ; (async () => {
      try {
        const data = await loadSettings()
        let parsed = data
        if (typeof data === 'string') {
          try {
            parsed = JSON.parse(data)
          } catch {
            parsed = {}
          }
        }

        if (parsed && typeof parsed === 'object') {
          setChatSettings({
            botName: parsed.botName || defaultSettings.botName,
            greetingText: parsed.greetingText || defaultSettings.greetingText,
            chatbotWhatsapp: parsed.chatbotWhatsapp || defaultSettings.chatbotWhatsapp,
            chatbotEmail: parsed.chatbotEmail || defaultSettings.chatbotEmail,
            botImage: parsed.botImage || defaultSettings.botImage,
            enableOrderTracking: parsed.enableOrderTracking ?? defaultSettings.enableOrderTracking,
            enableWhatsapp: parsed.enableWhatsapp ?? defaultSettings.enableWhatsapp,
            enableEmail: parsed.enableEmail ?? defaultSettings.enableEmail,
            enableOrderInfo: parsed.enableOrderInfo ?? defaultSettings.enableOrderInfo
          })
        }
      } catch {
        setChatSettings(defaultSettings)
      }
    })()
  }, [])

  const quickActions = useMemo(() => ([
    { label: 'Order Tracking', text: 'I want to track my order.', enabled: chatSettings.enableOrderTracking },
    { label: 'Whatsapp', type: 'whatsapp', enabled: chatSettings.enableWhatsapp },
    { label: 'Email', type: 'email', enabled: chatSettings.enableEmail },
    { label: 'Order Info', text: 'I want to track my order.', enabled: chatSettings.enableOrderInfo }
  ]), [
    chatSettings.enableOrderTracking,
    chatSettings.enableWhatsapp,
    chatSettings.enableEmail,
    chatSettings.enableOrderInfo
  ])

  const askAssistant = async (question, contextMessages = []) => {
    setIsSending(true)
    try {
      const history = buildHistoryPayload(contextMessages)
      const lastProducts = getLastProductsPayload(contextMessages)

      const res = await callAction(
        { runtime, ims },
        'AiChatbot/aichatbot',
        {
          operation: 'chat-ask',
          payload: { question, history, lastProducts }
        }
      )

      const products = Array.isArray(res?.products) ? res.products : []
      const rawAnswer = res?.answer
      const answerParts = Array.isArray(rawAnswer) ? rawAnswer : [rawAnswer]
      const normalizedParts = answerParts
        .map(part => normalizeAssistantText(part))
        .filter(part => Boolean(part))
      const answerFallback = 'Sorry, I could not find an answer right now.'
      const awaitingOrderTracking = res?.awaitingOrderTracking === true

      setOrderTrackingForm(prev => awaitingOrderTracking
        ? { ...prev, enabled: true }
        : { enabled: false, orderNumber: '', email: '' })

      if (products.length > 0) {
        setMessages(prev => [
          ...prev,
          makeMessage('Here are some products I found for you:', 'agent', { products })
        ])
        return
      }

      if (Array.isArray(rawAnswer)) {
        const parts = normalizedParts.length > 0 ? normalizedParts : [answerFallback]
        setMessages(prev => [
          ...prev,
          ...parts.map(part => makeMessage(part, 'agent'))
        ])
        return
      }

      const answer = normalizedParts[0] || answerFallback
      setMessages(prev => [...prev, makeMessage(answer, 'agent')])
    } catch (e) {
      setMessages(prev => [
        ...prev,
        makeMessage('Sorry, I am having trouble connecting right now. Please try again.', 'agent')
      ])
    } finally {
      setIsSending(false)
      setTimeout(() => inputRef.current?.focus(), 0)
    }
  }

  const openChat = (initialUserMessage = '') => {
    setIsChatOpen(true)
    setMessages(prev => {
      const next = [...prev]

      if (next.length === 0) {
        next.push(makeMessage(chatSettings.greetingText, 'agent'))
      }

      if (initialUserMessage) {
        next.push(makeMessage(initialUserMessage, 'user'))
      }

      return next
    })

    const existingMessages = [...messages]
    const contextMessages = [...existingMessages]
    if (existingMessages.length === 0) {
      contextMessages.push(makeMessage(chatSettings.greetingText, 'agent'))
    }

    if (initialUserMessage) {
      askAssistant(initialUserMessage, contextMessages)
    } else {
      setTimeout(() => inputRef.current?.focus(), 0)
    }
  }

  const onSend = async () => {
    if (isSending) return

    if (orderTrackingForm.enabled) {
      const orderNumber = orderTrackingForm.orderNumber.trim()
      const email = orderTrackingForm.email.trim()
      if (!orderNumber || !email) return

      const value = `Order number: ${orderNumber}, email: ${email}`
      const userMessage = makeMessage(value, 'user')
      const nextMessages = [...messages, userMessage]
      setMessages(nextMessages)
      setOrderTrackingForm(prev => ({ ...prev, orderNumber: '', email: '' }))
      await askAssistant(value, nextMessages)
      return
    }

    const value = inputValue.trim()
    if (!value) return

    const userMessage = makeMessage(value, 'user')
    const nextMessages = [...messages, userMessage]
    setMessages(nextMessages)
    setInputValue('')
    await askAssistant(value, nextMessages)
  }

  const onEndChat = () => {
    setIsChatOpen(false)
    setInputValue('')
    setMessages([])
    setOrderTrackingForm({ enabled: false, orderNumber: '', email: '' })
  }

  const onProductListWheel = (event) => {
    const target = event.currentTarget
    if (!target?.classList?.contains('is-slider')) return

    const canScrollHorizontally = target.scrollWidth > target.clientWidth
    if (!canScrollHorizontally) return

    if (Math.abs(event.deltaY) > Math.abs(event.deltaX)) {
      event.preventDefault()
      target.scrollLeft += event.deltaY
    }
  }

  const onProductListMouseDown = (event) => {
    const target = event.currentTarget
    if (!target?.classList?.contains('is-slider')) return
    sliderDragRef.current = {
      active: true,
      startX: event.pageX - target.offsetLeft,
      startScrollLeft: target.scrollLeft
    }
    suppressCardClickRef.current = false
    target.classList.add('is-dragging')
  }

  const onProductListMouseMove = (event) => {
    const target = event.currentTarget
    if (!target?.classList?.contains('is-slider')) return
    if (!sliderDragRef.current.active) return
    event.preventDefault()
    const x = event.pageX - target.offsetLeft
    const walk = x - sliderDragRef.current.startX
    if (Math.abs(walk) > 4) suppressCardClickRef.current = true
    target.scrollLeft = sliderDragRef.current.startScrollLeft - walk
  }

  const onProductListMouseUp = (event) => {
    const target = event.currentTarget
    sliderDragRef.current.active = false
    if (target?.classList?.contains('is-slider')) target.classList.remove('is-dragging')
    setTimeout(() => { suppressCardClickRef.current = false }, 0)
  }

  useEffect(() => {
    if (!isChatOpen) return
    const container = bodyRef.current
    if (!container) return
    container.scrollTop = container.scrollHeight
  }, [messages, isChatOpen])

  useEffect(() => {
    if (!isChatOpen || isSending) return
    if (orderTrackingForm.enabled) {
      setTimeout(() => orderNumberRef.current?.focus(), 0)
      return
    }
    setTimeout(() => inputRef.current?.focus(), 0)
  }, [orderTrackingForm.enabled, isChatOpen, isSending])

  return (
    <div className='chat-page'>
      <div className='chat-panel'>
        {!isChatOpen && (
          <div className='chat-launcher'>
            <div className='chat-launcher-bot'>
              {chatSettings.botImage
                ? <img src={chatSettings.botImage} alt='Bot' />
                : 'AI'}
            </div>
            <h2 className='chat-launcher-title'>Hey, I&apos;m your {chatSettings.botName}</h2>
            <p className='chat-launcher-subtitle'>How can i help you?</p>

            <div className='chat-launcher-actions'>
              {quickActions.filter(action => action.enabled !== false).map(action => (
                <button
                  key={action.label}
                  className='chat-launcher-btn'
                  type='button'
                  onClick={() => {
                    if (action.type === 'whatsapp') {
                      const link = buildWhatsappLink(chatSettings.chatbotWhatsapp)
                      if (link) window.open(link, '_blank', 'noopener,noreferrer')
                      return
                    }
                    if (action.type === 'email') {
                      const link = buildEmailLink(chatSettings.chatbotEmail)
                      if (!link) return
                      try {
                        window.top.location.href = link
                      } catch {
                        window.location.href = link
                      }
                      return
                    }
                    openChat(action.text)
                  }}
                >
                  {action.label}
                </button>
              ))}
              <button
                className='chat-launcher-btn chat-launcher-btn-main'
                type='button'
                onClick={() => openChat()}
              >
                Chat Now
              </button>
            </div>
          </div>
        )}

        {isChatOpen && (
          <div className='chat-shell'>
            <div className='chat-shell-header'>
              <span className='chat-shell-user'>
                <span className='chat-shell-status' />
                {chatSettings.botName}
              </span>
              <button
                className='chat-shell-end-btn'
                type='button'
                onClick={onEndChat}
              >
                End Chat
              </button>
            </div>

            <div className='chat-shell-body' ref={bodyRef}>
              {messages.map(message => (
                <div key={message.id} className={`chat-message-row ${message.from === 'user' ? 'is-user' : 'is-agent'}`}>
                  <div className='chat-message-bubble'>
                    {message.from === 'agent' ? renderTextWithLinks(message.text) : message.text}
                  </div>
                  {message.from === 'agent' && message.products.length > 0 && (
                    <div
                      className={`chat-product-list ${message.products.length > 2 ? 'is-slider' : 'is-grid'}`}
                      onWheel={onProductListWheel}
                      onMouseDown={onProductListMouseDown}
                      onMouseMove={onProductListMouseMove}
                      onMouseUp={onProductListMouseUp}
                      onMouseLeave={onProductListMouseUp}
                    >
                      {message.products.map((product, index) => (
                        (() => {
                          const productLink = getProductLink(product)
                          const priceValue = Number(product?.price || 0)
                          const hasPrice = Number.isFinite(priceValue) && priceValue > 0.009
                          const imageSrc = getProductImageSrc(product)

                          return (
                            <article
                              key={`${message.id}-${product.sku || index}`}
                              className='chat-product-card'
                              onClick={() => {
                                if (suppressCardClickRef.current) return
                                if (productLink) window.open(productLink, '_blank', 'noopener,noreferrer')
                              }}
                              style={{ cursor: productLink ? 'pointer' : 'default' }}
                            >
                              <div className={`chat-product-image-wrap ${imageSrc ? '' : 'no-image'}`}>
                                {imageSrc && (
                                  <img
                                    className='chat-product-image'
                                    src={imageSrc}
                                    alt={product.name || 'Product'}
                                    onError={(event) => {
                                      const target = event.currentTarget
                                      target.style.display = 'none'
                                      target.parentElement?.classList.add('image-error')
                                    }}
                                    onLoad={(event) => {
                                      event.currentTarget.parentElement?.classList.add('image-loaded')
                                    }}
                                  />
                                )}
                                <span className='chat-product-image-placeholder'>🛍</span>
                              </div>
                              <div className='chat-product-name'>{decodeHtmlEntities(product.name || 'Product')}</div>
                              {product.sku && <div className='chat-product-sku'>SKU: {product.sku}</div>}
                              {hasPrice ? (
                                <div className='chat-product-price'>${priceValue.toFixed(2)}</div>
                              ) : (
                                <div className='chat-product-price'>
                                  {productLink ? (
                                    <a
                                      className='chat-product-options-link'
                                      href={productLink}
                                      target='_blank'
                                      rel='noopener noreferrer'
                                      onClick={(event) => event.stopPropagation()}
                                    >
                                      View Options
                                    </a>
                                  ) : 'View Options'}
                                </div>
                              )}
                            </article>
                          )
                        })()
                      ))}
                    </div>
                  )}
                  <div className='chat-message-time'>{message.time}</div>
                </div>
              ))}
            </div>

            <div className={`chat-shell-input-wrap ${orderTrackingForm.enabled ? 'is-tracking' : ''}`}>
              {orderTrackingForm.enabled ? (
                <div className='chat-shell-input-stack'>
                  <input
                    className='chat-shell-input chat-shell-input-track'
                    type='text'
                    ref={orderNumberRef}
                    value={orderTrackingForm.orderNumber}
                    placeholder='Order number'
                    disabled={isSending}
                    onChange={(event) => {
                      const nextOrderNumber = event.target.value
                      setOrderTrackingForm(prev => ({ ...prev, orderNumber: nextOrderNumber }))
                    }}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') onSend()
                    }}
                  />
                  <input
                    className='chat-shell-input chat-shell-input-track'
                    type='email'
                    value={orderTrackingForm.email}
                    placeholder='Email address'
                    disabled={isSending}
                    onChange={(event) => {
                      const nextEmail = event.target.value
                      setOrderTrackingForm(prev => ({ ...prev, email: nextEmail }))
                    }}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') onSend()
                    }}
                  />
                </div>
              ) : (
                <input
                  className='chat-shell-input'
                  type='text'
                  ref={inputRef}
                  value={inputValue}
                  placeholder='Ask about products...'
                  disabled={isSending}
                  onChange={(event) => setInputValue(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      onSend()
                    }
                  }}
                />
              )}
              <button className='chat-shell-send' type='button' onClick={onSend} disabled={isSending}>
                {isSending ? '...' : 'Send'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
