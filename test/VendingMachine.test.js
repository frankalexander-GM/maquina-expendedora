const assert = require("node:assert/strict");
const hre = require("hardhat");

const { ethers, network } = hre;

const usd = (value) => ethers.parseUnits(value, 6);

async function expectRevert(promise, name) {
  try {
    await promise;
  } catch (error) {
    const actual = error.revert?.name ?? error.shortMessage ?? error.message;
    assert.ok(String(actual).includes(name), `se esperaba "${name}", se obtuvo "${actual}"`);
    return;
  }
  assert.fail(`se esperaba el revert "${name}"`);
}

async function advance(seconds) {
  await network.provider.send("evm_increaseTime", [seconds]);
  await network.provider.send("evm_mine");
}

describe("VendingMachine", function () {
  let token;
  let machine;
  let tokenAddress;
  let machineAddress;
  let owner;
  let dispenser;
  let buyer;
  let stranger;

  beforeEach(async function () {
    [owner, dispenser, buyer, stranger] = await ethers.getSigners();

    token = await ethers.deployContract("MockUSD");
    await token.waitForDeployment();
    tokenAddress = await token.getAddress();

    machine = await ethers.deployContract("VendingMachine", [tokenAddress, owner.address, dispenser.address]);
    await machine.waitForDeployment();
    machineAddress = await machine.getAddress();

    await token.mint(buyer.address, usd("100"));
    await token.connect(buyer).approve(machineAddress, ethers.MaxUint256);
    await machine.addProduct("Cola 350ml", usd("1.5"), 10);
  });

  it("registra productos y los publica en el catálogo", async function () {
    await machine.addProduct("Agua 600ml", usd("1.2"), 8);

    assert.equal(await machine.productCount(), 2n);

    const catalog = await machine.catalog();
    assert.equal(catalog.length, 2);
    assert.equal(catalog[0].name, "Cola 350ml");
    assert.equal(catalog[1].name, "Agua 600ml");
    assert.equal(catalog[1].price, usd("1.2"));
    assert.equal(catalog[1].stock, 8n);
    assert.equal(catalog[1].active, true);
  });

  it("cobra el pago y reserva el stock al comprar", async function () {
    await machine.connect(buyer).buy(1, 2);

    const order = await machine.orders(1);
    assert.equal(order.buyer, buyer.address);
    assert.equal(order.productId, 1n);
    assert.equal(order.quantity, 2n);
    assert.equal(order.amount, usd("3"));
    assert.equal(order.state, 0n);
    assert.ok(order.deadline > 0n);

    assert.equal(await token.balanceOf(machineAddress), usd("3"));
    assert.equal((await machine.products(1)).stock, 8n);
    assert.equal(await machine.orderCount(), 1n);
  });

  it("libera la recaudación cuando el dispensador confirma la entrega", async function () {
    await machine.connect(buyer).buy(1, 2);
    await machine.connect(dispenser).confirmDispense(1);

    assert.equal((await machine.orders(1)).state, 1n);
    assert.equal(await machine.withdrawable(owner.address), usd("3"));

    await machine.connect(owner).withdraw(owner.address);
    assert.equal(await token.balanceOf(owner.address), usd("3"));
    assert.equal(await machine.withdrawable(owner.address), 0n);
    await expectRevert(machine.connect(owner).withdraw(owner.address), "NothingToWithdraw");
  });

  it("no permite confirmar dos veces la misma orden", async function () {
    await machine.connect(buyer).buy(1, 1);
    await machine.connect(dispenser).confirmDispense(1);
    await expectRevert(machine.connect(dispenser).confirmDispense(1), "OrderNotPending");
  });

  it("devuelve el dinero y el stock si nadie dispensa antes del plazo", async function () {
    await machine.connect(buyer).buy(1, 3);
    assert.equal(await token.balanceOf(buyer.address), usd("95.5"));

    await expectRevert(machine.connect(buyer).refund(1), "OrderNotExpired");
    await advance(301);
    await machine.connect(buyer).refund(1);

    assert.equal((await machine.orders(1)).state, 2n);
    assert.equal(await token.balanceOf(buyer.address), usd("100"));
    assert.equal((await machine.products(1)).stock, 10n);
  });

  it("solo el comprador puede reclamar el reembolso", async function () {
    await machine.connect(buyer).buy(1, 1);
    await advance(301);
    await expectRevert(machine.connect(stranger).refund(1), "NotBuyer");
  });

  it("permite al operador cancelar y reembolsar de inmediato", async function () {
    await machine.connect(buyer).buy(1, 2);
    await machine.connect(dispenser).cancelOrder(1);

    assert.equal((await machine.orders(1)).state, 2n);
    assert.equal(await token.balanceOf(buyer.address), usd("100"));
    assert.equal((await machine.products(1)).stock, 10n);
  });

  it("restringe la confirmación al dispensador o al dueño", async function () {
    await machine.connect(buyer).buy(1, 1);
    await expectRevert(machine.connect(stranger).confirmDispense(1), "NotDispenser");
    await expectRevert(machine.connect(buyer).cancelOrder(1), "NotDispenser");
    await machine.connect(owner).confirmDispense(1);
  });

  it("valida cantidades, stock y producto inexistente", async function () {
    await expectRevert(machine.connect(buyer).buy(1, 0), "InvalidQuantity");
    await expectRevert(machine.connect(buyer).buy(1, 11), "InvalidQuantity");
    await expectRevert(machine.connect(buyer).buy(9, 1), "UnknownProduct");
    await machine.connect(buyer).buy(1, 10);
    await expectRevert(machine.connect(buyer).buy(1, 1), "OutOfStock");
  });

  it("rechaza el pago si el comprador no aprobó el token", async function () {
    const broke = stranger;
    await token.mint(broke.address, usd("10"));
    await expectRevert(machine.connect(broke).buy(1, 1), "TransferFailed");
  });

  it("rechaza ETH cuando la máquina cobra en token", async function () {
    await expectRevert(machine.connect(buyer).buy(1, 1, { value: 1n }), "WrongPayment");
  });

  it("la pausa frena las ventas pero nunca los reembolsos", async function () {
    await machine.connect(buyer).buy(1, 1);
    await machine.connect(owner).setPaused(true);

    await expectRevert(machine.connect(buyer).buy(1, 1), "MachinePaused");

    await advance(301);
    await machine.connect(buyer).refund(1);
    assert.equal(await token.balanceOf(buyer.address), usd("100"));
  });

  it("rechaza productos inactivos y precios en cero", async function () {
    await expectRevert(machine.addProduct("Gratis", 0, 5), "ZeroPrice");
    await machine.configureProduct(1, usd("1.5"), false);
    await expectRevert(machine.connect(buyer).buy(1, 1), "ProductInactive");
    await expectRevert(machine.configureProduct(1, 0, true), "ZeroPrice");
  });

  it("cambia la propiedad en dos pasos", async function () {
    await machine.transferOwnership(stranger.address);
    assert.equal(await machine.owner(), owner.address);
    await expectRevert(machine.connect(owner).acceptOwnership(), "NotPendingOwner");
    await machine.connect(stranger).acceptOwnership();
    assert.equal(await machine.owner(), stranger.address);
    assert.equal(await machine.pendingOwner(), ethers.ZeroAddress);
  });
});

describe("VendingMachine con pago en ETH", function () {
  const price = ethers.parseEther("0.0012");

  let machine;
  let machineAddress;
  let owner;
  let dispenser;
  let buyer;
  let other;

  beforeEach(async function () {
    [owner, dispenser, buyer, other] = await ethers.getSigners();
    machine = await ethers.deployContract("VendingMachine", [ethers.ZeroAddress, owner.address, dispenser.address]);
    await machine.waitForDeployment();
    machineAddress = await machine.getAddress();
    await machine.addProduct("Agua mineral 600 ml", price, 10);
  });

  it("cobra en ETH y reserva el stock", async function () {
    await machine.connect(buyer).buy(1, 2, { value: price * 2n });

    const order = await machine.orders(1);
    assert.equal(order.amount, price * 2n);
    assert.equal(order.state, 0n);
    assert.equal(await ethers.provider.getBalance(machineAddress), price * 2n);
    assert.equal((await machine.products(1)).stock, 8n);
  });

  it("exige el importe exacto", async function () {
    await expectRevert(machine.connect(buyer).buy(1, 1, { value: price - 1n }), "WrongPayment");
    await expectRevert(machine.connect(buyer).buy(1, 1, { value: price + 1n }), "WrongPayment");
    await expectRevert(machine.connect(buyer).buy(1, 1), "WrongPayment");
  });

  it("no acepta ETH fuera de una compra", async function () {
    let reverted = false;
    try {
      await buyer.sendTransaction({ to: machineAddress, value: price });
    } catch {
      reverted = true;
    }
    assert.equal(reverted, true);
    assert.equal(await ethers.provider.getBalance(machineAddress), 0n);
  });

  it("acredita la recaudación y la retira en ETH", async function () {
    await machine.connect(buyer).buy(1, 1, { value: price });
    await machine.connect(dispenser).confirmDispense(1);
    assert.equal(await machine.withdrawable(owner.address), price);

    const before = await ethers.provider.getBalance(other.address);
    await machine.connect(owner).withdraw(other.address);
    assert.equal(await ethers.provider.getBalance(other.address), before + price);
  });

  it("devuelve el importe en ETH tras la ventana", async function () {
    await machine.connect(buyer).buy(1, 1, { value: price });
    const before = await ethers.provider.getBalance(buyer.address);

    await advance(301);
    const receipt = await (await machine.connect(buyer).refund(1)).wait();
    const gasCost = receipt.gasUsed * receipt.gasPrice;
    const after = await ethers.provider.getBalance(buyer.address);

    assert.equal(after + gasCost, before + price);
    assert.equal(await ethers.provider.getBalance(machineAddress), 0n);
    assert.equal((await machine.products(1)).stock, 10n);
  });
});

describe("Ajustes del operador", function () {
  let token;
  let machine;
  let machineAddress;
  let owner;
  let buyer;
  let stranger;

  beforeEach(async function () {
    [owner, buyer, stranger] = await ethers.getSigners();
    token = await ethers.deployContract("MockUSD");
    machine = await ethers.deployContract("VendingMachine", [
      await token.getAddress(),
      owner.address,
      owner.address,
    ]);
    machineAddress = await machine.getAddress();
    await machine.addProduct("Cola 350 ml", usd("1.5"), 10);

    await token.mint(buyer.address, usd("100"));
    await token.connect(buyer).approve(machineAddress, ethers.MaxUint256);
  });

  it("cambia el nombre de un producto", async function () {
    await machine.setProductName(1, "Cola zero 350 ml");
    assert.equal((await machine.products(1)).name, "Cola zero 350 ml");

    await expectRevert(machine.setProductName(1, ""), "InvalidName");
    await expectRevert(machine.setProductName(1, "x".repeat(65)), "InvalidName");
    await expectRevert(machine.connect(stranger).setProductName(1, "Otra"), "NotOwner");
  });

  it("fija el stock a un valor absoluto", async function () {
    await machine.setStock(1, 3);
    assert.equal((await machine.products(1)).stock, 3n);

    await expectRevert(machine.connect(buyer).buy(1, 4), "OutOfStock");
    await machine.connect(buyer).buy(1, 3);
    assert.equal((await machine.products(1)).stock, 0n);

    await expectRevert(machine.connect(stranger).setStock(1, 10), "NotOwner");
  });

  it("cambia el máximo de unidades por compra", async function () {
    assert.equal(await machine.maxQuantity(), 10n);

    await machine.setMaxQuantity(3);
    assert.equal(await machine.maxQuantity(), 3n);
    await expectRevert(machine.connect(buyer).buy(1, 4), "InvalidQuantity");
    await machine.connect(buyer).buy(1, 3);

    await expectRevert(machine.setMaxQuantity(0), "InvalidQuantity");
    await expectRevert(machine.setMaxQuantity(51), "InvalidQuantity");
    await expectRevert(machine.connect(stranger).setMaxQuantity(5), "NotOwner");
  });

  it("permite desactivar un producto sin borrarlo", async function () {
    await machine.configureProduct(1, usd("1.5"), false);
    assert.equal((await machine.products(1)).active, false);
    assert.equal(await machine.productCount(), 1n);
    await expectRevert(machine.connect(buyer).buy(1, 1), "ProductInactive");
  });
});
