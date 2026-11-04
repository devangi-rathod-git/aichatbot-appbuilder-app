/*
 * <license header>
 */

import React, { useEffect, useRef, useState } from 'react'
import {
  View,
  Heading,
  TextField,
  TextArea,
  Button,
  Flex,
  Divider,
  NumberField,
  InlineAlert,
  Switch
} from '@adobe/react-spectrum'
import { useSettings } from '../hooks/useSettings'

export const Settings = ({ runtime, ims }) => {
  const { loadSettings, saveSettings } = useSettings(runtime, ims)

  const isMounted = useRef(true)

  const [form, setForm] = useState({
    openaiKey: '',
    vectorDbUrl: '',
    vectorDbApiKey: '',
    botName: '',
    greetingText: '',
    productAttributes: 'description,short_description,url_key,manufacturer',
    productLimit: 5,
    chatbotEmail: '',
    chatbotWhatsapp: '',
    botImage: '',
    enableOrderTracking: true,
    enableWhatsapp: true,
    enableEmail: true,
    enableOrderInfo: true
  })

  const [isSaving, setIsSaving] = useState(false)
  const [errorMessage, setErrorMessage] = useState('')
  const [successMessage, setSuccessMessage] = useState('')
  const [fieldErrors, setFieldErrors] = useState({})

  useEffect(() => {
    return () => {
      isMounted.current = false
    }
  }, [])

  useEffect(() => {
    ;(async () => {
      try {
        const data = await loadSettings()
        if (isMounted.current && data && typeof data === 'object') {
          setForm(prev => ({ ...prev, ...data }))
        }
      } catch {
        if (isMounted.current) {
          setErrorMessage('Failed to load settings')
        }
      }
    })()
  }, [])

  const handleChange = (key, value) => {
    setForm(prev => ({ ...prev, [key]: value }))
    if (fieldErrors[key]) {
      setFieldErrors(prev => ({ ...prev, [key]: '' }))
    }
    setErrorMessage('')
    setSuccessMessage('')
  }

  const validateForm = () => {
    const errors = {}

    if (!form.openaiKey || form.openaiKey.trim() === '') {
      errors.openaiKey = 'OpenAI API Key is required'
    }

    if (!form.vectorDbUrl || form.vectorDbUrl.trim() === '') {
      errors.vectorDbUrl = 'VectorDB URL is required'
    }

    if (!form.vectorDbApiKey || form.vectorDbApiKey.trim() === '') {
      errors.vectorDbApiKey = 'VectorDB API Key is required'
    }

    if (!form.botName || form.botName.trim() === '') {
      errors.botName = 'Bot Name is required'
    }

    if (!form.greetingText || form.greetingText.trim() === '') {
      errors.greetingText = 'Greeting Text is required'
    }

    if (!form.productAttributes || form.productAttributes.trim() === '') {
      errors.productAttributes = 'Product Attributes are required'
    }

    if (!form.productLimit || form.productLimit < 1) {
      errors.productLimit = 'Product Limit must be at least 1'
    }

    if (!form.chatbotEmail || form.chatbotEmail.trim() === '') {
      errors.chatbotEmail = 'Chatbot email is required'
    }

    if (!form.chatbotWhatsapp || form.chatbotWhatsapp.trim() === '') {
      errors.chatbotWhatsapp = 'WhatsApp number is required'
    }

    setFieldErrors(errors)
    return Object.keys(errors).length === 0
  }

  const handleBotImageUpload = (file) => {
    if (!file) {
      handleChange('botImage', '')
      return
    }

    if (!file.type || !file.type.startsWith('image/')) {
      setErrorMessage('Please upload a valid image file')
      return
    }

    const objectUrl = URL.createObjectURL(file)
    const img = new Image()

    img.onload = () => {
      const maxSize = 128
      const scale = Math.min(maxSize / img.width, maxSize / img.height, 1)
      const width = Math.max(1, Math.round(img.width * scale))
      const height = Math.max(1, Math.round(img.height * scale))
      const canvas = document.createElement('canvas')
      canvas.width = width
      canvas.height = height

      const ctx = canvas.getContext('2d')
      if (!ctx) {
        setErrorMessage('Unable to process the selected image')
        URL.revokeObjectURL(objectUrl)
        return
      }

      ctx.drawImage(img, 0, 0, width, height)
      const dataUrl = canvas.toDataURL('image/png')
      handleChange('botImage', dataUrl)
      URL.revokeObjectURL(objectUrl)
    }

    img.onerror = () => {
      setErrorMessage('Unable to read the selected image')
      URL.revokeObjectURL(objectUrl)
    }

    img.src = objectUrl
  }

  const handleSave = async () => {
    if (isSaving) return

    setErrorMessage('')
    setSuccessMessage('')
    setFieldErrors({})

    if (!validateForm()) {
      setErrorMessage('Please fill in all required fields')
      return
    }

    setIsSaving(true)

    try {
      const res = await saveSettings(form)

      if (!res || res.success !== true) {
        setErrorMessage(
          res?.message || 'Unable to save settings. Please check your inputs.'
        )
        setIsSaving(false)
        return
      }

      setSuccessMessage('Settings saved successfully')
      setIsSaving(false)
    } catch (e) {
      setErrorMessage(
        e?.message || 'Something went wrong while saving settings'
      )
      setIsSaving(false)
    }
  }

  const handleReset = () => {
    setForm({
      openaiKey: '',
      vectorDbUrl: '',
      vectorDbApiKey: '',
      botName: '',
      greetingText: '',
      productAttributes: 'description,short_description,url_key,manufacturer',
      productLimit: 5,
      chatbotEmail: '',
      chatbotWhatsapp: '',
      botImage: '',
      enableOrderTracking: true,
      enableWhatsapp: true,
      enableEmail: true,
      enableOrderInfo: true
    })
    setErrorMessage('')
    setSuccessMessage('')
    setFieldErrors({})
  }

  return (
    <View width="size-6000">
      <Heading level={1}>Chatbot Settings</Heading>
      <Divider marginY="size-300" />

      <Flex direction="column" gap="size-300">

        {errorMessage && (
          <InlineAlert variant="negative">
            {errorMessage}
          </InlineAlert>
        )}

        {successMessage && (
          <InlineAlert variant="positive">
            {successMessage}
          </InlineAlert>
        )}

        <TextField
          label="OpenAI API Key"
          type="password"
          value={form.openaiKey}
          onChange={v => handleChange('openaiKey', v)}
          isRequired
          validationState={fieldErrors.openaiKey ? 'invalid' : null}
          errorMessage={fieldErrors.openaiKey}
        />

        <TextField
          label="VectorDB URL"
          type="password"
          value={form.vectorDbUrl}
          onChange={v => handleChange('vectorDbUrl', v)}
          isRequired
          validationState={fieldErrors.vectorDbUrl ? 'invalid' : null}
          errorMessage={fieldErrors.vectorDbUrl}
        />

        <TextField
          label="VectorDB API Key"
          type="password"
          description="Your Qdrant Cloud API key (required for Qdrant Cloud)"
          value={form.vectorDbApiKey}
          onChange={v => handleChange('vectorDbApiKey', v)}
          isRequired
          validationState={fieldErrors.vectorDbApiKey ? 'invalid' : null}
          errorMessage={fieldErrors.vectorDbApiKey}
        />

        <TextField
          label="Bot Name"
          value={form.botName}
          onChange={v => handleChange('botName', v)}
          isRequired
          validationState={fieldErrors.botName ? 'invalid' : null}
          errorMessage={fieldErrors.botName}
        />

        <TextArea
          label="Chatbot Greeting Text"
          value={form.greetingText}
          onChange={v => handleChange('greetingText', v)}
          isRequired
          validationState={fieldErrors.greetingText ? 'invalid' : null}
          errorMessage={fieldErrors.greetingText}
        />

        <TextArea
          label="Product Attributes for AI Chatbot"
          description="Enter valid Magento product attribute codes separated by commas. Invalid attributes will prevent saving."
          value={form.productAttributes}
          onChange={v => handleChange('productAttributes', v)}
          isRequired
          validationState={fieldErrors.productAttributes ? 'invalid' : null}
          errorMessage={fieldErrors.productAttributes}
        />

        <NumberField
          label="No. of products to display"
          value={form.productLimit}
          minValue={1}
          onChange={v => handleChange('productLimit', v)}
          isRequired
          validationState={fieldErrors.productLimit ? 'invalid' : null}
          errorMessage={fieldErrors.productLimit}
        />

        <TextField
          label="Chatbot Email Address"
          type="email"
          value={form.chatbotEmail}
          onChange={v => handleChange('chatbotEmail', v)}
          isRequired
          validationState={fieldErrors.chatbotEmail ? 'invalid' : null}
          errorMessage={fieldErrors.chatbotEmail}
        />

        <TextField
          label="Chatbot WhatsApp Contact Number"
          value={form.chatbotWhatsapp}
          onChange={v => handleChange('chatbotWhatsapp', v)}
          isRequired
          validationState={fieldErrors.chatbotWhatsapp ? 'invalid' : null}
          errorMessage={fieldErrors.chatbotWhatsapp}
        />

        <div>
          <label className="spectrum-FieldLabel spectrum-FieldLabel--sizeM">
            Bot Image
          </label>
          <input
            type="file"
            accept="image/*"
            onChange={event => handleBotImageUpload(event.target.files && event.target.files[0])}
          />
        </div>

        <Divider marginY="size-300" />

        <Heading level={3}>Chatbot Features</Heading>

        <Switch
          isSelected={form.enableOrderTracking}
          onChange={v => handleChange('enableOrderTracking', v)}
        >
          Enable Order Tracking
        </Switch>

        <Switch
          isSelected={form.enableWhatsapp}
          onChange={v => handleChange('enableWhatsapp', v)}
        >
          Enable WhatsApp
        </Switch>

        <Switch
          isSelected={form.enableEmail}
          onChange={v => handleChange('enableEmail', v)}
        >
          Enable Email
        </Switch>

        <Switch
          isSelected={form.enableOrderInfo}
          onChange={v => handleChange('enableOrderInfo', v)}
        >
          Enable Order Info
        </Switch>

        <Flex gap="size-200" marginTop="size-300">
          <Button variant="cta" onPress={handleSave} isDisabled={isSaving}>
            {isSaving ? 'Saving...' : 'Save'}
          </Button>
          <Button variant="secondary" onPress={handleReset} isDisabled={isSaving}>
            Reset
          </Button>
        </Flex>

      </Flex>
    </View>
  )
}