# Máquina expendedora on-chain

Una expendedora que vende **cualquier producto** (bebidas, snacks, lo que quieras dar de alta) y cobra en
**ETH nativo o en un token ERC20 tipo stablecoin**, a tu elección. El dinero queda **retenido en el contrato
hasta que la máquina confirma que entregó el producto**. Si la máquina no responde, el comprador recupera su
dinero solo.

Incluye contrato, interfaz táctil, controlador de hardware y tests. Nada de esto es una maqueta: el
contrato está compilado y con 19 tests pasando, y el flujo completo (compra en ETH → motor → confirmación)
se probó contra una cadena local.

## Qué hay dentro

| Ruta | Qué es |
| --- | --- |
| `contracts/VendingMachine.sol` | Contrato principal: catálogo, stock, precios, escrow y retiros |
| `contracts/MockUSD.sol` | Stablecoin de prueba con 6 decimales (solo desarrollo/testnet) |
| `web/index.html` | Interfaz de la máquina. Funciona sola en modo demo, o contra la cadena con wallet |
| `controller/dispenser-controller.js` | Puente hardware ↔ blockchain: escucha ventas, mueve el motor y confirma |
| `scripts/deploy.js` | Despliega token + máquina y carga 8 productos de ejemplo |
| `test/VendingMachine.test.js` | Tests de la lógica: stock, escrow, reembolsos, permisos, pausa (23 en total) |

## Cómo funciona una venta

```
Cliente                    Contrato                      Controlador           Máquina
  │  buy(2 uds) + pago        │                               │                    │
  ├──────────────────────────►│  reserva stock                │                    │
  │                           │  guarda el pago en escrow     │                    │
  │                           │  emite OrderCreated ─────────►│                    │
  │                           │                               ├─ DISPENSE 2 2 ───►│
  │                           │                               │◄──── OK ───────────┤
  │                           │◄──── confirmDispense ─────────┤                    │
  │                           │  abona el importe al dueño    │                    │
  │                           │                               │                    │
  │  (si no hay confirmación) │                               │                    │
  ├──── refund() tras 5 min ─►│  devuelve importe y stock     │                    │
```

Tres decisiones que explican el diseño:

1. **El stock se reserva al pagar**, no al entregar. Así dos clientes no pueden comprar la última lata.
2. **El dinero no llega al dueño hasta que hay confirmación** del controlador. Es la garantía del comprador.
3. **Si nadie confirma en la ventana (5 min por defecto), el comprador reclama el reembolso** y el stock
   vuelve a la máquina. La ventana es configurable entre 30 segundos y 7 días.

## Modos de pago: ETH o stablecoin

El contrato tiene un solo interruptor: la dirección del token que recibe en el constructor.

| `token` en el constructor | La máquina cobra en | Cómo se paga |
| --- | --- | --- |
| `0x0000…0000` | ETH nativo | `buy(id, qty)` con `value` exacto |
| dirección de un ERC20 | Ese token | `approve` + `buy(id, qty)` sin `value` |

El mismo bytecode sirve para Ethereum, Base, Arbitrum, Optimism, Polygon o cualquier cadena EVM. Si el
comprador manda ETH de más o de menos, la transacción se revierte (`WrongPayment`); y si alguien manda ETH
suelto al contrato sin comprar, también se rechaza para que no quede dinero atrapado.

Cuál elegir:

- **Stablecoin** para un negocio real: el precio del refresco no puede bailar con el mercado. Es la opción
  que recomiendo para producción.
- **ETH nativo** si quieres lo más simple: sin aprobar tokens, sin depender de un contrato extra y con la
  transacción más barata (103.000 de gas frente a 141.000 en la ruta ERC20).

## Por qué blockchain tiene sentido aquí (y dónde no)

Lo que aporta de verdad:

- **Cobro sin datáfono ni efectivo**: ETH o stablecoin, liquidación inmediata, sin contracargos.
- **Garantía verificable**: el escrow no depende de la buena fe del operador; el reembolso es una función
  del contrato que el comprador puede ejecutar solo.
- **Auditoría**: cada venta, reposición y retiro queda como evento. Sirve para conciliar caja por máquina
  y para demostrar ingresos sin un sistema contable aparte.
- **Varias máquinas, un mismo riel**: cada expendedora puede ser su propio contrato y tú consolidas la
  recaudación desde una sola wallet.

Lo que **no** conviene meter on-chain: inventario físico real, telemetría, precios dinámicos por demanda,
datos personales o promociones. Eso va en tu backend; el contrato solo guarda lo que debe ser público y
verificable (precio, stock, orden, pago, entrega).

## Arranque rápido (sin instalar nada)

Abre `web/index.html` en el navegador. Arranca en **modo demo**: 8 productos, saldo de prueba, compra,
entrega simulada, libro de ventas y panel de operador. Todo en memoria, sin wallet ni cadena.

## Probarlo con una cadena local

```powershell
npm install
npm test                  # 19 tests
npm run node              # terminal 1: nodo local en 127.0.0.1:8545
npm run deploy:local      # terminal 2: despliega y carga el catálogo (ETH por defecto)
```

El deploy imprime algo así:

```
Modo de pago:   ETH nativo
VendingMachine: 0x5FbD...0aa3

Abre web/index.html?machine=0x5FbD...0aa3
```

Si prefieres probar el modo stablecoin:

```powershell
$env:PAYMENT="token"; npm run deploy:local
```

Abre esa URL, pulsa **Conectar wallet** y añade la red Hardhat a MetaMask (`http://127.0.0.1:8545`,
chain id `31337`). Importa una de las cuentas de prueba que imprime el nodo y ya puedes comprar de verdad.
La interfaz lee del contrato si cobra en ETH o en token; no hay que configurar nada más.

### Probar el controlador

Con el nodo y el contrato desplegados, en otra terminal:

```powershell
$env:RPC_URL="http://127.0.0.1:8545"
$env:MACHINE_ADDRESS="0x5FbD...0aa3"
$env:DISPENSER_PRIVATE_KEY="0xac09...ff80"   # cuenta #0 de Hardhat (solo local)
$env:PLATFORM="sim"
node controller/dispenser-controller.js
```

Compra desde la web y verás en el log cómo detecta la orden, acciona el motor simulado y confirma la
entrega on-chain.

## La máquina física

El controlador corre en una Raspberry Pi (o cualquier equipo con Linux) conectado a la placa que mueve los
motores. La placa solo necesita entender un protocolo de texto por serial:

```
→ DISPENSE <slot> <cantidad>\n
← OK
← ERR <código>
```

Con `PLATFORM=serial` el controlador abre `SERIAL_PATH` (por ejemplo `COM3` o `/dev/ttyUSB0`) a
`BAUD_RATE` (115200 por defecto) y espera `OK` con un timeout. Si la placa usa MDB, pulsos o relés,
esa traducción se hace en el firmware; el contrato no cambia.

Puntos finos de seguridad en el hardware:

- Usa una **wallet dedicada al dispensador**, distinta de la del dueño. Solo puede confirmar y cancelar.
- Nunca metas la clave del dueño en el dispositivo. Si te roban la Pi, pierdes como mucho el gas.
- Deja la Pi con salida a internet mínima y sin puertos abiertos; ella inicia las conexiones.
- Si el motor falla, **no confirmes**: deja la orden pendiente y el cliente cobra el reembolso. Es mejor
  perder una venta que cobrar sin entregar.

## Panel de administración

El engranaje de la esquina superior derecha abre el panel. Todo lo que cambia el comportamiento de la
máquina se hace desde ahí, sin tocar código:

- **Catálogo**: crear productos, renombrarlos, cambiar precio, fijar el stock exacto y activarlos o
desactivarlos. Desactivar no borra: la referencia queda en el historial de ventas.
- **Ajustes**: ventana de entrega (1 min a 7 días), máximo de unidades por compra (1 a 50) y dirección
donde se retira la caja.
- **Seguridad**: pausar ventas, cambiar la wallet del controlador y transferir la propiedad en dos pasos
(el nuevo dueño tiene que aceptar).
- **Órdenes**: confirmar entregas o reembolsar una compra atascada sin esperar la ventana.

En modo demo todo se aplica en memoria para que puedas probarlo sin wallet. Con wallet conectada, cada
cambio es una transacción firmada por el dueño; la interfaz solo envía las llamadas de los campos que
realmente cambiaste.

## Comprobante de pago

Cada venta emite un comprobante que se abre solo cuando la máquina confirma la entrega:

- Orden, fecha, comprador, producto, cantidad, precio unitario y total pagado.
- Hash de la transacción y **QR** al explorador de la red, para verificarlo desde el móvil.
- Botón **Verificar**: relee la orden del contrato y comprueba que el comprador y el importe coinciden.
- **Descargar PNG** para guardarlo como archivo e **Imprimir** (sirve para guardar como PDF).
- En el panel de administración queda la lista de los últimos comprobantes emitidos.

Se guardan en el navegador y se pueden reabrir desde el libro de ventas o desde el panel. En modo demo
llevan marca de agua y no tienen validez on-chain: el hash se sustituye por “sin transacción”.

El QR se genera con `web/vendor/qrcode.js` (qrcode-generator, licencia MIT), incluido en el repo para que
funcione sin conexión.

## Operación diaria

| Tarea | Cómo |
| --- | --- |
| Dar de alta un producto | `addProduct(nombre, precio, stock)` o el botón **+ Producto** (hasta 65.535 referencias) |
| Reponer | `restock(id, unidades)` (suma) o `setStock(id, stock)` (fija el total contado) |
| Cambiar nombre, precio o estado | `setProductName`, `configureProduct` |
| Cambiar el máximo por compra | `setMaxQuantity` (1 a 50) |
| Ajustar la ventana de entrega | `setDispenseWindow` (30 s a 7 días) |
| Retirar la recaudación | `withdraw(dirección)` — solo el dueño |
| Parar ventas (avería) | `setPaused(true)` — los reembolsos siguen funcionando |
| Reembolsar una orden atascada | `cancelOrder(id)` desde el panel de operador |
| Cambiar de dueño | `transferOwnership` + `acceptOwnership` (dos pasos) |
| Cambiar la wallet del controlador | `setDispenser` |

Límites del contrato: máximo **50 unidades por compra** (configurable, 10 por defecto). Los precios se
guardan en la unidad mínima: en ETH son wei (`0.0012 ETH` = `1200000000000000`) y en un token de 6
decimales son millonésimas (`1.50 mUSD` = `1500000`).

## Tests

```powershell
npm test
```

Cubren: alta y catálogo, cobro y reserva de stock, confirmación y retiro, doble confirmación, reembolso
tras la ventana, reembolso solo por el comprador, cancelación por el operador, permisos de dispensador,
cantidades y stock inválidos, pago sin aprobación, pausa, producto inactivo/precio cero, traspaso de
propiedad, toda la ruta de pago en ETH y los ajustes del operador (renombrar, fijar stock, máximo por
compra y desactivar sin borrar).

### Integración continua

El workflow de GitHub Actions está en `ci/github-actions-test.yml`. Queda fuera de `.github/workflows/`
porque el token con el que se subió el repo no tiene el permiso `workflow`. Para activarlo:

```powershell
gh auth refresh -s workflow
New-Item -ItemType Directory -Force .github/workflows | Out-Null
Copy-Item ci/github-actions-test.yml .github/workflows/test.yml
git add .github/workflows/test.yml
git commit -m "ci: activa el workflow de tests"
git push
```

## Pasar a testnet o producción

1. Añade la red a `hardhat.config.js` con `url` y `accounts: [process.env.DEPLOYER_KEY]`.
2. Elige modo de cobro: `PAYMENT=eth` (nativo) o `PAYMENT=token` con la stablecoin real de esa red
   (USDC en Base, por ejemplo). Si usas token, sustituye `MockUSD` por su dirección.
3. Despliega con `npx hardhat run scripts/deploy.js --network baseSepolia`.
4. Configura el dispensador con la dirección real del controlador (`setDispenser`).
5. Financia la wallet del dispensador solo con gas. No necesita tokens.

Coste orientativo: una compra en ETH consume ~103.000 de gas y en token ~141.000; en una L2 eso suele ser
menos de un céntimo. Cada venta son dos transacciones (la del cliente y la confirmación del operador), así
que el margen por unidad tiene que cubrir ese gas más el precio del producto.

## Límites conocidos y siguientes pasos

- **El cliente necesita ETH para el gas.** En producción conviene un paymaster (account abstraction) para
  que pague solo con el token, o un checkout con QR y relayer.
- **Si cobras en ETH, el precio en euros/dólares fluctúa.** Por eso para un negocio real conviene stablecoin
  o un oráculo de precios que ajuste la tarifa.
- **El precio es público y fijo on-chain.** Descuentos y promociones van fuera del contrato, con vales
  firmados si hace falta.
- **El historial de compras es público.** Si la privacidad importa, no vincules la wallet al cliente.
- **La ventana usa el reloj de la cadena** (±15 s de margen de un minero). Suficiente para este caso.
- Siguiente paso natural: registro multi-máquina, recibos NFT, telemetría firmada por el controlador y
  conciliación automática de caja por máquina.
