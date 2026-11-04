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
const action = require('./../actions/aichatbot/index.js')

beforeEach(() => {
  Core.Logger.mockClear()
  mockLoggerInstance.info.mockReset()
  mockLoggerInstance.debug.mockReset()
  mockLoggerInstance.error.mockReset()
})

const fakeParams = { __ow_headers: { authorization: 'Bearer fake' } }
describe('aichatbot', () => {
  test('main should be defined', () => {
    expect(action.main).toBeInstanceOf(Function)
  })
  test('should set logger to use LOG_LEVEL param', async () => {
    await action.main({ ...fakeParams, LOG_LEVEL: 'fakeLevel' })
    expect(Core.Logger).toHaveBeenCalledWith(expect.any(String), { level: 'fakeLevel' })
  })
  test('missing operation should return 400', async () => {
    const response = await action.main(fakeParams)
    expect(response).toEqual({
      statusCode: 400,
      headers: { 'Content-Type': 'application/json' },
      body: { success: false, error: true, message: 'Missing operation' }
    })
  })

  test('settings-get should return settings body', async () => {
    stateLib.init.mockResolvedValue({
      get: jest.fn().mockResolvedValue({ value: JSON.stringify({ botName: 'TestBot' }) })
    })

    const response = await action.main({ ...fakeParams, operation: 'settings-get' })
    expect(response).toEqual({
      statusCode: 200,
      body: { botName: 'TestBot' }
    })
  })
})
