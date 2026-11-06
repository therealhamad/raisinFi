require('@nomicfoundation/hardhat-ethers')
require('@nomicfoundation/hardhat-chai-matchers')

const { subtask } = require('hardhat/config')
const { TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD } = require('hardhat/builtin-tasks/task-names')

subtask(TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD).setAction(async ({ solcVersion }, _hre, runSuper) => {
	if (solcVersion === '0.8.24') {
		return {
			compilerPath: require.resolve('solc/soljson.js'),
			isSolcJs: true,
			version: '0.8.24',
			longVersion: '0.8.24+commit.e11b9ed9',
		}
	}
	return runSuper()
})

module.exports = {
	solidity: '0.8.24',
	paths: {
		sources: './contracts',
		tests: './test',
		cache: './cache',
		artifacts: './artifacts',
	},
}
