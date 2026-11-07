import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const outputPath = resolve("../apps/web/src/generated/contract-abis.ts");
const workflowOutputPath = resolve("../raisinFi/my-workflow/contract-abis.ts");
const artifacts = [
  ["decisionPaymentSettlementAbi", "DecisionPaymentSettlement", "src/DecisionPaymentSettlement.sol"],
  ["assetSettlementAbi", "AssetSettlement", "src/AssetSettlement.sol"],
  ["mockErc20Abi", "MockERC20", "src/test/MockERC20.sol"],
];

const exported = [];
for (const [exportName, contractName, sourcePath] of artifacts) {
  const artifactPath = resolve("artifacts", sourcePath, `${contractName}.json`);
  const artifact = JSON.parse(await readFile(artifactPath, "utf8"));
  exported.push(`export const ${exportName} = ${JSON.stringify(artifact.abi)} as const;`);
}

await mkdir(resolve(outputPath, ".."), { recursive: true });
await writeFile(outputPath, `${exported.join("\n\n")}\n`);
console.log(`Exported contract ABIs to ${outputPath}`);

await mkdir(resolve(workflowOutputPath, ".."), { recursive: true });
await writeFile(workflowOutputPath, `${exported.join("\n\n")}\n`);
console.log(`Exported contract ABIs to ${workflowOutputPath}`);
