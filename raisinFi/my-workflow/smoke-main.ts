import { Runner } from '@chainlink/cre-sdk'
import { initSmokeWorkflow, smokeConfigSchema } from './smoke-workflow'

export async function main() {
	const runner = await Runner.newRunner({ configSchema: smokeConfigSchema })
	await runner.run(initSmokeWorkflow)
}

main()
