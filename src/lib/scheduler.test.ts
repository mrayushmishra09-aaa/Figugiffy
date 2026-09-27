import { describe, expect, it } from 'vitest'
import { getAdaptiveConcurrencyLimit, getNextQueuedJob } from './scheduler'

describe('getAdaptiveConcurrencyLimit', () => {
  it('allows up to four staged clips on capable devices', () => {
    const limit = getAdaptiveConcurrencyLimit(4, { totalFailures: 0, totalRecoveries: 0, degradedMode: false }, 8)

    expect(limit).toBe(4)
  })

  it('limits concurrency to available CPU capacity and degrades after failures', () => {
    expect(getAdaptiveConcurrencyLimit(8, { totalFailures: 0, totalRecoveries: 0, degradedMode: false }, 2)).toBe(2)
    expect(getAdaptiveConcurrencyLimit(8, { totalFailures: 2, totalRecoveries: 0, degradedMode: true }, 8)).toBe(1)
  })
})

describe('getNextQueuedJob', () => {
  it('promotes the next staged clip as soon as a slot is free', () => {
    const jobs = [
      { id: '1', status: 'processing' as const, progress: 35 },
      { id: '2', status: 'waiting' as const, progress: 0 },
      { id: '3', status: 'waiting' as const, progress: 0 },
    ]

    expect(getNextQueuedJob(jobs, new Set([1]), new Set())).toMatchObject({ id: 2 })
    expect(getNextQueuedJob(jobs, new Set([1, 2]), new Set())).toMatchObject({ id: 3 })
  })
})
