import {
	bytesToHex,
	cre,
	encodeCallMsg,
	getNetwork,
	LAST_FINALIZED_BLOCK_NUMBER,
	logTriggerConfig,
	protoBigIntToBigint,
	type EVMLog,
	type Runtime,
} from '@chainlink/cre-sdk'
import {
	decodeEventLog,
	decodeFunctionResult,
	encodeAbiParameters,
	encodeFunctionData,
	parseAbi,
	parseAbiParameters,
	toEventSelector,
	type Address,
	type Hex,
	zeroAddress,
} from 'viem'
import { z } from 'zod'
import {
	evaluateDecisionRelay,
	evaluateReservationReadiness,
	type AssetReservation,
	type Decision,
	type ExpectedTerms,
	type PaymentReservation,
	type ReservationStatus,
} from './domain'
import { writeCreReport } from './report-write'

const PAYMENT_LOCKED_ABI = parseAbi([
	'event PaymentLocked(bytes32 indexed transactionId, bytes32 termsHash, address payer, uint256 amount)',
])
const ASSET_LOCKED_ABI = parseAbi([
	'event AssetLocked(bytes32 indexed transactionId, bytes32 termsHash, address seller, uint256 amount)',
])
const DECISION_RECORDED_ABI = parseAbi([
	'event DecisionRecorded(bytes32 indexed transactionId, bytes32 termsHash, uint8 decision)',
])
const PAYMENT_RESERVATION_ABI = parseAbi([
	'function getPaymentReservation(bytes32 transactionId) view returns (bytes32 reservationTransactionId, bytes32 termsHash, bytes32 paymentObligationId, address buyer, address seller, address paymentToken, uint256 paymentAmount, uint256 expiresAt, uint8 status)',
])
const ASSET_RESERVATION_ABI = parseAbi([
	'function getAssetReservation(bytes32 transactionId) view returns (bytes32 reservationTransactionId, bytes32 termsHash, bytes32 assetObligationId, address buyer, address seller, address assetToken, uint256 assetAmount, uint256 expiresAt, uint8 status)',
])
const DECISION_ABI = parseAbi([
	'function getDecision(bytes32 transactionId) view returns (bytes32 decisionTransactionId, bytes32 termsHash, bytes32 paymentObligationId, bytes32 assetObligationId, uint8 decision, bytes32 recordId)',
])
const COMMIT_REPORT_PARAMETERS = parseAbiParameters(
	'bytes32 transactionId, bytes32 termsHash, uint256 paymentChainId, address paymentContract, uint256 assetChainId, address assetContract, bytes32 paymentObligationId, bytes32 assetObligationId',
)
const DECISION_RELAY_REPORT_PARAMETERS = parseAbiParameters(
	'uint256 sourceChainId, address sourceContract, bytes32 transactionId, bytes32 termsHash, bytes32 paymentObligationId, bytes32 assetObligationId, uint8 decision, bytes32 recordId, uint256 sourceDecisionBlockNumber, bytes32 sourceDecisionBlockHash, uint256 destinationChainId, address destinationContract',
)

const PAYMENT_LOCKED_TOPIC = toEventSelector(
	'PaymentLocked(bytes32,bytes32,address,uint256)',
)
const ASSET_LOCKED_TOPIC = toEventSelector(
	'AssetLocked(bytes32,bytes32,address,uint256)',
)
const DECISION_RECORDED_TOPIC = toEventSelector(
	'DecisionRecorded(bytes32,bytes32,uint8)',
)
const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'
const PAYMENT_CHAIN_ID = '11155111'
const ASSET_CHAIN_ID = '84532'

const contractAddressSchema = z
	.string()
	.regex(ADDRESS_PATTERN)
	.refine((address) => address.toLowerCase() !== ZERO_ADDRESS, 'Settlement contract address is not configured')

export const configSchema = z.object({
	paymentContractAddress: contractAddressSchema,
	assetContractAddress: contractAddressSchema,
	enableWrites: z.boolean().default(false),
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

const decodeReservationStatus = (statusCode: bigint | number): ReservationStatus => {
	switch (BigInt(statusCode)) {
		case 0n:
			return 'NONE'
		case 1n:
			return 'LOCKED'
		case 2n:
			return 'EXECUTED'
		case 3n:
			return 'RELEASED'
		default:
			throw new Error(`Unknown reservation status code: ${statusCode}`)
	}
}

const decodeDecision = (decisionCode: bigint | number): Decision => {
	switch (BigInt(decisionCode)) {
		case 0n:
			return 'UNDECIDED'
		case 1n:
			return 'COMMIT'
		case 2n:
			return 'ABORT'
		default:
			throw new Error(`Unknown decision code: ${decisionCode}`)
	}
}

const readPaymentReservation = (
	runtime: Runtime<Config>,
	transactionId: Hex,
): PaymentReservation => {
	const { client } = getEvmClient('ethereum-testnet-sepolia')
	const callData = encodeFunctionData({
		abi: PAYMENT_RESERVATION_ABI,
		functionName: 'getPaymentReservation',
		args: [transactionId],
	})
	const response = client
		.callContract(runtime, {
			call: encodeCallMsg({
				from: zeroAddress,
				to: runtime.config.paymentContractAddress as Address,
				data: callData,
			}),
		})
		.result()
	const [reservationTransactionId, termsHash, obligationId, buyer, seller, token, amount, expiresAt, status] =
		decodeFunctionResult({
			abi: PAYMENT_RESERVATION_ABI,
			functionName: 'getPaymentReservation',
			data: bytesToHex(response.data),
		})
	return {
		transactionId: reservationTransactionId,
		termsHash,
		buyer,
		seller,
		chainId: PAYMENT_CHAIN_ID,
		contract: runtime.config.paymentContractAddress,
		token,
		amount: amount.toString(),
		obligationId,
		expiresAt: expiresAt.toString(),
		status: decodeReservationStatus(status),
	}
}

const readAssetReservation = (
	runtime: Runtime<Config>,
	transactionId: Hex,
): AssetReservation => {
	const { client } = getEvmClient('ethereum-testnet-sepolia-base-1')
	const callData = encodeFunctionData({
		abi: ASSET_RESERVATION_ABI,
		functionName: 'getAssetReservation',
		args: [transactionId],
	})
	const response = client
		.callContract(runtime, {
			call: encodeCallMsg({
				from: zeroAddress,
				to: runtime.config.assetContractAddress as Address,
				data: callData,
			}),
		})
		.result()
	const [reservationTransactionId, termsHash, obligationId, buyer, seller, token, amount, expiresAt, status] =
		decodeFunctionResult({
			abi: ASSET_RESERVATION_ABI,
			functionName: 'getAssetReservation',
			data: bytesToHex(response.data),
		})
	return {
		transactionId: reservationTransactionId,
		termsHash,
		buyer,
		seller,
		chainId: ASSET_CHAIN_ID,
		contract: runtime.config.assetContractAddress,
		token,
		amount: amount.toString(),
		obligationId,
		expiresAt: expiresAt.toString(),
		status: decodeReservationStatus(status),
	}
}

const readAuthoritativeDecision = (
	runtime: Runtime<Config>,
	transactionId: Hex,
	finalized = false,
) => {
	const { client } = getEvmClient('ethereum-testnet-sepolia')
	const callData = encodeFunctionData({
		abi: DECISION_ABI,
		functionName: 'getDecision',
		args: [transactionId],
	})
	const response = client
		.callContract(runtime, {
			call: encodeCallMsg({
				from: zeroAddress,
				to: runtime.config.paymentContractAddress as Address,
				data: callData,
			}),
			...(finalized ? { blockNumber: LAST_FINALIZED_BLOCK_NUMBER } : {}),
		})
		.result()
	const [decisionTransactionId, termsHash, paymentObligationId, assetObligationId, decision, recordId] = decodeFunctionResult({
		abi: DECISION_ABI,
		functionName: 'getDecision',
		data: bytesToHex(response.data),
	})
	return {
		decision: decodeDecision(decision),
		transactionId: decisionTransactionId,
		termsHash,
		paymentObligationId,
		assetObligationId,
		sourceChainId: PAYMENT_CHAIN_ID,
		sourceContract: runtime.config.paymentContractAddress,
		destinationChainId: ASSET_CHAIN_ID,
		destinationContract: runtime.config.assetContractAddress,
		recordId,
	}
}

const evaluateLockState = (
	runtime: Runtime<Config>,
	transactionId: Hex,
	termsHash: Hex,
	eventName: LockEventName,
	eventParticipant: Address,
	eventAmount: bigint,
): string => {
	const payment = readPaymentReservation(runtime, transactionId)
	const asset = readAssetReservation(runtime, transactionId)
	const decision = readAuthoritativeDecision(runtime, transactionId)
	const expectedParticipant = eventName === 'PaymentLocked' ? payment.buyer : asset.seller
	const expectedAmount = eventName === 'PaymentLocked' ? payment.amount : asset.amount
	if (
		eventParticipant.toLowerCase() !== expectedParticipant.toLowerCase() ||
		eventAmount.toString() !== expectedAmount
	) {
		runtime.log(`${eventName} event fields do not match the current reservation; refusing to evaluate COMMIT`)
		return 'REJECT'
	}
	const terms: ExpectedTerms = {
		transactionId,
		termsHash,
		buyer: payment.buyer,
		seller: payment.seller,
		paymentChainId: PAYMENT_CHAIN_ID,
		paymentContract: runtime.config.paymentContractAddress,
		paymentToken: payment.token,
		paymentAmount: payment.amount,
		paymentObligationId: payment.obligationId,
		assetChainId: ASSET_CHAIN_ID,
		assetContract: runtime.config.assetContractAddress,
		assetToken: asset.token,
		assetAmount: asset.amount,
		assetObligationId: asset.obligationId,
		expiresAt: payment.expiresAt,
	}

	const readiness = evaluateReservationReadiness(
		payment,
		asset,
		terms,
		Math.floor(runtime.now().getTime() / 1000).toString(),
		decision,
	)
	runtime.log(`Reservation evaluation | transactionId=${transactionId} | action=${readiness.action}`)
	if ('reason' in readiness) runtime.log(`Reservation evaluation reason: ${readiness.reason}`)
	if (readiness.action === 'SUBMIT_COMMIT') {
		runtime.log('Both matching reservations are locked and unexpired; COMMIT is eligible for Chain A contract validation')
		if (runtime.config.enableWrites) {
			const reportPayload = encodeAbiParameters(COMMIT_REPORT_PARAMETERS, [
				terms.transactionId as Hex,
				terms.termsHash as Hex,
				BigInt(terms.paymentChainId),
				terms.paymentContract as Address,
				BigInt(terms.assetChainId),
				terms.assetContract as Address,
				terms.paymentObligationId as Hex,
				terms.assetObligationId as Hex,
			])
			const result = writeCreReport(
				runtime,
				'ethereum-testnet-sepolia',
				terms.paymentContract as Address,
				reportPayload,
			)
			runtime.log(`Chain A report result | txHash=${result.txHash ?? 'unavailable'} | receiver=${result.receiverExecution}`)
		} else {
			runtime.log('CRE report submission is disabled; set enableWrites only after the consumer ABI and target have been reviewed')
		}
	}

	return readiness.action
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

	let transactionId: Hex
	let termsHash: Hex
	let eventParticipant: Address
	let eventAmount: bigint
	if (eventName === 'PaymentLocked') {
		const decoded = decodeEventLog({
			abi: PAYMENT_LOCKED_ABI,
			data: bytesToHex(log.data),
			topics: topics as [Hex, ...Hex[]],
		})
		transactionId = decoded.args.transactionId
		termsHash = decoded.args.termsHash
		eventParticipant = decoded.args.payer
		eventAmount = decoded.args.amount
	} else {
		const decoded = decodeEventLog({
			abi: ASSET_LOCKED_ABI,
			data: bytesToHex(log.data),
			topics: topics as [Hex, ...Hex[]],
		})
		transactionId = decoded.args.transactionId
		termsHash = decoded.args.termsHash
		eventParticipant = decoded.args.seller
		eventAmount = decoded.args.amount
	}
	if (!transactionId || !termsHash) {
		throw new Error(`${eventName} log is missing transaction binding fields`)
	}

	const { chainSelector } = getEvmClient(chainName)
	runtime.log(
		`${eventName} observed | source=${chainName} | chainSelector=${chainSelector} | contract=${emittingContract} | transactionId=${transactionId} | termsHash=${termsHash} | txHash=${bytesToHex(log.txHash)} | block=${log.blockNumber?.absVal ?? 'unknown'}`,
	)
	return evaluateLockState(
		runtime,
		transactionId,
		termsHash,
		eventName,
		eventParticipant,
		eventAmount,
	)
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

const onDecisionRecorded = (runtime: Runtime<Config>, log: EVMLog): string => {
	if (log.removed) {
		runtime.log('Ignoring removed DecisionRecorded log on Ethereum Sepolia')
		return 'ignored-reorg-removed-log'
	}
	const emittingContract = bytesToHex(log.address)
	if (emittingContract.toLowerCase() !== runtime.config.paymentContractAddress.toLowerCase()) {
		throw new Error('DecisionRecorded trigger came from an unexpected Chain A contract')
	}
	const topics = log.topics.map((topic) => bytesToHex(topic))
	if (topics[0]?.toLowerCase() !== DECISION_RECORDED_TOPIC.toLowerCase()) {
		throw new Error('DecisionRecorded trigger has an unexpected event signature')
	}
	const decoded = decodeEventLog({
		abi: DECISION_RECORDED_ABI,
		data: bytesToHex(log.data),
		topics: topics as [Hex, ...Hex[]],
	})
	const { transactionId, termsHash, decision: eventDecision } = decoded.args
	const decision = readAuthoritativeDecision(runtime, transactionId, true)
	if (decision.decision !== decodeDecision(eventDecision)) {
		throw new Error('Finalized decision state does not match the DecisionRecorded event')
	}
	const relay = evaluateDecisionRelay(
		decision,
		{
			transactionId,
			termsHash,
			paymentChainId: PAYMENT_CHAIN_ID,
			paymentContract: runtime.config.paymentContractAddress,
		},
		ASSET_CHAIN_ID,
		runtime.config.assetContractAddress,
	)
	runtime.log(
		`Finalized Chain A decision observed | transactionId=${transactionId} | termsHash=${termsHash} | decision=${decision.decision} | relay=${relay.action} | txHash=${bytesToHex(log.txHash)}`,
	)
	if ('reason' in relay) runtime.log(`Decision relay reason: ${relay.reason}`)
	if (relay.action === 'RELAY_COMMIT' || relay.action === 'RELAY_ABORT') {
		if (runtime.config.enableWrites) {
			if (!log.blockNumber) throw new Error('Finalized decision event is missing its source block number')
			const reportPayload = encodeAbiParameters(DECISION_RELAY_REPORT_PARAMETERS, [
				BigInt(decision.sourceChainId),
				decision.sourceContract as Address,
				decision.transactionId as Hex,
				decision.termsHash as Hex,
				decision.paymentObligationId as Hex,
				decision.assetObligationId as Hex,
				decision.decision === 'COMMIT' ? 1 : 2,
				decision.recordId as Hex,
				protoBigIntToBigint(log.blockNumber),
				bytesToHex(log.blockHash),
				BigInt(decision.destinationChainId),
				decision.destinationContract as Address,
			])
			const result = writeCreReport(
				runtime,
				'ethereum-testnet-sepolia-base-1',
				decision.destinationContract as Address,
				reportPayload,
			)
			runtime.log(`Chain B report result | txHash=${result.txHash ?? 'unavailable'} | receiver=${result.receiverExecution}`)
		} else {
			runtime.log('Chain B report submission is disabled; set enableWrites only after the consumer ABI and target have been reviewed')
		}
	}
	return relay.action
}

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
		cre.handler(
			paymentEvm.logTrigger(
				logTriggerConfig({
					addresses: [config.paymentContractAddress as Address],
					topics: [[DECISION_RECORDED_TOPIC]],
					confidence: 'FINALIZED',
				}),
			),
			onDecisionRecorded,
		),
	]
}

export { writeCreReport } from './report-write'
