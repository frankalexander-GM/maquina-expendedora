"use strict";

const { ethers } = require("ethers");

const ABI = [
  "function orders(uint256) view returns (address buyer, uint16 productId, uint32 quantity, uint8 state, uint96 amount, uint64 deadline)",
  "function confirmDispense(uint256 orderId)",
  "function paused() view returns (bool)",
  "event OrderCreated(uint256 indexed orderId, address indexed buyer, uint16 indexed productId, uint32 quantity, uint96 amount, uint64 deadline)",
];

const CONFIG = {
  rpcUrl: process.env.RPC_URL ?? "http://127.0.0.1:8545",
  machineAddress: process.env.MACHINE_ADDRESS ?? "",
  privateKey: process.env.DISPENSER_PRIVATE_KEY ?? "",
  platform: (process.env.PLATFORM ?? "sim").toLowerCase(),
  serialPath: process.env.SERIAL_PATH ?? "",
  baudRate: Number(process.env.BAUD_RATE ?? 115200),
  pollMs: Number(process.env.POLL_MS ?? 4000),
  lookbackBlocks: Number(process.env.LOOKBACK_BLOCKS ?? 64),
  dispenseTimeoutMs: Number(process.env.DISPENSE_TIMEOUT_MS ?? 20000),
};

const STATE_PENDING = 0;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const stamp = () => new Date().toISOString().slice(11, 19);
const log = (...parts) => console.log(`[${stamp()}]`, ...parts);

function fail(message) {
  console.error(`✖ ${message}`);
  process.exit(1);
}

function createSimulatedDispenser() {
  return {
    async dispense(slot, quantity) {
      log(`[sim] motor → slot ${slot}, ${quantity} unidad(es)`);
      await sleep(600);
      return { ok: true, detail: "simulado" };
    },
    async close() {},
  };
}

function createSerialDispenser() {
  if (!CONFIG.serialPath) fail("Con PLATFORM=serial necesitas SERIAL_PATH (ej. COM3 o /dev/ttyUSB0)");

  let SerialPort;
  try {
    ({ SerialPort } = require("serialport"));
  } catch {
    fail("Falta el paquete serialport: npm install serialport");
  }

  const port = new SerialPort({ path: CONFIG.serialPath, baudRate: CONFIG.baudRate, autoOpen: true });
  let buffer = "";
  let pending = null;
  let timer = null;

  const settle = (result) => {
    if (!pending) return;
    const finish = pending;
    pending = null;
    clearTimeout(timer);
    finish(result);
  };

  port.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (/^OK\b/i.test(line)) settle({ ok: true, detail: line });
      else if (/^ERR\b/i.test(line)) settle({ ok: false, detail: line });
      else if (line) log(`[serial] ${line}`);
      newline = buffer.indexOf("\n");
    }
  });

  port.on("error", (error) => {
    log(`[serial] error: ${error.message}`);
    settle({ ok: false, detail: error.message });
  });

  return {
    async dispense(slot, quantity) {
      return new Promise((resolve) => {
        pending = resolve;
        port.write(`DISPENSE ${slot} ${quantity}\n`, (error) => {
          if (error) settle({ ok: false, detail: error.message });
        });
        timer = setTimeout(() => {
          log("[serial] sin respuesta de la placa");
          settle({ ok: false, detail: "timeout" });
        }, CONFIG.dispenseTimeoutMs);
      });
    },
    async close() {
      await new Promise((resolve) => port.close(() => resolve()));
    },
  };
}

async function main() {
  if (!CONFIG.machineAddress) fail("Falta MACHINE_ADDRESS");
  if (!CONFIG.privateKey) fail("Falta DISPENSER_PRIVATE_KEY");

  const provider = new ethers.JsonRpcProvider(CONFIG.rpcUrl);
  const wallet = new ethers.Wallet(CONFIG.privateKey, provider);
  const machine = new ethers.Contract(CONFIG.machineAddress, ABI, wallet);
  const dispenser = CONFIG.platform === "serial" ? createSerialDispenser() : createSimulatedDispenser();

  const network = await provider.getNetwork();
  log(`Contrato ${CONFIG.machineAddress}`);
  log(`Operador ${wallet.address} · chain ${network.chainId} · plataforma ${CONFIG.platform}`);

  if (await machine.paused()) log("⚠ La máquina está en pausa: no entrarán ventas nuevas");

  let cursor = Math.max(0, (await provider.getBlockNumber()) - CONFIG.lookbackBlocks);
  let running = true;

  async function processOrder(event) {
    const { orderId, productId, quantity } = event.args;
    const order = await machine.orders(orderId);

    if (Number(order.state) !== STATE_PENDING) {
      log(`Orden #${orderId} ya resuelta, se ignora`);
      return;
    }

    const now = BigInt(Math.floor(Date.now() / 1000));
    if (order.deadline < now) {
      log(`Orden #${orderId} expirada: el comprador ya puede reclamar el reembolso`);
      return;
    }

    log(`Orden #${orderId}: slot ${productId} × ${quantity} — accionando el motor`);
    const result = await dispenser.dispense(Number(productId), Number(quantity));

    if (!result.ok) {
      log(`Orden #${orderId} sin entrega (${result.detail}). Queda pendiente para reembolso.`);
      return;
    }

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        const tx = await machine.confirmDispense(orderId);
        await tx.wait();
        log(`Orden #${orderId} entregada y confirmada on-chain (${tx.hash})`);
        return;
      } catch (error) {
        log(`Confirmación fallida ${attempt}/3: ${error.shortMessage ?? error.message}`);
        await sleep(2000 * attempt);
      }
    }

    log(`No se pudo confirmar la orden #${orderId}: el comprador podrá pedir reembolso`);
  }

  async function shutdown() {
    if (!running) return;
    running = false;
    log("Cerrando controlador…");
    await dispenser.close();
    process.exit(0);
  }

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  while (running) {
    try {
      const latest = await provider.getBlockNumber();
      if (latest >= cursor) {
        const events = await machine.queryFilter(machine.filters.OrderCreated(), cursor, latest);
        for (const event of events) await processOrder(event);
        cursor = latest + 1;
      }
    } catch (error) {
      log(`Error en el bucle: ${error.shortMessage ?? error.message}`);
    }
    await sleep(CONFIG.pollMs);
  }
}

main().catch((error) => fail(error.stack ?? error.message));
