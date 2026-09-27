export type RuntimeHealthState = {
  totalFailures: number
  totalRecoveries: number
  degradedMode: boolean
}

export type QueueSchedulerItem = {
  id: string
  status: 'waiting' | 'processing' | 'ready' | 'failed' | 'cancelled'
  progress: number
  error?: string
  attempts?: number
}

export const MAX_RETRY_ATTEMPTS = 2

export const shouldRetryJob = (attempts: number) => attempts < MAX_RETRY_ATTEMPTS

export const getAdaptiveConcurrencyLimit = (
  queueLength: number,
  runtimeHealth: RuntimeHealthState,
  hardwareCpu: number,
): number => {
  const cpuLimit = Math.max(1, Math.min(4, hardwareCpu))
  const stagedBatchLimit = 4

  if (runtimeHealth.degradedMode) {
    return Math.min(1, cpuLimit)
  }

  if (queueLength >= 100) {
    return Math.min(stagedBatchLimit, cpuLimit)
  }

  if (queueLength >= 30) {
    return Math.min(stagedBatchLimit, cpuLimit)
  }

  if (queueLength >= 10) {
    return Math.min(stagedBatchLimit, cpuLimit)
  }

  return Math.min(stagedBatchLimit, Math.max(1, cpuLimit))
}

export const getNextQueuedJob = <T extends QueueSchedulerItem>(
  jobs: T[],
  activeIds: Set<string>,
  finishedIds: Set<string>,
): T | undefined => {
  const priorityMap: Record<QueueSchedulerItem['status'], number> = {
    waiting: 0,
    processing: 3,
    ready: 4,
    failed: 1,
    cancelled: 2,
  }

  const eligibleJobs = jobs.filter((job) => {
    if (activeIds.has(job.id) || finishedIds.has(job.id)) {
      return false
    }

    return job.status === 'waiting' || job.status === 'failed' || job.status === 'cancelled'
  })

  return eligibleJobs.sort((left, right) => {
    const priorityDelta = priorityMap[left.status as QueueSchedulerItem['status']] - priorityMap[right.status as QueueSchedulerItem['status']]
    if (priorityDelta !== 0) {
      return priorityDelta
    }

    const leftAttempts = left.attempts ?? 0
    const rightAttempts = right.attempts ?? 0
    return leftAttempts - rightAttempts
  })[0]
}

export const shouldDegradeQueue = (
  runtimeHealth: RuntimeHealthState,
  queueLength: number,
): boolean => {
  if (runtimeHealth.degradedMode) {
    return true
  }

  return runtimeHealth.totalFailures > 0 && queueLength >= 10
}

export const getRetryDecision = (attempts: number) => ({
  retryAllowed: shouldRetryJob(attempts),
  nextAttempts: attempts + 1,
})
