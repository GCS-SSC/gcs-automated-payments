import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import type { ManagedExtensionE2eDependencies } from '../../../../scripts/extension-managed-e2e'
import {
  automatedPaymentsManagedE2eConfig,
  runManagedAutomatedPaymentsE2e
} from '../../scripts/test-e2e-managed'

const ownedSpec = 'tests/e2e/automated-payment-lifecycle.spec.ts'

const controlledChild = (exitCode?: number) => {
  let finish: ((code: number) => void) | undefined
  const exited = exitCode === undefined
    ? new Promise<number>(resolve => { finish = resolve })
    : Promise.resolve(exitCode)
  return {
    child: {
      exited,
      exitCode: null,
      signalCode: null,
      kill: vi.fn(() => {
        finish?.(143)
        return true
      })
    },
    finish
  }
}

const fixture = (playwrightExitCode: number | null = 0, serverExitCode: number | null = null) => {
  const server = controlledChild(serverExitCode ?? undefined)
  const playwright = controlledChild(playwrightExitCode ?? undefined)
  const signalSource = new EventEmitter()
  const cleanup = vi.fn(async () => {})
  const exit = vi.fn()
  const spawn = vi.fn((command: string[]) => command[0] === 'node' ? server.child : playwright.child)
  const dependencies: ManagedExtensionE2eDependencies = {
    allocatePort: vi.fn(async () => 43124),
    createDataPaths: vi.fn(async () => ({
      cleanup,
      localFileStorageDir: '/tmp/automated-payments-files-owned',
      ownsLocalFileStorageDir: true,
      ownsPgliteDataDir: true,
      pgliteDataDir: '/tmp/automated-payments-pglite-owned'
    })),
    exit,
    prepareHost: vi.fn(async () => {}),
    signalSource,
    spawn,
    waitForHost: vi.fn(async () => {})
  }
  return { cleanup, dependencies, exit, playwright, server, signalSource, spawn }
}

describe('Automated Payments managed E2E runner', () => {
  it('has an exact one-spec inventory and runs it with disposable database and storage', async () => {
    expect(automatedPaymentsManagedE2eConfig.acceptedSpec).toBe(ownedSpec)
    const state = fixture()
    await runManagedAutomatedPaymentsE2e([ownedSpec], { DATABASE_URL: 'postgres://must-not-leak' }, state.dependencies)

    const environment = vi.mocked(state.dependencies.prepareHost).mock.calls[0]![0]
    expect(environment).toMatchObject({
      GCS_E2E_EXTENSION_WORKSPACE: 'gcs-automated-payments',
      GCS_LOCAL_FILE_STORAGE_DIR: '/tmp/automated-payments-files-owned',
      PGLITE_DATA_DIR: '/tmp/automated-payments-pglite-owned'
    })
    expect(environment.DATABASE_URL).toBeUndefined()
    expect(state.spawn.mock.calls[1]![0]).toEqual([
      'bun', 'x', 'playwright', 'test', '--config', 'playwright.config.ts', ownedSpec
    ])
    expect(state.cleanup).toHaveBeenCalledOnce()
  })

  it('rejects arbitrary specs before allocating resources', async () => {
    const state = fixture()
    await expect(runManagedAutomatedPaymentsE2e(['../foreign.spec.ts'], {}, state.dependencies))
      .rejects.toThrow(`accepts only the exact owned spec: ${ownedSpec}`)
    expect(state.dependencies.createDataPaths).not.toHaveBeenCalled()
  })

  it('cleans all owned state when Playwright fails', async () => {
    const state = fixture(2)
    await expect(runManagedAutomatedPaymentsE2e([ownedSpec], {}, state.dependencies))
      .rejects.toThrow('gcs-automated-payments Playwright exited with code 2')
    expect(state.server.child.kill).toHaveBeenCalledOnce()
    expect(state.cleanup).toHaveBeenCalledOnce()
  })

  it('cleans children and owned state on SIGTERM', async () => {
    const state = fixture(null)
    const running = runManagedAutomatedPaymentsE2e([ownedSpec], {}, state.dependencies)
    const rejected = expect(running).rejects.toThrow('Playwright exited with code 143')
    await vi.waitFor(() => expect(state.spawn).toHaveBeenCalledTimes(2))
    state.signalSource.emit('SIGTERM')
    await vi.waitFor(() => expect(state.exit).toHaveBeenCalledWith(143))
    await rejected
    expect(state.cleanup).toHaveBeenCalledOnce()
  })
})
