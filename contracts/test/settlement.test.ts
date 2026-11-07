import { expect } from "chai";
import { network } from "hardhat";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  AssetSettlement__factory,
  DecisionPaymentSettlement__factory,
  MockERC20__factory,
  RejectingERC20__factory,
} from "../types/ethers-contracts/index.js";
import {
  assetSettlementAbi as creAssetSettlementAbi,
  decisionPaymentSettlementAbi as creDecisionPaymentSettlementAbi,
  mockErc20Abi as creMockErc20Abi,
} from "../../raisinFi/my-workflow/contract-abis.js";
import {
  decodeAssetReservation,
  decodeChainADecision,
  decodePaymentTransaction,
} from "../../raisinFi/my-workflow/contract-codec.js";
import {
  encodeCoordinationReport as encodeCreCoordinationReport,
  encodeDecisionRelayReport as encodeCreDecisionRelayReport,
  type CoordinationReport as CreCoordinationReport,
  type DecisionRelayReport as CreDecisionRelayReport,
} from "../../raisinFi/my-workflow/report-encoding.js";

const readArtifactAbi = (path: string) =>
  JSON.parse(readFileSync(resolve(process.cwd(), path), "utf8")).abi;

async function deployFixture() {
  const paymentNetwork = await network.create({ network: "hardhatSepolia" });
  const assetNetwork = await network.create({ network: "hardhatBase" });
  const paymentEthers = paymentNetwork.ethers;
  const assetEthers = assetNetwork.ethers;
  const [buyer, seller, forwarder, attacker] = await paymentEthers.getSigners();
  const assetBuyer = await assetEthers.getSigner(buyer.address);
  const assetSeller = await assetEthers.getSigner(seller.address);
  const assetForwarder = await assetEthers.getSigner(forwarder.address);
  const assetAttacker = await assetEthers.getSigner(attacker.address);

  const paymentToken = await new MockERC20__factory(buyer).deploy(
    "Test Dollar",
    "TUSD",
    buyer.address,
    100_000n,
  );
  const assetToken = await new MockERC20__factory(assetSeller).deploy(
    "Test Asset",
    "TAST",
    seller.address,
    100_000n,
  );
  const payment = await new DecisionPaymentSettlement__factory(buyer).deploy(forwarder.address);
  const asset = await new AssetSettlement__factory(assetBuyer).deploy(
    forwarder.address,
    11155111n,
    payment.target,
  );

  const latestBlock = await paymentEthers.provider.getBlock("latest");
  if (!latestBlock) throw new Error("Could not read the payment-chain timestamp");

  const transactionId = paymentEthers.id(`transaction-${latestBlock.number}-${payment.target}`);
  const terms = {
    transactionId,
    buyer: buyer.address,
    seller: seller.address,
    paymentChainId: 11155111n,
    paymentContract: payment.target,
    paymentInputToken: paymentToken.target,
    paymentInputAmount: 1_000n,
    paymentToken: paymentToken.target,
    paymentAmount: 1_000n,
    amountOutMin: 0n,
    assetChainId: 84532n,
    assetSettlement: asset.target,
    assetToken: assetToken.target,
    assetAmount: 100n,
    expiresAt: BigInt(latestBlock.timestamp + 300),
    schemaVersion: 1,
  };
  const termsHash = await payment.computeTermsHash(terms);

  return {
    paymentNetwork,
    assetNetwork,
    paymentEthers,
    assetEthers,
    buyer,
    seller,
    forwarder,
    attacker,
    assetBuyer,
    assetSeller,
    assetForwarder,
    assetAttacker,
    paymentToken,
    assetToken,
    payment,
    asset,
    terms,
    termsHash,
    transactionId,
  };
}

async function registerAndLockPayment(fixture: Awaited<ReturnType<typeof deployFixture>>) {
  const { payment, paymentToken, buyer, terms, termsHash } = fixture;
  await payment.connect(buyer).registerTransaction(terms);
  await paymentToken.connect(buyer).approve(payment.target, terms.paymentInputAmount);
  await payment.connect(buyer).lockPayment(terms.transactionId, termsHash);
}

async function lockBothSides(fixture: Awaited<ReturnType<typeof deployFixture>>) {
  await registerAndLockPayment(fixture);
  const { asset, assetToken, assetSeller, terms, termsHash } = fixture;
  await assetToken.connect(assetSeller).approve(asset.target, terms.assetAmount);
  await asset.connect(assetSeller).lockAsset(terms, termsHash);
}

function coordinationReport(
  fixture: Awaited<ReturnType<typeof deployFixture>>,
  overrides: Record<string, unknown> = {},
) {
  const { terms, termsHash } = fixture;
  return {
    transactionId: terms.transactionId,
    termsHash,
    paymentChainId: terms.paymentChainId,
    paymentContract: terms.paymentContract,
    assetChainId: terms.assetChainId,
    assetSettlement: terms.assetSettlement,
    buyer: terms.buyer,
    seller: terms.seller,
    paymentInputToken: terms.paymentInputToken,
    paymentInputAmount: terms.paymentInputAmount,
    paymentToken: terms.paymentToken,
    paymentAmount: terms.paymentAmount,
    assetToken: terms.assetToken,
    assetAmount: terms.assetAmount,
    expiresAt: terms.expiresAt,
    paymentLocked: true,
    assetLocked: true,
    ...overrides,
  };
}

function encodeCoordinationReport(
  fixture: Awaited<ReturnType<typeof deployFixture>>,
  overrides: Record<string, unknown> = {},
) {
  return encodeCreCoordinationReport(
    coordinationReport(fixture, overrides) as CreCoordinationReport,
  );
}

async function encodeDecisionRelayReport(
  fixture: Awaited<ReturnType<typeof deployFixture>>,
  decision: 1 | 2,
  overrides: Record<string, unknown> = {},
) {
  const decisionState = await fixture.payment.getDecision(fixture.transactionId);
  const report = {
    transactionId: fixture.transactionId,
    termsHash: fixture.termsHash,
    decision,
    sourceChainId: 11155111n,
    sourceContract: fixture.payment.target,
    destinationChainId: 84532n,
    destinationContract: fixture.asset.target,
    assetObligationId: await fixture.asset.computeAssetObligationId(fixture.terms),
    decisionRecordId: decisionState.recordId,
    decisionNonce: decisionState.nonce,
    sourceDecisionBlockNumber: decisionState.decisionBlockNumber,
    buyer: fixture.terms.buyer,
    seller: fixture.terms.seller,
    assetToken: fixture.terms.assetToken,
    assetAmount: fixture.terms.assetAmount,
    expiresAt: fixture.terms.expiresAt,
    ...overrides,
  };
  return encodeCreDecisionRelayReport(report as CreDecisionRelayReport);
}

async function expirePaymentTransaction(fixture: Awaited<ReturnType<typeof deployFixture>>) {
  const latest = await fixture.paymentEthers.provider.getBlock("latest");
  if (!latest) throw new Error("Could not read the payment-chain timestamp");
  const remaining = Number(fixture.terms.expiresAt) - latest.timestamp;
  if (remaining > 0) {
    await fixture.paymentEthers.provider.send("evm_setNextBlockTimestamp", [
      Number(fixture.terms.expiresAt) + 1,
    ]);
    await fixture.paymentEthers.provider.send("evm_mine", []);
  }
}

async function expireAssetReservation(fixture: Awaited<ReturnType<typeof deployFixture>>) {
  const latest = await fixture.assetEthers.provider.getBlock("latest");
  if (!latest) throw new Error("Could not read the asset-chain timestamp");
  const remaining = Number(fixture.terms.expiresAt) - latest.timestamp;
  if (remaining > 0) {
    await fixture.assetEthers.provider.send("evm_setNextBlockTimestamp", [
      Number(fixture.terms.expiresAt) + 1,
    ]);
    await fixture.assetEthers.provider.send("evm_mine", []);
  }
}

describe("DecisionPaymentSettlement and AssetSettlement", function () {
  it("uses CRE ABIs generated from the compiled settlement artifacts", async function () {
    expect(creDecisionPaymentSettlementAbi).to.deep.equal(
      readArtifactAbi("artifacts/src/DecisionPaymentSettlement.sol/DecisionPaymentSettlement.json"),
    );
    expect(creAssetSettlementAbi).to.deep.equal(
      readArtifactAbi("artifacts/src/AssetSettlement.sol/AssetSettlement.json"),
    );
    expect(creMockErc20Abi).to.deep.equal(
      readArtifactAbi("artifacts/src/test/MockERC20.sol/MockERC20.json"),
    );
  });

  it("decodes the implemented reservation and decision getter results", async function () {
    const f = await deployFixture();
    await lockBothSides(f);

    const paymentState = await f.payment.getTransaction(f.transactionId);
    const paymentReturnData = f.payment.interface.encodeFunctionResult("getTransaction", [
      paymentState.terms,
      paymentState.termsHash,
      paymentState.decision,
      paymentState.paymentStatus,
    ]);
    const decodedPayment = decodePaymentTransaction(paymentReturnData as `0x${string}`);
    expect(decodedPayment.terms.transactionId).to.equal(f.transactionId);
    expect(decodedPayment.terms.paymentInputAmount).to.equal(f.terms.paymentInputAmount);
    expect(decodedPayment.termsHash).to.equal(f.termsHash);
    expect(decodedPayment.decision).to.equal(0);
    expect(decodedPayment.paymentStatus).to.equal(1);

    const assetState = await f.asset.getAssetReservation(f.transactionId);
    const assetReturnData = f.asset.interface.encodeFunctionResult("getAssetReservation", [
      assetState.terms,
      assetState.termsHash,
      assetState.status,
      assetState.decision,
      assetState.decisionRecordId,
      assetState.decisionNonce,
    ]);
    const decodedAsset = decodeAssetReservation(assetReturnData as `0x${string}`);
    expect(decodedAsset.terms.transactionId).to.equal(f.transactionId);
    expect(decodedAsset.terms.assetAmount).to.equal(f.terms.assetAmount);
    expect(decodedAsset.termsHash).to.equal(f.termsHash);
    expect(decodedAsset.status).to.equal(1);
    expect(decodedAsset.decision).to.equal(0);

    await f.payment.connect(f.forwarder).onReport("0x", encodeCoordinationReport(f));
    const decisionState = await f.payment.getDecision(f.transactionId);
    const decisionReturnData = f.payment.interface.encodeFunctionResult("getDecision", [
      decisionState.decision,
      decisionState.termsHash,
      decisionState.sourceChainId,
      decisionState.sourceContract,
      decisionState.recordId,
      decisionState.nonce,
      decisionState.decisionBlockNumber,
    ]);
    const decodedDecision = decodeChainADecision(
      decisionReturnData as `0x${string}`,
      f.transactionId as `0x${string}`,
    );
    expect(decodedDecision.transactionId).to.equal(f.transactionId);
    expect(decodedDecision.decision).to.equal(1);
    expect(decodedDecision.termsHash).to.equal(f.termsHash);
    expect(decodedDecision.recordId).to.equal(decisionState.recordId);
    expect(decodedDecision.nonce).to.equal(1n);
    expect(decodedDecision.decisionBlockNumber).to.equal(decisionState.decisionBlockNumber);
  });

  it("uses the same canonical terms hash on both chains and requires participant locks", async function () {
    const f = await deployFixture();

    expect(await f.asset.computeTermsHash(f.terms)).to.equal(f.termsHash);
    await lockBothSides(f);

    const paymentState = await f.payment.getTransaction(f.transactionId);
    const assetState = await f.asset.getAssetReservation(f.transactionId);
    expect(paymentState.termsHash).to.equal(f.termsHash);
    expect(paymentState.paymentStatus).to.equal(1n);
    expect(assetState.termsHash).to.equal(f.termsHash);
    expect(assetState.status).to.equal(1n);
  });

  it("rejects a payment registration or lock from a non-buyer", async function () {
    const f = await deployFixture();

    await expect(f.payment.connect(f.attacker).registerTransaction(f.terms))
      .to.be.revertedWithCustomError(f.payment, "UnauthorizedBuyer");
    await f.payment.connect(f.buyer).registerTransaction(f.terms);
    await expect(f.payment.connect(f.attacker).lockPayment(f.transactionId, f.termsHash))
      .to.be.revertedWithCustomError(f.payment, "UnauthorizedBuyer");
  });

  it("rejects a wrong terms hash and duplicate participant locks", async function () {
    const f = await deployFixture();
    await f.payment.connect(f.buyer).registerTransaction(f.terms);
    await f.paymentToken.connect(f.buyer).approve(f.payment.target, f.terms.paymentInputAmount);

    await expect(f.payment.connect(f.buyer).lockPayment(f.transactionId, f.paymentEthers.ZeroHash))
      .to.be.revertedWithCustomError(f.payment, "InvalidTermsHash");
    await f.payment.connect(f.buyer).lockPayment(f.transactionId, f.termsHash);
    await expect(f.payment.connect(f.buyer).lockPayment(f.transactionId, f.termsHash))
      .to.be.revertedWithCustomError(f.payment, "PaymentAlreadyLocked");

    await f.assetToken.connect(f.assetSeller).approve(f.asset.target, f.terms.assetAmount);
    await f.asset.connect(f.assetSeller).lockAsset(f.terms, f.termsHash);
    await expect(f.asset.connect(f.assetSeller).lockAsset(f.terms, f.termsHash))
      .to.be.revertedWithCustomError(f.asset, "TransactionAlreadyLocked");
  });

  it("rejects a lock submitted by anyone other than the seller", async function () {
    const f = await deployFixture();

    await expect(f.asset.connect(f.assetBuyer).lockAsset(f.terms, f.termsHash))
      .to.be.revertedWithCustomError(f.asset, "UnauthorizedSeller");
  });

  it("requires the configured CRE Forwarder and matching reservations to commit", async function () {
    const f = await deployFixture();
    await lockBothSides(f);
    const report = encodeCoordinationReport(f);

    await expect(f.payment.connect(f.attacker).onReport("0x", report))
      .to.be.revertedWithCustomError(f.payment, "UnauthorizedForwarder");
    await expect(
      f.payment.connect(f.forwarder).onReport("0x", encodeCoordinationReport(f, { assetAmount: 101n })),
    ).to.be.revertedWithCustomError(f.payment, "InvalidCoordinationReport");
  });

  it("decodes the CRE COMMIT report, pays, then delivers the asset once on the other chain", async function () {
    const f = await deployFixture();
    await lockBothSides(f);

    const sellerPaymentBefore = await f.paymentToken.balanceOf(f.seller.address);
    await expect(
      f.payment.connect(f.forwarder).onReport("0x", encodeCoordinationReport(f)),
    )
      .to.emit(f.payment, "DecisionRecorded")
      .withArgs(f.transactionId, f.termsHash, 1n);
    expect(await f.paymentToken.balanceOf(f.seller.address)).to.equal(
      sellerPaymentBefore + f.terms.paymentAmount,
    );

    const decisionState = await f.payment.getDecision(f.transactionId);
    expect(decisionState.decision).to.equal(1n);
    expect(decisionState.recordId).not.to.equal(f.paymentEthers.ZeroHash);

    const buyerAssetBefore = await f.assetToken.balanceOf(f.buyer.address);
    const relay = await encodeDecisionRelayReport(f, 1);
    await expect(f.asset.connect(f.assetForwarder).onReport("0x", relay))
      .to.emit(f.asset, "AssetDelivered")
      .withArgs(f.transactionId, f.termsHash, f.buyer.address, f.terms.assetAmount);
    expect(await f.assetToken.balanceOf(f.buyer.address)).to.equal(
      buyerAssetBefore + f.terms.assetAmount,
    );

    await expect(f.asset.connect(f.assetForwarder).onReport("0x", relay))
      .to.be.revertedWithCustomError(f.asset, "DecisionAlreadyProcessed");
    expect(await f.assetToken.balanceOf(f.buyer.address)).to.equal(
      buyerAssetBefore + f.terms.assetAmount,
    );
  });

  it("leaves the Chain A decision undecided when payment execution reverts", async function () {
    const f = await deployFixture();
    const rejectingToken = await new RejectingERC20__factory(f.buyer).deploy(
      f.buyer.address,
      100_000n,
    );
    f.terms.paymentInputToken = rejectingToken.target;
    f.terms.paymentToken = rejectingToken.target;
    f.termsHash = await f.payment.computeTermsHash(f.terms);

    await f.payment.connect(f.buyer).registerTransaction(f.terms);
    await rejectingToken.connect(f.buyer).approve(f.payment.target, f.terms.paymentInputAmount);
    await f.payment.connect(f.buyer).lockPayment(f.transactionId, f.termsHash);
    await rejectingToken.setBlockedRecipient(f.seller.address);

    await expect(
      f.payment.connect(f.forwarder).onReport("0x", encodeCoordinationReport(f)),
    ).to.be.revertedWithCustomError(rejectingToken, "RecipientBlocked");
    const transaction = await f.payment.getTransaction(f.transactionId);
    expect(transaction.decision).to.equal(0n);
    expect(transaction.paymentStatus).to.equal(1n);
  });

  it("allows anyone to abort after expiry and refunds a locked payment once", async function () {
    const f = await deployFixture();
    await registerAndLockPayment(f);
    await expirePaymentTransaction(f);

    const buyerBeforeAbort = await f.paymentToken.balanceOf(f.buyer.address);
    await expect(f.payment.connect(f.attacker).abort(f.transactionId))
      .to.emit(f.payment, "DecisionRecorded")
      .withArgs(f.transactionId, f.termsHash, 2n);

    const transaction = await f.payment.getTransaction(f.transactionId);
    expect(transaction.decision).to.equal(2n);
    expect(transaction.paymentStatus).to.equal(3n);
    expect(await f.paymentToken.balanceOf(f.buyer.address)).to.equal(
      buyerBeforeAbort + f.terms.paymentInputAmount,
    );
    await expect(f.payment.connect(f.attacker).abort(f.transactionId))
      .to.be.revertedWithCustomError(f.payment, "DecisionAlreadyRecorded");
  });

  it("can record an expiry abort even if Alice never locked payment", async function () {
    const f = await deployFixture();
    await f.payment.connect(f.buyer).registerTransaction(f.terms);
    await expirePaymentTransaction(f);

    await f.payment.connect(f.attacker).abort(f.transactionId);
    const transaction = await f.payment.getTransaction(f.transactionId);
    expect(transaction.decision).to.equal(2n);
    expect(transaction.paymentStatus).to.equal(0n);
  });

  it("rejects abort before expiry and rejects committing after expiry", async function () {
    const f = await deployFixture();
    await lockBothSides(f);

    await expect(f.payment.connect(f.attacker).abort(f.transactionId))
      .to.be.revertedWithCustomError(f.payment, "TransactionNotExpired");
    await expirePaymentTransaction(f);
    await expect(f.payment.connect(f.forwarder).onReport("0x", encodeCoordinationReport(f)))
      .to.be.revertedWithCustomError(f.payment, "TransactionExpired");
    expect((await f.payment.getDecision(f.transactionId)).decision).to.equal(0n);
  });

  it("rejects unauthenticated, misbound and duplicate Chain B decision reports", async function () {
    const f = await deployFixture();
    await lockBothSides(f);
    await f.payment.connect(f.forwarder).onReport("0x", encodeCoordinationReport(f));

    const wrongSource = await encodeDecisionRelayReport(f, 1, { sourceChainId: 1n });
    await expect(f.asset.connect(f.assetForwarder).onReport("0x", wrongSource))
      .to.be.revertedWithCustomError(f.asset, "InvalidDecisionReport");
    const wrongDestination = await encodeDecisionRelayReport(f, 1, {
      destinationContract: f.paymentEthers.ZeroAddress,
    });
    await expect(f.asset.connect(f.assetForwarder).onReport("0x", wrongDestination))
      .to.be.revertedWithCustomError(f.asset, "InvalidDecisionReport");
    const validReport = await encodeDecisionRelayReport(f, 1);
    await expect(f.asset.connect(f.assetAttacker).onReport("0x", validReport))
      .to.be.revertedWithCustomError(f.asset, "UnauthorizedForwarder");
    await f.asset.connect(f.assetForwarder).onReport("0x", validReport);
    await expect(f.asset.connect(f.assetForwarder).onReport("0x", validReport))
      .to.be.revertedWithCustomError(f.asset, "DecisionAlreadyProcessed");
  });

  it("never releases Bob's asset from local expiry alone", async function () {
    const f = await deployFixture();
    await f.assetToken.connect(f.assetSeller).approve(f.asset.target, f.terms.assetAmount);
    await f.asset.connect(f.assetSeller).lockAsset(f.terms, f.termsHash);
    await expireAssetReservation(f);

    const sellerBalance = await f.assetToken.balanceOf(f.seller.address);
    const reservation = await f.asset.getAssetReservation(f.transactionId);
    expect(reservation.status).to.equal(1n);
    expect(await f.assetToken.balanceOf(f.seller.address)).to.equal(
      sellerBalance,
    );
  });

  it("decodes the CRE ABORT report and releases Bob's asset exactly once", async function () {
    const f = await deployFixture();
    await f.payment.connect(f.buyer).registerTransaction(f.terms);
    await f.assetToken.connect(f.assetSeller).approve(f.asset.target, f.terms.assetAmount);
    await f.asset.connect(f.assetSeller).lockAsset(f.terms, f.termsHash);
    await expirePaymentTransaction(f);
    await f.payment.connect(f.attacker).abort(f.transactionId);

    const sellerBeforeRelease = await f.assetToken.balanceOf(f.seller.address);
    const relay = await encodeDecisionRelayReport(f, 2);
    await expect(f.asset.connect(f.assetForwarder).onReport("0x", relay))
      .to.emit(f.asset, "AssetReleased")
      .withArgs(f.transactionId, f.termsHash, f.seller.address, f.terms.assetAmount);
    expect(await f.assetToken.balanceOf(f.seller.address)).to.equal(
      sellerBeforeRelease + f.terms.assetAmount,
    );
    await expect(f.asset.connect(f.assetForwarder).onReport("0x", relay))
      .to.be.revertedWithCustomError(f.asset, "DecisionAlreadyProcessed");
  });
});
