// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

library ProtocolTypes {
    uint32 internal constant CURRENT_SCHEMA_VERSION = 1;

    bytes32 internal constant TERMS_TYPEHASH = keccak256(
        "RaisinFiTerms(bytes32 transactionId,address buyer,address seller,uint256 paymentChainId,address paymentContract,address paymentInputToken,uint256 paymentInputAmount,address paymentToken,uint256 paymentAmount,uint256 amountOutMin,uint256 assetChainId,address assetSettlement,address assetToken,uint256 assetAmount,uint256 expiresAt,uint32 schemaVersion)"
    );
    bytes32 internal constant DECISION_RECORD_TYPEHASH = keccak256(
        "RaisinFiDecision(uint256 sourceChainId,address sourceContract,bytes32 transactionId,bytes32 termsHash,uint8 decision,uint64 nonce)"
    );
    bytes32 internal constant ASSET_OBLIGATION_TYPEHASH = keccak256(
        "RaisinFiAssetObligation(bytes32 transactionId,bytes32 termsHash,uint256 assetChainId,address assetSettlement,address buyer,address seller,address assetToken,uint256 assetAmount)"
    );

    enum Decision {
        UNDECIDED,
        COMMIT,
        ABORT
    }

    enum PaymentStatus {
        NONE,
        LOCKED,
        PAID,
        REFUNDED
    }

    enum AssetStatus {
        NONE,
        LOCKED,
        DELIVERED,
        RELEASED
    }

    struct Terms {
        bytes32 transactionId;
        address buyer;
        address seller;
        uint256 paymentChainId;
        address paymentContract;
        address paymentInputToken;
        uint256 paymentInputAmount;
        address paymentToken;
        uint256 paymentAmount;
        uint256 amountOutMin;
        uint256 assetChainId;
        address assetSettlement;
        address assetToken;
        uint256 assetAmount;
        uint256 expiresAt;
        uint32 schemaVersion;
    }

    struct CoordinationReport {
        bytes32 transactionId;
        bytes32 termsHash;
        uint256 paymentChainId;
        address paymentContract;
        uint256 assetChainId;
        address assetSettlement;
        address buyer;
        address seller;
        address paymentInputToken;
        uint256 paymentInputAmount;
        address paymentToken;
        uint256 paymentAmount;
        address assetToken;
        uint256 assetAmount;
        uint256 expiresAt;
        bool paymentLocked;
        bool assetLocked;
    }

    struct DecisionRelayReport {
        bytes32 transactionId;
        bytes32 termsHash;
        Decision decision;
        uint256 sourceChainId;
        address sourceContract;
        uint256 destinationChainId;
        address destinationContract;
        bytes32 assetObligationId;
        bytes32 decisionRecordId;
        uint64 decisionNonce;
        uint256 sourceDecisionBlockNumber;
        address buyer;
        address seller;
        address assetToken;
        uint256 assetAmount;
        uint256 expiresAt;
    }

    function hashTerms(Terms memory terms) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                TERMS_TYPEHASH,
                terms.transactionId,
                terms.buyer,
                terms.seller,
                terms.paymentChainId,
                terms.paymentContract,
                terms.paymentInputToken,
                terms.paymentInputAmount,
                terms.paymentToken,
                terms.paymentAmount,
                terms.amountOutMin,
                terms.assetChainId,
                terms.assetSettlement,
                terms.assetToken,
                terms.assetAmount,
                terms.expiresAt,
                terms.schemaVersion
            )
        );
    }

    function decisionRecordId(
        uint256 sourceChainId,
        address sourceContract,
        bytes32 transactionId,
        bytes32 termsHash,
        Decision decision,
        uint64 nonce
    ) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                DECISION_RECORD_TYPEHASH,
                sourceChainId,
                sourceContract,
                transactionId,
                termsHash,
                uint8(decision),
                nonce
            )
        );
    }

    function assetObligationId(Terms memory terms) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                ASSET_OBLIGATION_TYPEHASH,
                terms.transactionId,
                hashTerms(terms),
                terms.assetChainId,
                terms.assetSettlement,
                terms.buyer,
                terms.seller,
                terms.assetToken,
                terms.assetAmount
            )
        );
    }
}
