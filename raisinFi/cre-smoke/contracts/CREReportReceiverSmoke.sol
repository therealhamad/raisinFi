// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

interface ICREReportReceiver {
	function onReport(bytes calldata metadata, bytes calldata report) external;
}

/// @notice Isolated test receiver for verifying CRE's Forwarder-authenticated EVM Write path.
/// @dev Not a settlement contract. It stores only a report hash and count.
contract CREReportReceiverSmoke is ICREReportReceiver {
	address public immutable expectedForwarder;
	bytes32 public lastReportHash;
	uint64 public reportCount;

	error InvalidForwarder();
	error UnauthorizedForwarder(address caller);
	error EmptyReport();

	event ReportAccepted(
		bytes32 indexed reportHash,
		bytes32 metadataHash,
		uint256 reportLength,
		uint64 reportCount
	);

	constructor(address forwarder) {
		if (forwarder == address(0)) revert InvalidForwarder();
		expectedForwarder = forwarder;
	}

	function onReport(bytes calldata metadata, bytes calldata report) external override {
		if (msg.sender != expectedForwarder) revert UnauthorizedForwarder(msg.sender);
		if (report.length == 0) revert EmptyReport();

		bytes32 reportHash = keccak256(abi.encode(metadata, report));
		lastReportHash = reportHash;
		unchecked {
			reportCount += 1;
		}
		emit ReportAccepted(reportHash, keccak256(metadata), report.length, reportCount);
	}
}
