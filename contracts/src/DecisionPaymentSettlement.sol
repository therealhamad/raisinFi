// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IReceiver} from "./IReceiver.sol";
import {ProtocolTypes} from "./ProtocolTypes.sol";

contract DecisionPaymentSettlement is IReceiver, ReentrancyGuard {
    using SafeERC20 for IERC20;

    error UnauthorizedForwarder(address caller);
    error UnauthorizedBuyer(address caller);
    error InvalidTerms();
    error InvalidTermsHash(bytes32 expected, bytes32 provided);
    error TransactionAlreadyRegistered(bytes32 transactionId);
    error TransactionNotFound(bytes32 transactionId);
    error PaymentAlreadyLocked(bytes32 transactionId);
    error PaymentNotLocked(bytes32 transactionId);
    error DecisionAlreadyRecorded(bytes32 transactionId);
    error TransactionExpired(bytes32 transactionId);
    error TransactionNotExpired(bytes32 transactionId);
    error InvalidCoordinationReport();
    error SwapNotEnabled();
    error TokenAmountMismatch(uint256 expected, uint256 actual);

    event TransactionRegistered(bytes32 indexed transactionId, bytes32 termsHash, address buyer);
    event PaymentLocked(bytes32 indexed transactionId, bytes32 termsHash, address payer, uint256 amount);
    event DecisionRecorded(
        bytes32 indexed transactionId,
        bytes32 termsHash,
        ProtocolTypes.Decision decision
    );
    event PaymentExecuted(bytes32 indexed transactionId, bytes32 termsHash, address recipient, uint256 amount);
    event PaymentReleased(bytes32 indexed transactionId, bytes32 termsHash, address recipient, uint256 amount);

    struct Transaction {
        ProtocolTypes.Terms terms;
        bytes32 termsHash;
        bytes32 decisionRecordId;
        uint256 decisionBlockNumber;
        uint64 decisionNonce;
        ProtocolTypes.Decision decision;
        ProtocolTypes.PaymentStatus paymentStatus;
        bool exists;
    }

    address public immutable trustedForwarder;
    mapping(bytes32 transactionId => Transaction) private _transactions;

    constructor(address trustedForwarder_) {
        if (trustedForwarder_ == address(0)) revert InvalidTerms();
        trustedForwarder = trustedForwarder_;
    }

    function computeTermsHash(ProtocolTypes.Terms calldata terms) external pure returns (bytes32) {
        return ProtocolTypes.hashTerms(terms);
    }

    function registerTransaction(ProtocolTypes.Terms calldata terms) external returns (bytes32 termsHash) {
        _validateTerms(terms);
        if (msg.sender != terms.buyer) revert UnauthorizedBuyer(msg.sender);
        if (_transactions[terms.transactionId].exists) {
            revert TransactionAlreadyRegistered(terms.transactionId);
        }

        termsHash = ProtocolTypes.hashTerms(terms);
        Transaction storage transaction = _transactions[terms.transactionId];
        transaction.terms = terms;
        transaction.termsHash = termsHash;
        transaction.exists = true;

        emit TransactionRegistered(terms.transactionId, termsHash, terms.buyer);
    }

    function lockPayment(bytes32 transactionId, bytes32 termsHash) external nonReentrant {
        Transaction storage transaction = _getTransaction(transactionId);
        if (msg.sender != transaction.terms.buyer) revert UnauthorizedBuyer(msg.sender);
        if (transaction.termsHash != termsHash) revert InvalidTermsHash(transaction.termsHash, termsHash);
        if (transaction.decision != ProtocolTypes.Decision.UNDECIDED) {
            revert DecisionAlreadyRecorded(transactionId);
        }
        if (transaction.paymentStatus != ProtocolTypes.PaymentStatus.NONE) {
            revert PaymentAlreadyLocked(transactionId);
        }
        if (block.timestamp >= transaction.terms.expiresAt) revert TransactionExpired(transactionId);

        IERC20 inputToken = IERC20(transaction.terms.paymentInputToken);
        uint256 balanceBefore = inputToken.balanceOf(address(this));
        inputToken.safeTransferFrom(
            transaction.terms.buyer,
            address(this),
            transaction.terms.paymentInputAmount
        );
        uint256 amountReceived = inputToken.balanceOf(address(this)) - balanceBefore;
        if (amountReceived != transaction.terms.paymentInputAmount) {
            revert TokenAmountMismatch(transaction.terms.paymentInputAmount, amountReceived);
        }
        transaction.paymentStatus = ProtocolTypes.PaymentStatus.LOCKED;
        emit PaymentLocked(
            transactionId,
            termsHash,
            transaction.terms.buyer,
            transaction.terms.paymentInputAmount
        );
    }

    function onReport(bytes calldata, bytes calldata report) external override nonReentrant {
        if (msg.sender != trustedForwarder) revert UnauthorizedForwarder(msg.sender);

        ProtocolTypes.CoordinationReport memory coordination =
            abi.decode(report, (ProtocolTypes.CoordinationReport));
        Transaction storage transaction = _getTransaction(coordination.transactionId);
        if (transaction.decision != ProtocolTypes.Decision.UNDECIDED) {
            revert DecisionAlreadyRecorded(coordination.transactionId);
        }
        if (transaction.paymentStatus != ProtocolTypes.PaymentStatus.LOCKED) {
            revert PaymentNotLocked(coordination.transactionId);
        }
        if (block.timestamp >= transaction.terms.expiresAt) {
            revert TransactionExpired(coordination.transactionId);
        }
        _validateCoordinationReport(transaction, coordination);

        transaction.decision = ProtocolTypes.Decision.COMMIT;
        transaction.decisionNonce = 1;
        transaction.decisionRecordId = ProtocolTypes.decisionRecordId(
            block.chainid,
            address(this),
            coordination.transactionId,
            transaction.termsHash,
            ProtocolTypes.Decision.COMMIT,
            transaction.decisionNonce
        );
        transaction.decisionBlockNumber = block.number;
        transaction.paymentStatus = ProtocolTypes.PaymentStatus.PAID;

        IERC20 outputToken = IERC20(transaction.terms.paymentToken);
        uint256 recipientBalanceBefore = outputToken.balanceOf(transaction.terms.seller);
        outputToken.safeTransfer(
            transaction.terms.seller,
            transaction.terms.paymentAmount
        );
        uint256 amountPaid = outputToken.balanceOf(transaction.terms.seller) - recipientBalanceBefore;
        if (amountPaid != transaction.terms.paymentAmount) {
            revert TokenAmountMismatch(transaction.terms.paymentAmount, amountPaid);
        }

        emit DecisionRecorded(
            coordination.transactionId,
            transaction.termsHash,
            ProtocolTypes.Decision.COMMIT
        );
        emit PaymentExecuted(
            coordination.transactionId,
            transaction.termsHash,
            transaction.terms.seller,
            transaction.terms.paymentAmount
        );
    }

    function abort(bytes32 transactionId) external nonReentrant {
        Transaction storage transaction = _getTransaction(transactionId);
        if (transaction.decision != ProtocolTypes.Decision.UNDECIDED) {
            revert DecisionAlreadyRecorded(transactionId);
        }
        if (block.timestamp < transaction.terms.expiresAt) revert TransactionNotExpired(transactionId);

        transaction.decision = ProtocolTypes.Decision.ABORT;
        transaction.decisionNonce = 1;
        transaction.decisionRecordId = ProtocolTypes.decisionRecordId(
            block.chainid,
            address(this),
            transactionId,
            transaction.termsHash,
            ProtocolTypes.Decision.ABORT,
            transaction.decisionNonce
        );
        transaction.decisionBlockNumber = block.number;

        if (transaction.paymentStatus == ProtocolTypes.PaymentStatus.LOCKED) {
            transaction.paymentStatus = ProtocolTypes.PaymentStatus.REFUNDED;
            IERC20 inputToken = IERC20(transaction.terms.paymentInputToken);
            uint256 recipientBalanceBefore = inputToken.balanceOf(transaction.terms.buyer);
            inputToken.safeTransfer(
                transaction.terms.buyer,
                transaction.terms.paymentInputAmount
            );
            uint256 amountReturned = inputToken.balanceOf(transaction.terms.buyer) - recipientBalanceBefore;
            if (amountReturned != transaction.terms.paymentInputAmount) {
                revert TokenAmountMismatch(transaction.terms.paymentInputAmount, amountReturned);
            }
            emit PaymentReleased(
                transactionId,
                transaction.termsHash,
                transaction.terms.buyer,
                transaction.terms.paymentInputAmount
            );
        }

        emit DecisionRecorded(
            transactionId,
            transaction.termsHash,
            ProtocolTypes.Decision.ABORT
        );
    }

    function getTransaction(bytes32 transactionId)
        external
        view
        returns (
            ProtocolTypes.Terms memory terms,
            bytes32 termsHash,
            ProtocolTypes.Decision decision,
            ProtocolTypes.PaymentStatus paymentStatus
        )
    {
        Transaction storage transaction = _getTransaction(transactionId);
        return (
            transaction.terms,
            transaction.termsHash,
            transaction.decision,
            transaction.paymentStatus
        );
    }

    function getDecision(bytes32 transactionId)
        external
        view
        returns (
            ProtocolTypes.Decision decision,
            bytes32 termsHash,
            uint256 sourceChainId,
            address sourceContract,
            bytes32 recordId,
            uint64 nonce,
            uint256 decisionBlockNumber
        )
    {
        Transaction storage transaction = _getTransaction(transactionId);
        return (
            transaction.decision,
            transaction.termsHash,
            block.chainid,
            address(this),
            transaction.decisionRecordId,
            transaction.decisionNonce,
            transaction.decisionBlockNumber
        );
    }

    function computeAssetObligationId(ProtocolTypes.Terms calldata terms) external pure returns (bytes32) {
        return ProtocolTypes.assetObligationId(terms);
    }

    function _validateTerms(ProtocolTypes.Terms calldata terms) private view {
        if (
            terms.transactionId == bytes32(0) ||
            terms.buyer == address(0) ||
            terms.seller == address(0) ||
            terms.buyer == terms.seller ||
            terms.paymentChainId != block.chainid ||
            terms.paymentContract != address(this) ||
            terms.paymentInputToken == address(0) ||
            terms.paymentInputAmount == 0 ||
            terms.paymentToken == address(0) ||
            terms.paymentAmount == 0 ||
            terms.assetChainId == 0 ||
            terms.assetChainId == block.chainid ||
            terms.assetSettlement == address(0) ||
            terms.assetToken == address(0) ||
            terms.assetAmount == 0 ||
            terms.expiresAt <= block.timestamp ||
            terms.schemaVersion != ProtocolTypes.CURRENT_SCHEMA_VERSION
        ) revert InvalidTerms();

        if (
            terms.paymentInputToken != terms.paymentToken ||
            terms.paymentInputAmount != terms.paymentAmount ||
            terms.amountOutMin != 0
        ) revert SwapNotEnabled();
    }

    function _validateCoordinationReport(
        Transaction storage transaction,
        ProtocolTypes.CoordinationReport memory report
    ) private view {
        ProtocolTypes.Terms storage terms = transaction.terms;
        if (
            report.termsHash != transaction.termsHash ||
            !report.paymentLocked ||
            !report.assetLocked ||
            report.paymentChainId != terms.paymentChainId ||
            report.paymentContract != address(this) ||
            report.assetChainId != terms.assetChainId ||
            report.assetSettlement != terms.assetSettlement ||
            report.buyer != terms.buyer ||
            report.seller != terms.seller ||
            report.paymentInputToken != terms.paymentInputToken ||
            report.paymentInputAmount != terms.paymentInputAmount ||
            report.paymentToken != terms.paymentToken ||
            report.paymentAmount != terms.paymentAmount ||
            report.assetToken != terms.assetToken ||
            report.assetAmount != terms.assetAmount ||
            report.expiresAt != terms.expiresAt
        ) revert InvalidCoordinationReport();
    }

    function _getTransaction(bytes32 transactionId) private view returns (Transaction storage transaction) {
        transaction = _transactions[transactionId];
        if (!transaction.exists) revert TransactionNotFound(transactionId);
    }
}
