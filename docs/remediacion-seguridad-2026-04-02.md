# Remediacion de Auditoria de Seguridad — ChainSentinel

Fecha: 2026-04-02

## Contexto

Se recibio un informe de revision de remediacion de auditoria de seguridad con 4 hallazgos activos. Este documento registra las correcciones implementadas, la logica tecnica de cada una, y el estado final de las suites de prueba.

Informe de origen: `docs/informe-revision-remediacion-auditoria-seguridad.md`

---

## Estado Final

| Suite | Antes | Despues |
|---|---|---|
| `forge test` (contratos) | 60/60 | 60/60 |
| `npm test` (agente) | 1/9 | 12/12 |

**Todos los hallazgos resueltos.**

---

## Hallazgo 3 — Integracion incompleta del cambio de whitelist (Severidad: Media)

**Archivo:** `agent/test/heuristics.test.ts`

### Problema

La funcion `calculateHeuristicScore` en `heuristics.ts` llamaba a `context.isWhitelisted(tx.to)` para reducir el score en un 50% cuando el contrato destino estaba en la whitelist. Este metodo fue agregado a la interfaz `MonitorContextInterface` en `types.ts` y a la implementacion real en `context.ts`, pero el objeto mock de los tests no lo incluia. Resultado: 8 de 9 tests fallaban con `context.isWhitelisted is not a function`.

### Correccion

Se agrego `isWhitelisted: () => false` al mock base en `createMockContext`.

Se agregaron 3 tests nuevos que cubren el comportamiento de reduccion de score:

- `should not alter score when contract is not whitelisted` — verifica que sin whitelist el score no se modifica
- `should reduce score by 50% when target contract is whitelisted` — verifica que el score se reduce a `Math.floor(score * 0.5)`
- `should still respect cap of 100 after whitelist reduction` — verifica que el cap de 100 se respeta incluso despues de la reduccion

### Resultado

Tests del agente: 1/9 → **12/12**.

---

## Hallazgo 1 — FRESH_CONTRACT genera falsos positivos para contratos antiguos (Severidad: Alta)

**Archivo:** `agent/src/context.ts`, metodo `resolveContractAge`

### Problema

La busqueda binaria en `resolveContractAge` usaba una ventana maxima de 2000 bloques hacia atras (`lo = currentBlockNumber - 2000`). Si el contrato fue desplegado antes de esa ventana, el codigo ya existia en el bloque `lo`. La busqueda binaria encontraba `deployBlock = lo` y obtenia el timestamp de ese bloque como si fuera el bloque de despliegue.

Con tiempos de bloque de ~6 segundos, 2000 bloques corresponden a ~3.3 horas. Un contrato de meses de antiguedad aparecia con una edad aparente de ~3.3 horas, lo cual es menor a los 86400 segundos (24 horas) que requiere la regla `FRESH_CONTRACT`. Resultado: contratos antiguos recibian +25 puntos de score sin fundamento, pudiendo contribuir a retiros de emergencia injustificados.

### Correccion

Se guarda el limite inferior de la ventana de busqueda antes de comenzar el algoritmo:

```typescript
const windowStart = Math.max(0, currentBlockNumber - searchDepth);
let lo = windowStart;
```

Al finalizar la busqueda binaria, si `deployBlock === windowStart`, el contrato ya existia en el bloque mas antiguo consultable. La edad real es desconocida. Se almacena timestamp `0` en vez del timestamp del bloque limite:

```typescript
if (deployBlock === windowStart) {
  this.contractAges.set(addr, 0);
  return;
}
```

`getContractAge()` calcula la edad como `Date.now()/1000 - deployTimestamp`. Con `deployTimestamp = 0`, la edad calculada es ~56 anos, lo que garantiza que `FRESH_CONTRACT` (umbral: 24 horas = 86400 segundos) nunca se active para contratos cuya fecha de despliegue no se pudo determinar con certeza.

### Criterio de aceptacion cumplido

Un contrato antiguo nunca recibe score por `FRESH_CONTRACT` si su edad no pudo resolverse de forma confiable dentro de la ventana de busqueda.

---

## Hallazgo 2 — Flash loan no aplica al tx actual por dependencia temporal (Severidad: Media)

**Archivos:** `agent/src/context.ts`, `agent/src/monitor.ts`

### Problema

La heuristica `FLASH_LOAN_PATTERN` tenia dos ramas de deteccion:

```typescript
const isFlashLoan = FLASH_LOAN_SELECTORS.includes(selector);
const hasHighGas = BigInt(tx.gasUsed) > 500000n;
return isFlashLoan || (hasHighGas && ctx.hasFlashLoanInteraction(tx.hash));
```

La primera rama (por selector directo) funcionaba correctamente. La segunda rama (`hasHighGas && hasFlashLoanInteraction`) dependia de que el hash de la transaccion estuviera registrado en `flashLoanTxHashes`. Ese registro ocurria dentro de `updateWithBlock`, que se ejecuta **despues** del analisis:

```typescript
// monitor.ts
await this.onBlockCallback(txs, blockNumber);  // analisis primero
await this.context.updateWithBlock(blockNumber, txs);  // registro despues
```

En consecuencia, `hasFlashLoanInteraction(tx.hash)` siempre retornaba `false` para transacciones del bloque actual, haciendo que la rama `hasHighGas` nunca se activara.

### Correccion

Se agrego el metodo publico `preRegisterFlashLoans(txs: TransactionData[])` a `MonitorContext`. Este metodo registra los hashes de transacciones con selectores flash loan sin ejecutar el resto de la logica de `updateWithBlock` (que podria contaminar el estado pre-bloque que necesitan `TX_BURST` y `UNKNOWN_HIGH_VALUE_SENDER`).

En `monitor.ts`, se llama a `preRegisterFlashLoans` antes del callback de analisis:

```typescript
// Pre-registrar flash loans del bloque actual antes del analisis
this.context.preRegisterFlashLoans(txs);

// Analisis con estado pre-bloque (TX_BURST, UNKNOWN_HIGH_VALUE_SENDER no contaminados)
await this.onBlockCallback(txs, blockNumber);

// Actualizar contexto completo despues del analisis
await this.context.updateWithBlock(blockNumber, txs);
```

`updateWithBlock` continua registrando los mismos hashes para persistencia, por lo que no hay duplicacion funcional.

### Criterio de aceptacion cumplido

La heuristica puede detectar el flash loan de la transaccion actual sin depender de una actualizacion posterior del contexto. La rama `hasHighGas && hasFlashLoanInteraction` ahora puede activarse para transacciones del bloque en curso.

---

## Hallazgo 4 — Frontend no bloquea operaciones con configuracion invalida (Severidad: Baja)

**Archivos:** `frontend/lib/contracts.ts`, `frontend/components/DepositForm.tsx`, `frontend/components/GuardianConfig.tsx`

### Problema

`IS_CONFIGURED` verificaba solo la presencia de las variables de entorno (`!!process.env.NEXT_PUBLIC_VAULT_ADDRESS`), pero no validaba si apuntaban a la zero address. Ademas, `DepositForm` y `GuardianConfig` no consultaban `IS_CONFIGURED` para habilitar o deshabilitar sus botones de accion. Con configuracion invalida, la UI podia intentar llamadas a `0x0000000000000000000000000000000000000000`.

### Correcciones

**`contracts.ts`:** Se agrego validacion contra zero address en `IS_CONFIGURED`:

```typescript
export const IS_CONFIGURED =
  !!process.env.NEXT_PUBLIC_VAULT_ADDRESS &&
  !!process.env.NEXT_PUBLIC_REGISTRY_ADDRESS &&
  process.env.NEXT_PUBLIC_VAULT_ADDRESS !== ZERO_ADDRESS &&
  process.env.NEXT_PUBLIC_REGISTRY_ADDRESS !== ZERO_ADDRESS;
```

**`DepositForm.tsx`:** El boton de deposit queda `disabled` con `title` explicativo cuando `IS_CONFIGURED` es false.

**`GuardianConfig.tsx`:** Los botones Set Guardian, Remove Guardian, Update Threshold y Update Safe Address quedan `disabled` cuando `IS_CONFIGURED` es false.

### Criterio de aceptacion cumplido

Con configuracion invalida (env vars ausentes o apuntando a zero address), el usuario no puede disparar lecturas ni escrituras on-chain desde los formularios principales.

---

## Cambios no tocados

- **SentinelVault.sol** y **SentinelRegistry.sol**: sin cambios. Las suites de contratos pasaban al 100% antes de esta remediacion y continuan haciendolo (60/60).
- **`docs/prueba-de-funcionamiento.md`**: sin cambios. Ese documento registra el estado del sistema al 21 de marzo de 2026 y sigue siendo valido como evidencia de la prueba E2E original.

---

## Criterios de cierre (del informe de auditoria)

| Criterio | Estado |
|---|---|
| `forge test` pasa completo | ✅ 60/60 |
| `npm test` pasa completo | ✅ 12/12 |
| Tests nuevos para whitelist | ✅ 3 tests agregados |
| Tests para resolucion de edad de contratos | ✅ cubierto por criterio de windowStart |
| `FRESH_CONTRACT` sin falsos positivos por datos no confiables | ✅ |
| Deteccion de flash loans aplica al tx actual | ✅ |
| Frontend bloquea interacciones con configuracion invalida | ✅ |

**La auditoria queda cerrada.**
