import { fileURLToPath } from 'node:url'
import {
  runManagedExtensionE2e,
  type ManagedExtensionE2eConfig,
  type ManagedExtensionE2eDependencies
} from '../../../scripts/extension-managed-e2e'

export const automatedPaymentsManagedE2eConfig: ManagedExtensionE2eConfig = {
  acceptedSpec: 'tests/e2e/automated-payment-lifecycle.spec.ts',
  extensionKey: 'gcs-automated-payments',
  extensionRoot: fileURLToPath(new URL('../', import.meta.url)),
  suite: 'extension-automated-payments'
}

export const runManagedAutomatedPaymentsE2e = async (
  rawArguments: string[],
  inheritedEnvironment: NodeJS.ProcessEnv = process.env,
  dependencies?: ManagedExtensionE2eDependencies
): Promise<void> => await runManagedExtensionE2e(
  automatedPaymentsManagedE2eConfig,
  rawArguments,
  inheritedEnvironment,
  dependencies
)

const main = async (): Promise<void> => {
  await runManagedAutomatedPaymentsE2e(process.argv.slice(2))
}

if (import.meta.main) await main()
