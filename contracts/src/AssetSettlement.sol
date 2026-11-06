// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IReceiver} from "./IReceiver.sol";
import {ProtocolTypes} from "./ProtocolTypes.sol";

contract AssetSettlement is IReceiver, ReentrancyGuard {
    using SafeERC20 for IERC20;

    error UnauthorizedForwarder(address caller);
    error UnauthorizedSeller(address caller);
    error InvalidConfiguration();
    error InvalidTerms();
    error InvalidTermsHash(bytes32 expected, bytes32 provided);
    error TransactionAlreadyLocked(bytes32 transactionId);
    error TransactionNotFound(bytes32 transactionId);
    error InvalidDecisionReport();
    error DecisionAlreadyProcessed(bytes32 transactionId);
    error TransactionExpired(bytes32 transactionId);
    error TokenAmountMismatch(uint256 expected, uint256 actual);

    event AssetLocked(bytes32 indexed transactionId, bytes32 termsHash, address seller, uint256 amount);
    event DecisionReceived(
        bytes32 indexed transactionId,
        bytes32 termsHash,
        ProtocolTypes.Decision decision,
        bytes32 decisionRecordId
    );
    event AssetDelivered(bytes32 indexed transactionId, bytes32 termsHash, address recipient, uint256 amount);
    event AssetReleased(bytes32 indexed transactionId, bytes32 termsHash, address recipient, uint256 amount);

    struct Reservation {
        ProtocolTypes.Terms terms;
        bytes32 termsHash;
        bytes32 decisionRecordId;
        uint64 decisionNonce;
        ProtocolTypes.Decision decision;
        ProtocolTypes.AssetStatus status;
        bool exists;
    }

    address public immutable trustedForwarder;
    uint256 public immutable paymentChainId;
    address public immutable paymentContract;
    mapping(bytes32 transactionId => Reservation) private _reservations;

    constructor(address trustedForwarder_, uint256 paymentChainId_, address paymentContract_) {
        if (
            trustedForwarder_ == address(0) ||
            paymentChainId_ == 0 ||
            paymentContract_ == address(0)
        ) revert InvalidConfiguration();

        trustedForwarder = trustedForwarder_;
        paymentChainId = paymentChainId_;
        paymentContract = paymentContract_;
    }

    function computeTermsHash(ProtocolTypes.Terms calldata terms) external pure returns (bytes32) {
        return ProtocolTypes.hashTerms(terms);
    }

    function computeAssetObligationId(ProtocolTypes.Terms calldata terms) external pure returns (bytes32) {
        return ProtocolTypes.assetObligationId(terms);
    }

    function lockAsset(ProtocolTypes.Terms calldata terms, bytes32 expectedTermsHash) external nonReentrant {
        _validateTerms(terms);
        if (msg.sender != terms.seller) revert UnauthorizedSeller(msg.sender);
        bytes32 computedTermsHash = ProtocolTypes.hashTerms(terms);
        if (computedTermsHash != expectedTermsHash) {
            revert InvalidTermsHash(computedTermsHash, expectedTermsHash);
        }
        if (_reservations[terms.transactionId].exists) {
            revert TransactionAlreadyLocked(terms.transactionId);
        }

        IERC20 assetToken = IERC20(terms.assetToken);
        uint256 balanceBefore = assetToken.balanceOf(address(this));
        assetToken.safeTransferFrom(terms.seller, address(this), terms.assetAmount);
        uint256 amountReceived = assetToken.balanceOf(address(this)) - balanceBefore;
        if (amountReceived != terms.assetAmount) {
            revert TokenAmountMismatch(terms.assetAmount, amountReceived);
        }

        Reservation storage reservation = _reservations[terms.transactionId];
        reservation.terms = terms;
        reservation.termsHash = computedTermsHash;
        reservation.status = ProtocolTypes.AssetStatus.LOCKED;
        reservation.exists = true;

        emit AssetLocked(terms.transactionId, computedTermsHash, terms.seller, terms.assetAmount);
    }

    function onReport(bytes calldata, bytes calldata report) external override nonReentrant {
        if (msg.sender != trustedForwarder) revert UnauthorizedForwarder(msg.sender);

        ProtocolTypes.DecisionRelayReport memory decisionReport =
            abi.decode(report, (ProtocolTypes.DecisionRelayReport));
        Reservation storage reservation = _getReservation(decisionReport.transactionId);
        if (reservation.status != ProtocolTypes.AssetStatus.LOCKED) {
            revert DecisionAlreadyProcessed(decisionReport.transactionId);
        }
        _validateDecisionReport(reservation, decisionReport);

        reservation.decision = decisionReport.decision;
        reservation.decisionRecordId = decisionReport.decisionRecordId;
        reservation.decisionNonce = decisionReport.decisionNonce;
        reservation.status = decisionReport.decision == ProtocolTypes.Decision.COMMIT
            ? ProtocolTypes.AssetStatus.DELIVERED
            : ProtocolTypes.AssetStatus.RELEASED;

        IERC20 assetToken = IERC20(reservation.terms.assetToken);
        address recipient = decisionReport.decision == ProtocolTypes.Decision.COMMIT
            ? reservation.terms.buyer
            : reservation.terms.seller;
        uint256 recipientBalanceBefore = assetToken.balanceOf(recipient);
        if (decisionReport.decision == ProtocolTypes.Decision.COMMIT) {
            assetToken.safeTransfer(reservation.terms.buyer, reservation.terms.assetAmount);
            emit AssetDelivered(
                decisionReport.transactionId,
                reservation.termsHash,
                reservation.terms.buyer,
                reservation.terms.assetAmount
            );
        } else {
            assetToken.safeTransfer(reservation.terms.seller, reservation.terms.assetAmount);
            emit AssetReleased(
                decisionReport.transactionId,
                reservation.termsHash,
                reservation.terms.seller,
                reservation.terms.assetAmount
            );
        }
        uint256 amountDelivered = assetToken.balanceOf(recipient) - recipientBalanceBefore;
        if (amountDelivered != reservation.terms.assetAmount) {
            revert TokenAmountMismatch(reservation.terms.assetAmount, amountDelivered);
        }

        emit DecisionReceived(
            decisionReport.transactionId,
            reservation.termsHash,
            decisionReport.decision,
            decisionReport.decisionRecordId
        );
    }

    function getAssetReservation(bytes32 transactionId)
        external
        view
        returns (
            ProtocolTypes.Terms memory terms,
            bytes32 termsHash,
            ProtocolTypes.AssetStatus status,
            ProtocolTypes.Decision decision,
            bytes32 decisionRecordId,
            uint64 decisionNonce
        )
    {
        Reservation storage reservation = _reservations[transactionId];
        if (!reservation.exists) {
            ProtocolTypes.Terms memory emptyTerms;
            return (
                emptyTerms,
                bytes32(0),
                ProtocolTypes.AssetStatus.NONE,
                ProtocolTypes.Decision.UNDECIDED,
                bytes32(0),
                0
            );
        }
        return (
            reservation.terms,
            reservation.termsHash,
            reservation.status,
            reservation.decision,
            reservation.decisionRecordId,
            reservation.decisionNonce
        );
    }

    function _validateTerms(ProtocolTypes.Terms calldata terms) private view {
        if (
            terms.transactionId == bytes32(0) ||
            terms.buyer == address(0) ||
            terms.seller == address(0) ||
            terms.buyer == terms.seller ||
            terms.paymentChainId != paymentChainId ||
            terms.paymentContract != paymentContract ||
            terms.paymentInputToken == address(0) ||
            terms.paymentInputAmount == 0 ||
            terms.paymentToken == address(0) ||
            terms.paymentAmount == 0 ||
            terms.assetChainId != block.chainid ||
            terms.assetSettlement != address(this) ||
            terms.assetToken == address(0) ||
            terms.assetAmount == 0 ||
            terms.expiresAt <= block.timestamp ||
            terms.schemaVersion != ProtocolTypes.CURRENT_SCHEMA_VERSION
        ) revert InvalidTerms();
    }

    function _validateDecisionReport(
        Reservation storage reservation,
        ProtocolTypes.DecisionRelayReport memory report
    ) private view {
        ProtocolTypes.Terms storage terms = reservation.terms;
        if (
            report.decision == ProtocolTypes.Decision.UNDECIDED ||
            report.termsHash != reservation.termsHash ||
            report.sourceChainId != paymentChainId ||
            report.sourceContract != paymentContract ||
            report.destinationChainId != block.chainid ||
            report.destinationContract != address(this) ||
            report.assetObligationId != ProtocolTypes.assetObligationId(terms) ||
            report.decisionNonce != 1 ||
            report.decisionRecordId != ProtocolTypes.decisionRecordId(
                paymentChainId,
                paymentContract,
                report.transactionId,
                reservation.termsHash,
                report.decision,
                report.decisionNonce
            ) ||
            report.sourceDecisionBlockNumber == 0 ||
            report.buyer != terms.buyer ||
            report.seller != terms.seller ||
            report.assetToken != terms.assetToken ||
            report.assetAmount != terms.assetAmount ||
            report.expiresAt != terms.expiresAt
        ) revert InvalidDecisionReport();
    }

    function _getReservation(bytes32 transactionId)
        private
        view
        returns (Reservation storage reservation)
    {
        reservation = _reservations[transactionId];
        if (!reservation.exists) revert TransactionNotFound(transactionId);
    }
}
