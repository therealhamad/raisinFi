const { expect } = require('chai')
const { ethers } = require('hardhat')

describe('CREReportReceiverSmoke', function () {
	async function deployReceiver() {
		const [forwarder, caller] = await ethers.getSigners()
		const factory = await ethers.getContractFactory('CREReportReceiverSmoke')
		const receiver = await factory.deploy(forwarder.address)
		await receiver.waitForDeployment()
		return { receiver, forwarder, caller }
	}

	it('rejects a caller other than the configured Forwarder', async function () {
		const { receiver, caller } = await deployReceiver()
		await expect(receiver.connect(caller).onReport('0x1234', '0xabcd'))
			.to.be.revertedWithCustomError(receiver, 'UnauthorizedForwarder')
			.withArgs(caller.address)
	})

	it('accepts a report from the configured Forwarder and records its hash', async function () {
		const { receiver, forwarder } = await deployReceiver()
		const metadata = '0x1234'
		const report = '0xabcd'
		const expectedHash = ethers.keccak256(
			ethers.AbiCoder.defaultAbiCoder().encode(['bytes', 'bytes'], [metadata, report]),
		)

		await expect(receiver.connect(forwarder).onReport(metadata, report))
			.to.emit(receiver, 'ReportAccepted')
			.withArgs(expectedHash, ethers.keccak256(metadata), 2, 1)

		expect(await receiver.lastReportHash()).to.equal(expectedHash)
		expect(await receiver.reportCount()).to.equal(1)
	})

	it('rejects empty reports from the configured Forwarder', async function () {
		const { receiver, forwarder } = await deployReceiver()
		await expect(receiver.connect(forwarder).onReport('0x', '0x'))
			.to.be.revertedWithCustomError(receiver, 'EmptyReport')
	})
})
