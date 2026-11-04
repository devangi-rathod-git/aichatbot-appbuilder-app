import React, { useEffect, useRef, useState } from 'react'
import {
  View,
  Heading,
  ActionButton,
  StatusLight,
  ProgressBar,
  Text,
  Flex
} from '@adobe/react-spectrum'
import actionWebInvoke from '../utils'
import actions from '../config.json'

const SyncProducts = ({ ims }) => {
  const ACTION_VALIDATE = 'sync-validate'
  const ACTION_START = 'sync-start'
  const ACTION_STATUS = 'sync-status'
  const ACTION_CHUNK = 'sync-chunk'
  const pollInFlightRef = useRef(false)

  const [sync, setSync] = useState({
    state: 'IDLE',
    total: 0,
    processed: 0,
    processedOffset: 0,   // ← added
    failed: 0,
    error: null,
    lastError: null,      // ← added
    inProgress: false
  })

  useEffect(() => {
    if (sync.inProgress) {
      const timer = setInterval(advanceSync, 4000)
      return () => clearInterval(timer)
    }
  }, [sync.inProgress])

  async function startSync() {
    setSync(prev => ({ ...prev, inProgress: true, error: null, lastError: null }))

    try {
      await invoke(ACTION_VALIDATE)
      await invoke(ACTION_START)
      await fetchStatus()
    } catch (e) {
      setSync(prev => ({
        ...prev,
        inProgress: false,
        state: 'FAILED',
        error: e.message
      }))
    }
  }

  async function advanceSync() {
    if (pollInFlightRef.current) return
    pollInFlightRef.current = true

    try {
      await invoke(ACTION_CHUNK)
      await fetchStatus()
    } catch (e) {
      if (isGatewayTimeout(e)) {
        setSync(prev => ({
          ...prev,
          error: 'Connection timeout — resuming sync...'
        }))

        return
      }

      setSync(prev => ({
        ...prev,
        state: 'FAILED',
        inProgress: false,
        error: e.message
      }))
    } finally {
      pollInFlightRef.current = false
    }
  }

  async function fetchStatus() {
    try {
      const res = await invoke(ACTION_STATUS)

      setSync({
        state: res.state,
        total: res.total,
        processed: res.processed,
        processedOffset: res.processedOffset ?? 0,   // ← store it
        failed: res.failed,
        error: null,
        lastError: res.lastError || null,             // ← store failure detail
        inProgress: res.state !== 'COMPLETED' && res.state !== 'FAILED'
      })
    } catch (e) {
      if (isGatewayTimeout(e)) {
        setSync(prev => ({
          ...prev,
          error: 'Status check timeout — retrying...'
        }))
        return
      }

      setSync(prev => ({
        ...prev,
        state: 'FAILED',
        inProgress: false,
        error: e.message
      }))
    }
  }

  async function invoke(actionName) {
    const headers = {
      authorization: `Bearer ${ims.token}`,
      'x-gw-ims-org-id': ims.org
    }
    return actionWebInvoke(actions[actionName], headers, {})
  }

  function isGatewayTimeout(error) {
    const message = String(error?.message || '')
    return message.includes('504') || message.toLowerCase().includes('timeout')
  }

  // Accurate percentage using processedOffset
  const progressPercent = sync.total > 0
    ? Math.min(100, Math.round((sync.processedOffset / sync.total) * 100))
    : 0

  return (
    <View width="size-6000">
      <Heading level={1}>Sync Products</Heading>

      <Flex direction="column" gap="size-200">
        <ActionButton
          variant="primary"
          onPress={startSync}
          isDisabled={sync.inProgress}
        >
          {sync.state === 'FAILED' ? 'Resume Sync' : 'Sync Products'}
        </ActionButton>

        <StatusLight variant={
          sync.state === 'FAILED' ? 'negative'
            : sync.state === 'COMPLETED' ? 'positive'
              : 'info'
        }>
          {sync.state}
        </StatusLight>

        {(sync.inProgress || sync.state === 'COMPLETED') && sync.total > 0 && (
          <ProgressBar
            label={`Sync progress — ${sync.processedOffset} / ${sync.total} products (${progressPercent}%)`}
            value={sync.processedOffset}   // ← fix: was sync.processed
            maxValue={sync.total}
          />
        )}

        {/* Show which product/page failed */}
        {sync.lastError && (
          <Text UNSAFE_style={{ color: 'orange' }}>
            ⚠️ Last error on page {sync.lastError.page} (offset {sync.lastError.offset}): {sync.lastError.message}
          </Text>
        )}

        {sync.error && (
          <Text UNSAFE_style={{ color: sync.error.includes('timeout') ? 'orange' : 'red' }}>
            {sync.error.includes('timeout')
              ? `⚠️ ${sync.error}`
              : `❌ ${sync.error}`
            }
          </Text>
        )}

        {sync.failed > 0 && (
          <Text UNSAFE_style={{ color: 'orange' }}>
            ⚠️ {sync.failed} product{sync.failed > 1 ? 's' : ''} failed to sync
          </Text>
        )}

        {sync.state === 'COMPLETED' && (
          <Text>✅ Sync completed successfully.</Text>
        )}
      </Flex>
    </View>
  )
}

export default SyncProducts
