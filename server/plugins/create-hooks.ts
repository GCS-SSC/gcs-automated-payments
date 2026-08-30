import {
  defineGcsExtensionNitroPlugin,
  registerGcsExtensionAgreementPaymentMutationGuard,
  registerGcsExtensionCreateOperationHandler
} from '@gcs-ssc/extensions/server'
import { sql, type Transaction } from 'kysely'
import {
  AutomatedPaymentCalculateSchema,
  EXTENSION_KEY,
  ZERO_AUTOMATED_PAYMENT_MONEY,
  compareAutomatedPaymentMoney,
  parseAutomatedPaymentMoney,
  parseAutomatedPaymentExtensionPayload,
} from '../../shared/automated-payments'
import {
  calculateAutomatedPaymentFromDb,
  getPaymentMetadata,
  lockAutomatedPaymentAgreement,
  savePaymentMetadata
} from '../calculation-data'
import { createAutomatedPaymentUserError } from '../errors'
import { guardAutomatedPaymentsActivation } from '../activation'
import { databaseNumericText, parseDatabaseMoney } from '../numeric'

const EXTENSION_ENABLE_GUARD_HOOK = 'gcs:extension:enable-guard'

interface ExtensionEnableGuardContext {
  extensionKey: string
  scope: 'agency' | 'stream'
  db: Transaction<unknown>
  agencyId: string
  streamId?: string
}

interface ExtensionEnableGuardRegistrar {
  hooks: {
    hook: (
      name: typeof EXTENSION_ENABLE_GUARD_HOOK,
      handler: (context: ExtensionEnableGuardContext) => Promise<void> | void
    ) => void
  }
}

export default defineGcsExtensionNitroPlugin(nitroApp => {
  const lifecycleHooks = nitroApp as ExtensionEnableGuardRegistrar
  lifecycleHooks.hooks.hook(EXTENSION_ENABLE_GUARD_HOOK, async context => {
    if (
      context.extensionKey !== EXTENSION_KEY
      || context.scope !== 'stream'
      || context.streamId === undefined
    ) {
      return
    }

    await guardAutomatedPaymentsActivation(
      context.db as Parameters<typeof guardAutomatedPaymentsActivation>[0],
      context.streamId
    )
  })

  registerGcsExtensionCreateOperationHandler(EXTENSION_KEY, 'agreement.payments.create', async context => {
    const parsed = AutomatedPaymentCalculateSchema.safeParse(context.validatedBody)
    if (!parsed.success) {
      return { status: 'continue' }
    }

    const extensionPayload = parseAutomatedPaymentExtensionPayload(parsed.data.extensions?.[EXTENSION_KEY])
    await lockAutomatedPaymentAgreement(
      context.trx as Parameters<typeof lockAutomatedPaymentAgreement>[0],
      context.agreementId
    )

    if (context.createdRecord) {
      const calculation = await calculateAutomatedPaymentFromDb(
        context.trx as Parameters<typeof calculateAutomatedPaymentFromDb>[0],
        {
          agreementId: context.agreementId,
          commitmentType: parsed.data.egcs_fc_commitmenttype,
          fiscalYearId: parsed.data.egcs_fc_fiscalyear,
          paymentType: parsed.data.egcs_fc_paymenttype,
          periodEnd: parsed.data.egcs_fc_periodend,
          submittedAmount: parsed.data.egcs_fc_paymentamount,
          releaseHoldback: extensionPayload.releaseHoldback,
          holdbackReleaseAmount: extensionPayload.holdbackReleaseAmount,
          excludePaymentId: String(context.createdRecord.id)
        },
        context.config
      )
      await savePaymentMetadata(
        context.trx as Parameters<typeof savePaymentMetadata>[0],
        String(context.createdRecord.id),
        {
          releaseHoldback: extensionPayload.releaseHoldback,
          holdbackReleaseAmount: calculation.holdbackReleaseAmount
        }
      )
      return { status: 'continue' }
    }

    if (context.phase !== 'before-create') {
      return { status: 'continue' }
    }

    const calculation = await calculateAutomatedPaymentFromDb(
      context.trx as Parameters<typeof calculateAutomatedPaymentFromDb>[0],
      {
        agreementId: context.agreementId,
        commitmentType: parsed.data.egcs_fc_commitmenttype,
        fiscalYearId: parsed.data.egcs_fc_fiscalyear,
        paymentType: parsed.data.egcs_fc_paymenttype,
        periodEnd: parsed.data.egcs_fc_periodend,
        submittedAmount: parsed.data.egcs_fc_paymentamount,
        releaseHoldback: extensionPayload.releaseHoldback,
        holdbackReleaseAmount: extensionPayload.holdbackReleaseAmount
      },
      context.config
    )

    if (!calculation.enabled) {
      return { status: 'continue' }
    }

    const submittedAmount = parsed.data.egcs_fc_paymentamount ?? ZERO_AUTOMATED_PAYMENT_MONEY
    if (compareAutomatedPaymentMoney(submittedAmount, calculation.ceilingAmount) > 0) {
      throw createAutomatedPaymentUserError('GCS_AUTOMATED_PAYMENTS_AMOUNT_EXCEEDS_CEILING', 'egcs_fc_paymentamount')
    }

    return { status: 'continue' }
  }, nitroApp as Parameters<typeof registerGcsExtensionCreateOperationHandler>[3])

  registerGcsExtensionAgreementPaymentMutationGuard(EXTENSION_KEY, async context => {
    const db = context.db as Transaction<Record<string, Record<string, unknown>>>
    await lockAutomatedPaymentAgreement(db, context.agreementId)
    if (context.operation !== 'payment.update') return
    const payment = await db
      .selectFrom('Funding_Case_Agreement_Payment')
      .innerJoin(
        'Funding_Case_Agreement_Commitment',
        'Funding_Case_Agreement_Commitment.id',
        'Funding_Case_Agreement_Payment.egcs_fc_fundingagreementcommitment'
      )
      .select([
        'Funding_Case_Agreement_Payment.egcs_fc_fiscalyear',
        'Funding_Case_Agreement_Payment.egcs_fc_paymenttype',
        'Funding_Case_Agreement_Payment.egcs_fc_periodend',
        databaseNumericText(sql.ref('Funding_Case_Agreement_Payment.egcs_fc_paymentamount')).as('egcs_fc_paymentamount'),
        'Funding_Case_Agreement_Payment.egcs_fc_fundingagreementcommitment'
      ])
      .where('Funding_Case_Agreement_Payment.id', '=', context.paymentId)
      .where('Funding_Case_Agreement_Payment._deleted', '=', false)
      .where('Funding_Case_Agreement_Commitment._deleted', '=', false)
      .forUpdate('Funding_Case_Agreement_Payment')
      .executeTakeFirst() as Record<string, unknown> | undefined
    if (!payment) return

    const changes = context.changes ?? {}
    const nextCommitmentId = String(
      changes.egcs_fc_fundingagreementcommitment
      ?? payment.egcs_fc_fundingagreementcommitment
    )
    const nextCommitment = await db
      .selectFrom('Funding_Case_Agreement_Commitment')
      .select([
        'egcs_fc_type as commitment_type',
        'egcs_fc_transferpaymentstream as stream_id'
      ])
      .where('id', '=', nextCommitmentId)
      .where('egcs_fc_fundingagreement', '=', context.agreementId)
      .where('_deleted', '=', false)
      .executeTakeFirst() as { commitment_type?: unknown, stream_id?: unknown } | undefined
    if (!nextCommitment) return

    const streamConfig = await db
      .selectFrom('extensions.stream_configuration')
      .select('config')
      .where('stream_id', '=', String(nextCommitment.stream_id))
      .where('extension_key', '=', EXTENSION_KEY)
      .where('enabled', '=', true)
      .where('_deleted', '=', false)
      .executeTakeFirst() as { config?: unknown } | undefined
    if (!streamConfig) return

    const metadata = await getPaymentMetadata(db, context.paymentId)
    const calculation = await calculateAutomatedPaymentFromDb(db, {
      agreementId: context.agreementId,
      commitmentType: String(nextCommitment.commitment_type),
      fiscalYearId: String(changes.egcs_fc_fiscalyear ?? payment.egcs_fc_fiscalyear),
      paymentType: String(changes.egcs_fc_paymenttype ?? payment.egcs_fc_paymenttype) as 'reimbursement' | 'advance',
      periodEnd: Number(changes.egcs_fc_periodend ?? payment.egcs_fc_periodend),
      submittedAmount: changes.egcs_fc_paymentamount === undefined
        ? parseDatabaseMoney(payment.egcs_fc_paymentamount)
        : parseAutomatedPaymentMoney(changes.egcs_fc_paymentamount as string | number),
      releaseHoldback: metadata.releaseHoldback,
      holdbackReleaseAmount: metadata.holdbackReleaseAmount,
      excludePaymentId: context.paymentId
    }, streamConfig.config)
    const nextAmount = changes.egcs_fc_paymentamount === undefined
      ? parseDatabaseMoney(payment.egcs_fc_paymentamount)
      : parseAutomatedPaymentMoney(changes.egcs_fc_paymentamount as string | number)
    if (calculation.enabled && compareAutomatedPaymentMoney(nextAmount, calculation.ceilingAmount) > 0) {
      throw createAutomatedPaymentUserError('GCS_AUTOMATED_PAYMENTS_AMOUNT_EXCEEDS_CEILING', 'egcs_fc_paymentamount')
    }
  }, nitroApp as Parameters<typeof registerGcsExtensionAgreementPaymentMutationGuard>[2])
})
