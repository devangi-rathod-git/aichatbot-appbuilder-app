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
const action = require('./../actions/sync-status/index.js')

beforeEach(() => {
  Core.Logger.mockClear()
  mockLoggerInstance.info.mockReset()
  mockLoggerInstance.debug.mockReset()
  mockLoggerInstance.error.mockReset()
})

const fakeParams = { __ow_headers: { authorization: 'Bearer fake' } }
describe('sync-status', () => {
  test('main should be defined', () => {
    expect(action.main).toBeInstanceOf(Function)
  })
  test('should set logger to use LOG_LEVEL param', async () => {
    await action.main({ ...fakeParams, LOG_LEVEL: 'fakeLevel' })
    expect(Core.Logger).toHaveBeenCalledWith(expect.any(String), { level: 'fakeLevel' })
  })
  test('should return IDLE state when no sync state exists', async () => {
    stateLib.init.mockResolvedValue({ get: jest.fn().mockResolvedValue(null) })

    const response = await action.main(fakeParams)
    expect(response.statusCode).toBe(200)
    expect(response.body).toEqual(expect.objectContaining({ state: 'IDLE' }))
  })

  test('should return persisted sync status when available', async () => {
    stateLib.init.mockResolvedValue({
      get: jest.fn().mockResolvedValue({
        value: JSON.stringify({
          state: 'IN_PROGRESS',
          total: 10,
          processed: 2,
          failed: 0,
          processedOffset: 2,
          pageSize: 5
        })
      })
    })

    const response = await action.main(fakeParams)
    expect(response.statusCode).toBe(200)
    expect(response.body).toEqual(expect.objectContaining({ state: 'IN_PROGRESS', total: 10 }))
  })
})
