export type ExecutionMode = 'local-simulation' | 'production-cre'

export interface ExecutionPolicy {
	executionMode: ExecutionMode
	allowLocalBroadcast: boolean
	enableProductionWrites: boolean
}

export type SubmissionPath = 'disabled' | 'local-mock-forwarder' | 'production-cre-forwarder'

/** Keep the two submission paths mutually exclusive and opt-in. */
export function selectSubmissionPath(policy: ExecutionPolicy): SubmissionPath {
	if (policy.executionMode === 'local-simulation') {
		if (policy.enableProductionWrites) {
			throw new Error('Production CRE writes cannot be enabled in local-simulation mode')
		}
		return policy.allowLocalBroadcast ? 'local-mock-forwarder' : 'disabled'
	}
	if (policy.allowLocalBroadcast) {
		throw new Error('The local test broadcast adapter cannot be enabled in production-cre mode')
	}
	return policy.enableProductionWrites ? 'production-cre-forwarder' : 'disabled'
}
