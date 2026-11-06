import {
	bytesToHex,
	cre,
	getNetwork,
	logTriggerConfig,
	type EVMLog,
	type Runtime,
} from '@chainlink/cre-sdk'
import {
	decodeEventLog,
	parseAbi,
	toEventSelector,
	type Address,
	type Hex,
} from 'viem'
import { z } from 'zod'

const PAYMENT_LOCKED_ABI = parseAbi([
	'event PaymentLocked(bytes32 indexed transactionId, bytes32 termsHash, address payer, uint256 amount)',
])
const ASSET_LOCKED_ABI = parseAbi([
	'event AssetLocked(bytes32 indexed transactionId, bytes32 termsHash, address seller, uint256 amount)',
])

const PAYMENT_LOCKED_TOPIC = toEventSelector(
	'PaymentLocked(bytes32,bytes32,address,uint256)',
)
const ASSET_LOCKED_TOPIC = toEventSelector(
	'AssetLocked(bytes32,bytes32,address,uint256)',
)
const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'

const contractAddressSchema = z
	.string()
	.regex(ADDRESS_PATTERN)
	.refine((address) => address.toLowerCase() !== ZERO_ADDRESS, 'Settlement contract address is not configured')

export const configSchema = z.object({
	paymentContractAddress: contractAddressSchema,
	assetContractAddress: contractAddressSchema,
})

type Config = z.infer<typeof configSchema>

type LockEventName = 'PaymentLocked' | 'AssetLocked'

const getEvmClient = (chainName: string) => {
	const network = getNetwork({
		chainFamily: 'evm',
		chainSelectorName: chainName,
		isTestnet: true,
	})
	if (!network) throw new Error(`CRE network is unavailable: ${chainName}`)

	return {
		client: new cre.capabilities.EVMClient(network.chainSelector.selector),
		chainSelector: network.chainSelector.selector.toString(),
	}
}

const handleLockEvent = (
	eventName: LockEventName,
	chainName: string,
	expectedContract: string,
	runtime: Runtime<Config>,
	log: EVMLog,
): string => {
	if (log.removed) {
		runtime.log(`Ignoring removed ${eventName} log from ${chainName}`)
		return 'ignored-reorg-removed-log'
	}

	const emittingContract = bytesToHex(log.address)
	if (emittingContract.toLowerCase() !== expectedContract.toLowerCase()) {
		throw new Error(`${eventName} trigger came from an unexpected contract on ${chainName}`)
	}

	const topics = log.topics.map((topic) => bytesToHex(topic))
	const eventTopic = eventName === 'PaymentLocked' ? PAYMENT_LOCKED_TOPIC : ASSET_LOCKED_TOPIC
	if (topics[0]?.toLowerCase() !== eventTopic.toLowerCase()) {
		throw new Error(`${eventName} trigger has an unexpected event signature`)
	}

	const decoded = eventName === 'PaymentLocked'
		? decodeEventLog({
				abi: PAYMENT_LOCKED_ABI,
				data: bytesToHex(log.data),
				topics: topics as [Hex, ...Hex[]],
			})
		: decodeEventLog({
				abi: ASSET_LOCKED_ABI,
				data: bytesToHex(log.data),
				topics: topics as [Hex, ...Hex[]],
			})

	const transactionId = decoded.args.transactionId
	const termsHash = decoded.args.termsHash
	if (!transactionId || !termsHash) {
		throw new Error(`${eventName} log is missing transaction binding fields`)
	}

	const { chainSelector } = getEvmClient(chainName)
	runtime.log(
		`${eventName} observed | source=${chainName} | chainSelector=${chainSelector} | contract=${emittingContract} | transactionId=${transactionId} | termsHash=${termsHash} | txHash=${bytesToHex(log.txHash)} | block=${log.blockNumber?.absVal ?? 'unknown'}`,
	)
	return 'lock-event-decoded'
}

const onPaymentLocked = (runtime: Runtime<Config>, log: EVMLog): string =>
	handleLockEvent(
		'PaymentLocked',
		'ethereum-testnet-sepolia',
		runtime.config.paymentContractAddress,
		runtime,
		log,
	)

const onAssetLocked = (runtime: Runtime<Config>, log: EVMLog): string =>
	handleLockEvent(
		'AssetLocked',
		'ethereum-testnet-sepolia-base-1',
		runtime.config.assetContractAddress,
		runtime,
		log,
	)

export function initWorkflow(config: Config) {
	const paymentEvm = getEvmClient('ethereum-testnet-sepolia').client
	const assetEvm = getEvmClient('ethereum-testnet-sepolia-base-1').client

	return [
		cre.handler(
			paymentEvm.logTrigger(
				logTriggerConfig({
					addresses: [config.paymentContractAddress as Address],
					topics: [[PAYMENT_LOCKED_TOPIC]],
					confidence: 'SAFE',
				}),
			),
			onPaymentLocked,
		),
		cre.handler(
			assetEvm.logTrigger(
				logTriggerConfig({
					addresses: [config.assetContractAddress as Address],
					topics: [[ASSET_LOCKED_TOPIC]],
					confidence: 'SAFE',
				}),
			),
			onAssetLocked,
		),
	]
}
