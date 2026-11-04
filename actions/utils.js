/* 
* <license header>
*/

/* This file exposes some common utilities for your actions */

const fetch = globalThis.fetch ? globalThis.fetch.bind(globalThis) : require('node-fetch')

/**
 * Returns true when the given Commerce base URL matches Adobe's Commerce as a
 * Cloud Service (SaaS) REST endpoint pattern, e.g.
 * https://na1-sandbox.api.commerce.adobe.com/<tenant-id>
 *
 * @param {string} baseUrl Commerce instance base URL
 * @returns {boolean} true if the URL is a recognized SaaS endpoint
 */
function isSaaSCommerceUrl (baseUrl) {
  const base = String(baseUrl || '').replace(/\/$/, '')
  return /^https?:\/\/[^/]*\.api\.commerce\.adobe\.com(?:\/|$)/i.test(base)
}

/**
 * Fetches a short-lived IMS OAuth access token using CLIENT_ID + CLIENT_SECRET.
 *
 * @param {object} creds IMS_CLIENT_ID, IMS_CLIENT_SECRET, IMS_AUTH_HOST
 * @returns {string} IMS access token
 */
async function fetchImsToken ({ IMS_CLIENT_ID, IMS_CLIENT_SECRET, IMS_AUTH_HOST }) {
  const imsHost = IMS_AUTH_HOST || 'https://ims-na1.adobelogin.com'
  const imsUrl = `${imsHost.replace(/\/$/, '')}/ims/token/v3`
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: IMS_CLIENT_ID,
    client_secret: IMS_CLIENT_SECRET,
    scope: 'openid,AdobeID,read_organizations,additional_info.projectedProductContext'
  })

  const res = await fetch(imsUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString()
  })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`IMS token fetch failed: ${res.status} - ${text}`)
  }

  const data = await res.json()
  if (!data.access_token) {
    throw new Error('IMS response did not contain access_token')
  }

  return data.access_token
}

/**
 * Returns a Commerce API Bearer token.
 * - PaaS: returns COMMERCE_ACCESS_TOKEN directly (admin integration token)
 * - SaaS: fetches a short-lived IMS token using CLIENT_ID + CLIENT_SECRET
 *
 * Auth mode is decided by COMMERCE_BASE_URL, not merely by which credentials
 * happen to be present. This matters because businessConfig fields are stored
 * per scope: a scope configured for PaaS (COMMERCE_ACCESS_TOKEN) must not be
 * silently overridden by IMS credentials left over from a different, SaaS
 * scope's configuration. IMS is only preferred outright when COMMERCE_BASE_URL
 * is unambiguously a Commerce as a Cloud Service endpoint; otherwise the static
 * access token wins whenever it's present.
 *
 * @param {object} params action input parameters
 * @returns {string} bearer token to use in Authorization header
 */
async function getCommerceToken (params) {
  const { COMMERCE_ACCESS_TOKEN, IMS_CLIENT_ID, IMS_CLIENT_SECRET, IMS_AUTH_HOST, COMMERCE_BASE_URL } = params
  const hasImsCreds = Boolean(IMS_CLIENT_ID && IMS_CLIENT_SECRET)
  const hasPaasToken = Boolean(COMMERCE_ACCESS_TOKEN)

  if (isSaaSCommerceUrl(COMMERCE_BASE_URL) && hasImsCreds) {
    return fetchImsToken({ IMS_CLIENT_ID, IMS_CLIENT_SECRET, IMS_AUTH_HOST })
  }

  if (hasPaasToken) {
    return COMMERCE_ACCESS_TOKEN
  }

  if (hasImsCreds) {
    return fetchImsToken({ IMS_CLIENT_ID, IMS_CLIENT_SECRET, IMS_AUTH_HOST })
  }

  throw new Error('Missing Adobe Commerce credentials. Provide either COMMERCE_ACCESS_TOKEN (PaaS) or IMS_CLIENT_ID + IMS_CLIENT_SECRET (SaaS).')
}

/**
 * Builds a Commerce REST API URL for either PaaS or Commerce as a Cloud Service.
 * ACCS endpoints use /V1 directly, while PaaS endpoints use /rest/V1.
 *
 * @param {string} baseUrl Commerce instance base URL
 * @param {string} endpoint API path after the version segment
 * @returns {string} complete API URL
 */
function getCommerceApiUrl (baseUrl, endpoint) {
  const base = String(baseUrl || '').replace(/\/$/, '')
  const path = String(endpoint || '').replace(/^\/+/, '')
  return `${base}/${isSaaSCommerceUrl(base) ? 'V1' : 'rest/V1'}/${path}`
}

/**
 * Returns headers needed to scope Adobe Commerce as a Cloud Service requests.
 * PaaS obtains its scope from the REST URL, so no Store header is added there.
 *
 * @param {object} params action input parameters
 * @returns {object} optional Commerce scope headers
 */
function getCommerceScopeHeaders (params) {
  return isSaaSCommerceUrl(params?.COMMERCE_BASE_URL) ? { Store: params?.COMMERCE_STORE_CODE || 'default' } : {}
}

/**
 *
 * Returns a log ready string of the action input parameters.
 * The `Authorization` header content will be replaced by '<hidden>'.
 *
 * @param {object} params action input parameters.
 *
 * @returns {string}
 *
 */
function stringParameters (params) {
  // hide authorization token without overriding params
  let headers = params.__ow_headers || {}
  if (headers.authorization) {
    headers = { ...headers, authorization: '<hidden>' }
  }
  return JSON.stringify({ ...params, __ow_headers: headers })
}

/**
 *
 * Returns the list of missing keys giving an object and its required keys.
 * A parameter is missing if its value is undefined or ''.
 * A value of 0 or null is not considered as missing.
 *
 * @param {object} obj object to check.
 * @param {array} required list of required keys.
 *        Each element can be multi level deep using a '.' separator e.g. 'myRequiredObj.myRequiredKey'
 *
 * @returns {array}
 * @private
 */
function getMissingKeys (obj, required) {
  return required.filter(r => {
    const splits = r.split('.')
    const last = splits[splits.length - 1]
    const traverse = splits.slice(0, -1).reduce((tObj, split) => { tObj = (tObj[split] || {}); return tObj }, obj)
    return traverse[last] === undefined || traverse[last] === '' // missing default params are empty string
  })
}

/**
 *
 * Returns the list of missing keys giving an object and its required keys.
 * A parameter is missing if its value is undefined or ''.
 * A value of 0 or null is not considered as missing.
 *
 * @param {object} params action input parameters.
 * @param {array} requiredHeaders list of required input headers.
 * @param {array} requiredParams list of required input parameters.
 *        Each element can be multi level deep using a '.' separator e.g. 'myRequiredObj.myRequiredKey'.
 *
 * @returns {string} if the return value is not null, then it holds an error message describing the missing inputs.
 *
 */
function checkMissingRequestInputs (params, requiredParams = [], requiredHeaders = []) {
  let errorMessage = null

  // input headers are always lowercase
  requiredHeaders = requiredHeaders.map(h => h.toLowerCase())
  // check for missing headers
  const missingHeaders = getMissingKeys(params.__ow_headers || {}, requiredHeaders)
  if (missingHeaders.length > 0) {
    errorMessage = `missing header(s) '${missingHeaders}'`
  }

  // check for missing parameters
  const missingParams = getMissingKeys(params, requiredParams)
  if (missingParams.length > 0) {
    if (errorMessage) {
      errorMessage += ' and '
    } else {
      errorMessage = ''
    }
    errorMessage += `missing parameter(s) '${missingParams}'`
  }

  return errorMessage
}

/**
 *
 * Extracts the bearer token string from the Authorization header in the request parameters.
 *
 * @param {object} params action input parameters.
 *
 * @returns {string|undefined} the token string or undefined if not set in request headers.
 *
 */
function getBearerToken (params) {
  if (params.__ow_headers &&
      params.__ow_headers.authorization &&
      params.__ow_headers.authorization.startsWith('Bearer ')) {
    return params.__ow_headers.authorization.substring('Bearer '.length)
  }
  return undefined
}
/**
 *
 * Returns an error response object and attempts to log.info the status code and error message
 *
 * @param {number} statusCode the error status code.
 *        e.g. 400
 * @param {string} message the error message.
 *        e.g. 'missing xyz parameter'
 * @param {*} [logger] an optional logger instance object with an `info` method
 *        e.g. `new require('@adobe/aio-sdk').Core.Logger('name')`
 *
 * @returns {object} the error object, ready to be returned from the action main's function.
 *
 */
function errorResponse (statusCode, message, logger) {
  if (logger && typeof logger.info === 'function') {
    logger.info(`${statusCode}: ${message}`)
  }
  return {
    error: {
      statusCode,
      body: {
        error: message
      }
    }
  }
}

module.exports = {
  errorResponse,
  getBearerToken,
  stringParameters,
  checkMissingRequestInputs,
  getCommerceToken,
  getCommerceApiUrl,
  getCommerceScopeHeaders
}
