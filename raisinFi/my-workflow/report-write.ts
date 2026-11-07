import {
	bytesToHex,
	cre,
	getNetwork,
	prepareReportRequest,
	TxStatus,
	type Runtime,
} from '@chainlink/cre-sdk'
import { EVM_PB } from '@chainlink/cre-sdk/pb'
import type { Address, Hex } from 'viem'

export interface ReportWriteResult {
	txHash: Hex | null
	receiverExecution: 'SUCCESS' | 'REVERTED' | 'UNKNOWN'
}

/** Submit an ABI-encoded receiver payload through CRE's official EVM Write capability. */
export function writeCreReport<C>(
	runtime: Runtime<C>,
	chainName: string,
	receiverAddress: Address,
	reportPayload: Hex,
	gasLimit = 1_000_000n,
): ReportWriteResult {
	const network = getNetwork({
		chainFamily: 'evm',
		chainSelectorName: chainName,
		isTestnet: true,
	})
	if (!network) throw new Error(`CRE network is unavailable: ${chainName}`)

	const evmClient = new cre.capabilities.EVMClient(network.chainSelector.selector)
	const report = runtime.report(prepareReportRequest(reportPayload)).result()
	const response = evmClient
		.writeReport(runtime, {
			receiver: receiverAddress,
			report,
			gasConfig: { gasLimit: gasLimit.toString() },
		})
		.result()

	if (response.txStatus !== TxStatus.SUCCESS) {
		throw new Error(`CRE EVM Write failed on ${chainName}: ${response.errorMessage ?? response.txStatus}`)
	}
	if (response.receiverContractExecutionStatus === EVM_PB.ReceiverContractExecutionStatus.REVERTED) {
		throw new Error(`CRE report was submitted but the receiver reverted on ${chainName}`)
	}
	return {
		txHash: response.txHash ? bytesToHex(response.txHash) : null,
		receiverExecution:
			response.receiverContractExecutionStatus === EVM_PB.ReceiverContractExecutionStatus.SUCCESS
				? 'SUCCESS'
				: response.receiverContractExecutionStatus === EVM_PB.ReceiverContractExecutionStatus.REVERTED
					? 'REVERTED'
					: 'UNKNOWN',
	}
}
