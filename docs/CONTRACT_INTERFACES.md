# CRE and settlement contract interface draft

Status: **ready for Developer 2 review; not frozen**

This draft records the integration surface described in the protocol spec. It intentionally does not invent Solidity getters, enum ordinals, or a report ABI that the contract owner has not agreed to yet.

## Chain A lock event

Conceptual event from the protocol spec:

```solidity
event PaymentLocked(
    bytes32 indexed transactionId,
    bytes32 termsHash,
    address payer,
    uint256 amount
);
```

The event trigger must also check Ethereum Sepolia's chain ID and the configured `DecisionPaymentSettlement` emitter address. The callback decodes the transaction ID and terms hash, then rereads current contract state; the event itself is not sufficient proof that the reservation remains valid.

## Chain B lock event

Conceptual event from the protocol spec:

```solidity
event AssetLocked(
    bytes32 indexed transactionId,
    bytes32 termsHash,
    address seller,
    uint256 amount
);
```

The trigger must check Base Sepolia's chain ID and configured `AssetSettlement` emitter address, then reread both contracts. The getter must expose enough fields to verify buyer, seller, token, amount, terms hash, status, expiry, chain, and reservation contract.

## Chain A decision event

Conceptual event from the protocol spec:

```solidity
event DecisionRecorded(
    bytes32 indexed transactionId,
    bytes32 termsHash,
    Decision decision
);
```

The decision read must return the transaction and terms binding, source contract identity, decision value, and a stable record ID/nonce. The exact record reference and block/finality evidence fields remain to be agreed.

## Logical report bindings

The report payload must bind at minimum:

- `transactionId` and `termsHash`;
- decision and stable decision record reference;
- source chain ID and Chain A decision contract;
- destination chain ID and Chain B consumer;
- expected asset obligation ID;
- source decision block reference if supported by the selected report design.

For the first write spike, the Chain A consumer's report must carry the agreed transaction and terms binding needed by its contract-side precondition checks. The actual report tuple and ABI encoding are pending contract-owner review and confirmation against the official CRE receiver template for the installed SDK.

## Pending decisions

- Confirm whether the lock event signatures above become exact Solidity signatures.
- Agree getter names, returned fields, enum values, and `UNDECIDED` encoding.
- Agree decision record ID/nonce semantics.
- Agree exact report structs and destination binding.
- Confirm receiver function and Forwarder authentication against the installed SDK/template and tenant output.
- Record both chain IDs and tenant Forwarder addresses after authenticated CRE setup.
