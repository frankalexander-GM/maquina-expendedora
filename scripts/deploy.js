const hre = require("hardhat");

const CATALOG = [
  { name: "Agua mineral 600 ml", eth: "0.0012", usd: "1.20", stock: 9 },
  { name: "Cola 350 ml", eth: "0.0015", usd: "1.50", stock: 6 },
  { name: "Jugo de naranja", eth: "0.0018", usd: "1.80", stock: 4 },
  { name: "Papas fritas", eth: "0.0011", usd: "1.10", stock: 7 },
  { name: "Chocolate con leche", eth: "0.0014", usd: "1.40", stock: 5 },
  { name: "Café listo", eth: "0.0020", usd: "2.00", stock: 3 },
  { name: "Barra de granola", eth: "0.0009", usd: "0.90", stock: 8 },
  { name: "Galletas", eth: "0.0010", usd: "1.00", stock: 6 },
];

async function main() {
  const { ethers } = hre;
  const [owner] = await ethers.getSigners();
  const dispenserAddress = process.env.DISPENSER_ADDRESS ?? owner.address;
  const nativePayment = (process.env.PAYMENT ?? "eth").toLowerCase() !== "token";

  let token = null;
  let tokenAddress = ethers.ZeroAddress;

  if (!nativePayment) {
    token = await ethers.deployContract("MockUSD");
    await token.waitForDeployment();
    tokenAddress = await token.getAddress();
  }

  const machine = await ethers.deployContract("VendingMachine", [
    tokenAddress,
    owner.address,
    dispenserAddress,
  ]);
  await machine.waitForDeployment();
  const machineAddress = await machine.getAddress();

  for (const item of CATALOG) {
    const price = nativePayment ? ethers.parseEther(item.eth) : ethers.parseUnits(item.usd, 6);
    await machine.addProduct(item.name, price, item.stock);
  }

  if (token) await token.mint(owner.address, ethers.parseUnits("1000", 6));

  console.log(`Modo de pago:   ${nativePayment ? "ETH nativo" : "MockUSD (ERC20)"}`);
  console.log("VendingMachine:", machineAddress);
  console.log("Dueño:         ", owner.address);
  console.log("Dispensador:   ", dispenserAddress);
  if (token) console.log("MockUSD:       ", tokenAddress);
  console.log(`\nAbre web/index.html?machine=${machineAddress}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
