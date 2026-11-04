/* 
* <license header>
*/

/* global fetch */

async function actionWebInvoke (
  actionUrl,
  headers = {},
  params = {},
  options = { method: 'POST' }
) {
  const actionHeaders = {
    'Content-Type': 'application/json',
    ...headers
  }

  if (window.location.hostname === 'localhost') {
    actionHeaders['x-ow-extra-logging'] = 'on'
  }

  const fetchConfig = {
    method: options.method.toUpperCase(),
    headers: actionHeaders
  }

  if (fetchConfig.method === 'GET') {
    actionUrl = new URL(actionUrl)
    Object.keys(params).forEach(key =>
      actionUrl.searchParams.append(key, params[key])
    )
  } else {
    fetchConfig.body = JSON.stringify(params)
  }

  const response = await fetch(actionUrl, fetchConfig)
  const text = await response.text()

  if (!response.ok) {
    throw new Error(
      `Action failed (${response.status}): ${text}`
    )
  }

  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

export async function callAction (props, action, body = {}) {
  const actions = require('./config.json')
  const actionUrl = actions[action]

  if (!actionUrl) {
    throw new Error(`Action URL not found for key: ${action}`)
  }

  return actionWebInvoke(
    actionUrl,
    {
      'x-gw-ims-org-id': props.ims.org,
      authorization: `Bearer ${props.ims.token}`
    },
    body,
    { method: 'POST' }
  )
}

export default actionWebInvoke
