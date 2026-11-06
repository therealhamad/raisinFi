import { cre, type CronPayload, type Runtime } from '@chainlink/cre-sdk'
import { encodeAbiParameters, parseAbiParameters, type Address } from 'viem'
import { z } from 'zod'
import { writeCreReport } from './report-write'

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'
const addressSchema = z
	.string()
	.regex(/^0x[0-9a-fA-F]{40}$/)
	.refine((address) => address.toLowerCase() !== ZERO_ADDRESS, 'Deploy and configure the smoke receiver first')

export const smokeConfigSchema = z.object({
	schedule: z.string(),
	chainName: z.enum(['ethereum-testnet-sepolia', 'ethereum-testnet-sepolia-base-1']),
	receiverAddress: addressSchema,
	message: z.string().min(1),
	sequence: z.string().regex(/^(0|[1-9][0-9]*)$/),
})

type SmokeConfig = z.infer<typeof smokeConfigSchema>

const SMOKE_REPORT_PARAMETERS = parseAbiParameters('string message, uint64 sequence')

export function onSmokeCron(runtime: Runtime<SmokeConfig>, payload: CronPayload): string {
	if (!payload.scheduledExecutionTime) throw new Error('Scheduled execution time is required')
	const { chainName, receiverAddress, message, sequence } = runtime.config
	const encodedReport = encodeAbiParameters(SMOKE_REPORT_PARAMETERS, [message, BigInt(sequence)])
	const result = writeCreReport(
		runtime,
		chainName,
		receiverAddress as Address,
		encodedReport,
	)
	if (result.receiverExecution !== 'SUCCESS') {
		throw new Error(`CRE report receiver execution was ${result.receiverExecution}`)
	}
	runtime.log(
		`CRE receiver smoke report | chain=${chainName} | receiver=${receiverAddress} | txHash=${result.txHash ?? 'unavailable'} | execution=${result.receiverExecution}`,
	)
	return result.txHash ?? 'report-submitted-without-transaction-hash'
}

export function initSmokeWorkflow(config: SmokeConfig) {
	const cron = new cre.capabilities.CronCapability()
	return [
		cre.handler(
			cron.trigger({ schedule: config.schedule }),
			onSmokeCron,
		),
	]
}
