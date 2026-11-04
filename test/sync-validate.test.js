/* 
* <license header>
*/

jest.mock('@adobe/aio-sdk', () => ({
  Core: {
    Logger: jest.fn()
  }
}))

const { Core } = require('@adobe/aio-sdk')
const mockLoggerInstance = { info: jest.fn(), debug: jest.fn(), error: jest.fn() }
Core.Logger.mockReturnValue(mockLoggerInstance)

jest.mock('@adobe/aio-lib-state', () => ({
  init: jest.fn()
}))

const stateLib = require('@adobe/aio-lib-state')
const action = require('./../actions/sync-validate/index.js')

beforeEach(() => {
  Core.Logger.mockClear()
  mockLoggerInstance.info.mockReset()
  mockLoggerInstance.debug.mockReset()
  mockLoggerInstance.error.mockReset()
})

const fakeParams = { __ow_headers: { authorization: 'Bearer fake' } }
describe('sync-validate', () => {
  test('main should be defined', () => {
    expect(action.main).toBeInstanceOf(Function)
  })
  test('should set logger to use LOG_LEVEL param', async () => {
    await action.main({ ...fakeParams, LOG_LEVEL: 'fakeLevel' })
    expect(Core.Logger).toHaveBeenCalledWith(expect.any(String), { level: 'fakeLevel' })
  })
  test('missing commerce credentials should return 400', async () => {
    const response = await action.main(fakeParams)
    expect(response).toEqual({
      statusCode: 400,
      headers: { 'Content-Type': 'application/json' },
      body: { success: false, error: true, message: 'Missing Adobe Commerce credentials. Provide either COMMERCE_ACCESS_TOKEN (PaaS) or IMS_CLIENT_ID + IMS_CLIENT_SECRET (SaaS).' }
    })
  })

  test('valid settings should return success', async () => {
    stateLib.init.mockResolvedValue({
      get: jest.fn().mockResolvedValue({ value: JSON.stringify({ openaiKey: 'key', vectorDbUrl: 'http://qdrant' }) })
    })

    const response = await action.main({
      ...fakeParams,
      COMMERCE_BASE_URL: 'http://magento',
      COMMERCE_ACCESS_TOKEN: 'token'
    })

    expect(response.statusCode).toBe(200)
    expect(response.body).toEqual(expect.objectContaining({
      success: true,
      message: 'Validation successful'
    }))
  })
})
