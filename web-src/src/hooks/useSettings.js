import { callAction } from '../utils'

export const useSettings = (runtime, ims) => {
  const loadSettings = async () => {
    try {
      return await callAction(
        { runtime, ims },
        'AiChatbot/aichatbot',
        { operation: 'settings-get' }
      )
    } catch {
      return {}
    }
  }

  const saveSettings = async (data) => {
    try {
      const res = await callAction(
        { runtime, ims },
        'AiChatbot/aichatbot',
        {
          operation: 'settings-save',
          payload: data
        }
      )

      return res

    } catch (e) {
      // Extract the actual error message from the wrapped error
      let errorMessage = 'Unable to save settings. Please try again.'
      
      if (e?.message) {
        // Check if the message contains JSON error object
        const jsonMatch = e.message.match(/\{[\s\S]*\}/)
        if (jsonMatch) {
          try {
            const errorObj = JSON.parse(jsonMatch[0])
            errorMessage = errorObj.message || errorMessage
          } catch (parseError) {
            // If JSON parsing fails, use the original message
            errorMessage = e.message
          }
        } else {
          errorMessage = e.message
        }
      }

      return {
        success: false,
        message: errorMessage
      }
    }
  }

  return { loadSettings, saveSettings }
}
