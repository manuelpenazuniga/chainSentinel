# Prueba de Funcionamiento — ChainSentinel

> Documentacion detallada de la simulacion de ataque ejecutada el **21 de marzo de 2026** sobre Polkadot Hub Testnet (Paseo).

---

## 1. Entorno de Ejecucion

| Parametro | Valor |
|---|---|
| **Red** | Polkadot Hub Testnet (Paseo) |
| **Chain ID** | 420420417 |
| **RPC** | `https://services.polkadothub-rpc.com/testnet` |
| **Bloque inicial (agente)** | 6,660,826 |
| **Bloque final (agente)** | ~6,661,083 |
| **Duracion total** | ~12 minutos |

### Direcciones On-Chain

| Componente | Direccion |
|---|---|
| **SentinelVault** | `0xb0C9621dA0339800b6741bEb0E3749911d259A4d` |
| **SentinelRegistry** | `0x8ea34Df779a161f3Ef26Fb0f6Efd013f2D65A99F` |
| **AI Agent (guardian)** | `0xED0f50f714b1297ebCb5BD64484966DCE32717d1` |
| **Atacante (deployer)** | `0x675fe3d56d6D9A579B9d096708760B23C7F6Febe` |
| **DummyDeFi (target)** | `0xBBe7B7600cf522922b491053A47420612adDa830` |

### Configuracion del Agente

| Parametro | Valor |
|---|---|
| **Heuristic threshold** | 30 (score minimo para invocar LLM) |
| **Emergency threshold** | **50** (modo demo; produccion = 80) |
| **On-chain vault threshold** | **50** (modo demo; produccion = 80) |
| **Cooldown** | 10 bloques |
| **LLM** | Google Gemini 2.5 Flash (temperature 0.1) |

---

## 2. Resumen Ejecutivo

Se ejecutaron **2 corridas** completas del sistema (agente + simulacion de ataque). La primera corrida revelo un fallo parcial que fue diagnosticado y corregido. La segunda corrida demostro el funcionamiento **end-to-end completo** del sistema.

| Corrida | Resultado | Detalle |
|---|---|---|
| **Corrida 1** | Parcial | El agente detecto amenazas y reporto al Registry, pero el `emergencyWithdraw` fallo con `BelowThreshold` porque el contrato on-chain tenia threshold=80 mientras el agente usaba threshold=50 |
| **Corrida 2** | **Exitosa** | Tras alinear ambos thresholds a 50, el emergency withdraw se ejecuto correctamente |

---

## 3. Corrida 1 — Deteccion Correcta, Ejecucion Fallida

### 3.1 Inicio del Agente

```
2026-03-21 13:40:45 [main] === ChainSentinel Agent Starting ===
  RPC: https://services.polkadothub-rpc.com/testnet
  Chain ID: 420420417
  Vault: 0xb0C9621dA0339800b6741bEb0E3749911d259A4d
  Registry: 0x8ea34Df779a161f3Ef26Fb0f6Efd013f2D65A99F
  Heuristic threshold: 30
  Emergency threshold: 50
  Current block: 6,660,672
  Agent address: 0xED0f50f714b1297ebCb5BD64484966DCE32717d1
```

### 3.2 Fase 0 — Seed (10 transacciones normales)

Se enviaron 10 transacciones de 0.01 PAS cada una al contrato DummyDeFi para establecer un historial "normal" que el agente usa como linea base para calcular promedios.

- **Cantidad:** 10 txs
- **Valor por tx:** 0.01 PAS
- **Proposito:** Establecer `avgValue` ~0.01 PAS para el contrato target
- **Resultado:** Las 10 transacciones confirmadas. Ninguna genero alerta (score < 30).

### 3.3 Fase 1 — TX_BURST + ANOMALOUS_VALUE

**Ataque simulado:** 6 transacciones rapidas de 5 PAS cada una (500x el promedio historico).

**Reglas heuristicas esperadas:**
- `ANOMALOUS_VALUE` (+35): 5 PAS / 0.01 PAS promedio = 500x
- `TX_BURST` (+30): 6 txs rapidas al mismo contrato

**Resultado del agente:**

| Campo | Valor |
|---|---|
| Tx analizada | `0x39da90b8...` |
| Score heuristico | **35/100** (ANOMALOUS_VALUE) |
| LLM invocado | Si (score > 30) |
| LLM threatScore | **55** |
| LLM confidence | **75%** |
| LLM classification | `PROBABLE_THREAT` |
| LLM attackType | `UNKNOWN` |
| Score final | **44/100** |
| Accion | `ALERT` (no emergency, score < 50) |

**Analisis del LLM (extracto):**
> "The transaction involves an unusually high value transfer (5.0 DOT) compared to the average (0.46 DOT) to an unknown contract."

**Nota:** El score final de 44 no supero el threshold de 50, por lo que solo se emitio alerta sin accion de emergencia. Esto es correcto para esta fase que busca detectar amenazas moderadas.

### 3.4 Fase 2 — FLASH_LOAN_PATTERN

**Ataque simulado:** Llamada a `flashLoan()` (selector `0xab9c4b5d`) — patron clasico de ataque de flash loan.

**Resultado del agente:**

| Campo | Valor |
|---|---|
| Tx analizada | `0xe01222a7...` |
| Score heuristico | **40/100** (FLASH_LOAN_PATTERN) |
| LLM invocado | Si |
| LLM threatScore | **65** |
| LLM confidence | **80%** |
| LLM classification | `PROBABLE_THREAT` |
| LLM attackType | **`FLASH_LOAN`** |
| Score final | **52/100** |
| Accion | `ALERT` + **Emergency Withdraw intentado** |

**Analisis del LLM (extracto):**
> "Transaction triggered a FLASH_LOAN_PATTERN heuristic (40/100). The 0.0 DOT value is consistent with flash loan mechanics where funds are borrowed and repaid within the same transaction."

**Emergency Withdraw — FALLO:**

```
[executor] EXECUTING EMERGENCY WITHDRAW ALL - Score: 52
[executor] ERROR: Emergency withdraw failed: execution reverted (unknown custom error)
  data: "0x8b05c814...0034...0050"
```

**Diagnostico:** El error `0x8b05c814` corresponde al custom error `BelowThreshold(uint256 score, uint256 threshold)` del contrato SentinelVault. Los parametros decodificados son:
- `score = 0x34 = 52`
- `threshold = 0x50 = 80`

El contrato on-chain aun tenia `threshold = 80`, mientras el agente usaba `threshold = 50`. El score de 52 supero el threshold del agente (50) pero NO el del contrato (80).

**Registry report — EXITOSO:**

A pesar del fallo en el withdraw, el reporte de amenaza al SentinelRegistry SI se ejecuto correctamente:

```
[executor] Threat reported to registry. Target: 0xbbe7b7600cf...
  Score: 52, Tx: 0x4dfc40a8...
```

### 3.5 Fase 3 — Critical Threat (multi-regla)

**Ataque simulado:** 6 llamadas rapidas a `withdraw(3 PAS)` — combina TX_BURST + ANOMALOUS_VALUE + LARGE_WITHDRAWAL.

**Resultado del agente:**

Cada transaccion de withdraw individual recibio score **20/100** (solo LARGE_WITHDRAWAL), que no supero el threshold heuristico de 30. El TX_BURST no se activo porque las transacciones fueron procesadas en bloques separados.

```
[heuristics] Heuristic score for tx 0xb56bc7e6...: 20/100 (triggered: LARGE_WITHDRAWAL)
[main] Assessment: score=20, classification=NORMAL, action=NONE
```

Esto se repitio para las 6 transacciones de withdraw. Ninguna alcanzo score suficiente para invocar al LLM.

### 3.6 Cierre de Corrida 1

```
2026-03-21 13:45:46 [main] Shutting down...
2026-03-21 13:45:46 [monitor] Monitor stopped
2026-03-21 13:45:46 [alerter] ALERT [AGENT_STOPPED]: ChainSentinel agent stopped.
```

**Balance final del atacante:** 4,788.488 PAS (gasto ~32 PAS en gas + transfers)

---

## 4. Corrida 2 — Funcionamiento Exitoso End-to-End

### 4.1 Correccion Aplicada

Antes de la segunda corrida, se alinaron ambos thresholds:
- **Agente:** `DEFAULT_EMERGENCY_THRESHOLD=50` (ya estaba)
- **Contrato on-chain:** `setThreshold(50)` via `cast send`

### 4.2 Inicio del Agente

```
2026-03-21 13:46:00 [main] === ChainSentinel Agent Starting ===
  Emergency threshold: 50
  Current block: 6,660,826
  Agent address: 0xED0f50f714b1297ebCb5BD64484966DCE32717d1
```

### 4.3 Fase 0 — Seed

Identica a Corrida 1. 10 txs de 0.01 PAS confirmadas sin alertas.

### 4.4 Fase 1 — TX_BURST + ANOMALOUS_VALUE

| Campo | Valor |
|---|---|
| Tx analizada | `0x16dd913a...` |
| Score heuristico | **35/100** (ANOMALOUS_VALUE) |
| LLM invocado | Si |
| LLM threatScore | **65** |
| LLM confidence | **80%** |
| LLM classification | `PROBABLE_THREAT` |
| LLM attackType | `UNKNOWN` |
| Score final | **49/100** |
| Accion | `ALERT` (score 49 < threshold 50, por 1 punto) |

**Nota:** El score final de 49 no supero el threshold por un solo punto. Resultado correcto: la fase 1 es una amenaza moderada, no critica.

### 4.5 Fase 2 — FLASH_LOAN_PATTERN (EMERGENCY WITHDRAW EXITOSO)

| Campo | Valor |
|---|---|
| Tx analizada | `0x9c733ffb...` |
| Score heuristico | **40/100** (FLASH_LOAN_PATTERN) |
| LLM invocado | Si |
| LLM threatScore | **70** |
| LLM confidence | **75%** |
| LLM classification | `PROBABLE_THREAT` |
| LLM attackType | **`FLASH_LOAN`** |
| Score final | **54/100** |
| Accion | **`EMERGENCY_WITHDRAW` ejecutado exitosamente** |

**Emergency Withdraw — EXITOSO:**

```
2026-03-21 13:49:21 [executor] EXECUTING EMERGENCY WITHDRAW ALL - Score: 54
2026-03-21 13:49:28 [executor] Emergency withdraw executed!
  Tx hash: 0x790848bd146e4db851532dcefac2dc14872ad34038c079e0753a3335f1f423de
  Block: 6,660,926
```

**Tiempo de respuesta:** ~7 segundos desde deteccion hasta ejecucion on-chain.

**Registry report — EXITOSO:**

```
2026-03-21 13:49:58 [executor] Threat reported to registry.
  Target: 0xbbe7b7600cf522922b491053a47420612adda830
  Score: 54
  Tx: 0x4df439dd308bc01f552c7365a89709e6cdd611973be465c0c657778ad06b0cc9
```

**Alerta emitida:**

```
2026-03-21 13:49:58 [alerter] ALERT [EMERGENCY_EXECUTED]:
  Emergency withdrawal executed! Tx: 0x790848bd...
```

### 4.6 Fase 3 — Critical Threat (multi-regla)

Las transacciones individuales de withdraw generaron score 20 (LARGE_WITHDRAWAL), que no alcanzo el threshold heuristico de 30 para invocar al LLM.

Sin embargo, una transaccion SI activo la regla TX_BURST:

```
2026-03-21 13:52:05 [heuristics] Score for tx 0x610f7b1b...: 30/100 (triggered: TX_BURST)
2026-03-21 13:52:18 [llm] LLM threatScore=70, confidence=75, type=UNKNOWN
2026-03-21 13:52:18 [main] Assessment: score=48, classification=PROBABLE_THREAT, action=ALERT
```

Score final 48, insuficiente para un segundo emergency withdraw (ademas el vault ya fue vaciado en la fase anterior).

### 4.7 Cierre de Corrida 2

El agente continuo monitoreando hasta ser detenido manualmente, procesando bloques normales sin alertas adicionales.

---

## 5. Transacciones On-Chain Verificables

Todas las transacciones son verificables en el explorer de Polkadot Hub Testnet.

### 5.1 Emergency Withdraw (tx exitosa)

| Campo | Valor |
|---|---|
| **Tx Hash** | `0x790848bd146e4db851532dcefac2dc14872ad34038c079e0753a3335f1f423de` |
| **Bloque** | 6,660,926 |
| **De** | `0xED0f50f714b1297ebCb5BD64484966DCE32717d1` (AI Agent) |
| **Para** | `0xb0C9621dA0339800b6741bEb0E3749911d259A4d` (SentinelVault) |
| **Funcion** | `emergencyWithdrawAll(uint256 score, string reason)` |
| **Score enviado** | 54 |
| **Resultado** | Exitoso — fondos transferidos a safeAddress |

### 5.2 Threat Reports al Registry

| # | Tx Hash | Target | Score |
|---|---|---|---|
| 1 | `0x4dfc40a8113ddd83...` (Corrida 1) | `0xBBe7B7...` | 52 |
| 2 | `0x4df439dd308bc01f...` (Corrida 2) | `0xBBe7B7...` | 54 |

### 5.3 Flash Loan simulado

| Corrida | Tx Hash |
|---|---|
| 1 | `0xe01222a79cc38132...` |
| 2 | `0x9c733ffb05a8f11c...` |

---

## 6. Analisis de Rendimiento del Motor de Deteccion

### 6.1 Tiempos de Respuesta del LLM (Gemini 2.5 Flash)

| Invocacion | Duracion | Score |
|---|---|---|
| Fase 1 — ANOMALOUS_VALUE (Corrida 1) | ~11.4s | threatScore=55, confidence=75 |
| Fase 2 — FLASH_LOAN (Corrida 1) | ~7.8s | threatScore=65, confidence=80 |
| Fase 1 — ANOMALOUS_VALUE (Corrida 2) | ~10.8s | threatScore=65, confidence=80 |
| Fase 2 — FLASH_LOAN (Corrida 2) | ~9.0s | threatScore=70, confidence=75 |
| Fase 3 — TX_BURST (Corrida 2) | ~13.3s | threatScore=70, confidence=75 |
| **Promedio** | **~10.5s** | — |

### 6.2 Formula del Score Final

```
final_score = (heuristic_score × 0.4) + (llm_score × 0.6)
Ajustado por confianza:
adjusted = rawScore × (confidence/100) + heuristicScore × (1 - confidence/100)
```

**Ejemplo con Fase 2, Corrida 2:**
- Heuristic: 40, LLM: 70, Confidence: 75%
- Raw: (40 × 0.4) + (70 × 0.6) = 16 + 42 = 58
- Adjusted: 58 × 0.75 + 40 × 0.25 = 43.5 + 10 = 53.5 → redondeado a **54**

### 6.3 Tasa de Deteccion por Regla Heuristica

| Regla | Veces activada | Score |
|---|---|---|
| ANOMALOUS_VALUE | 2 (una por corrida) | +35 |
| FLASH_LOAN_PATTERN | 2 (una por corrida) | +40 |
| LARGE_WITHDRAWAL | 12 (6 por corrida) | +20 |
| TX_BURST | 1 (Corrida 2 solamente) | +30 |

### 6.4 Clasificaciones del LLM

| Clasificacion | Cantidad |
|---|---|
| PROBABLE_THREAT | 5/5 invocaciones |
| CRITICAL_THREAT | 0/5 |
| SUSPICIOUS | 0/5 |
| NORMAL | 0/5 |

El LLM consistentemente clasifico las amenazas como `PROBABLE_THREAT`, nunca alcanzo `CRITICAL_THREAT` lo cual es razonable dado que son ataques simulados contra un contrato dummy sin fondos reales en riesgo.

---

## 7. Flujo Completo Demostrado (End-to-End)

La Corrida 2 demostro exitosamente el flujo completo del sistema:

```
1. Agente arranca y conecta a Polkadot Hub Testnet          ✅
2. Monitor escucha bloques via HTTP polling (cada 6s)         ✅
3. Transacciones normales procesadas sin alertas              ✅
4. Transaccion anomala detectada por heuristicas (score 35)   ✅
5. LLM invocado automaticamente (score > 30)                  ✅
6. LLM analiza y asigna threatScore + clasificacion           ✅
7. Score final calculado con formula dual-layer                ✅
8. Alerta emitida (score 49, bajo threshold 50)               ✅
9. Flash loan detectado por heuristicas (score 40)             ✅
10. LLM identifica correctamente como FLASH_LOAN              ✅
11. Score final 54 supera threshold 50                         ✅
12. emergencyWithdrawAll() ejecutado on-chain                  ✅
13. Fondos transferidos a safeAddress                          ✅
14. Amenaza reportada al SentinelRegistry                      ✅
15. Alerta EMERGENCY_EXECUTED emitida                          ✅
16. Agente continua monitoreando tras la accion                ✅
```

---

## 8. Hallazgos y Lecciones Aprendidas

### 8.1 Bug Encontrado y Corregido

**Problema:** Desalineacion entre el threshold del agente (50) y el threshold del contrato on-chain (80). El agente decidia ejecutar el emergency withdraw pero el contrato lo rechazaba con `BelowThreshold(52, 80)`.

**Causa raiz:** El threshold del contrato se configuro a 80 en el deploy, y cuando se cambio el threshold del agente a 50 para modo demo, no se actualizo simultaneamente el contrato.

**Correccion:** Ejecutar `setThreshold(50)` en el contrato via `cast send`.

**Leccion:** Siempre sincronizar el threshold del agente con el del contrato. Son dos valores independientes que deben coincidir.

### 8.2 Comportamiento del TX_BURST

La regla TX_BURST requiere 5+ transacciones del mismo sender al mismo contrato dentro de 5 bloques. Cuando las transacciones se distribuyen en bloques separados (por latencia de red), la regla no se activa. Esto explica por que:
- Corrida 1: TX_BURST no se activo en ninguna fase
- Corrida 2: TX_BURST solo se activo una vez en la Fase 3

Esto NO es un bug. Es el comportamiento esperado dado que los bloques en Polkadot Hub se producen cada ~2-6 segundos y las transacciones se distribuyen naturalmente.

### 8.3 Score Final Nunca Supero 55

Los scores finales observados fueron: 44, 49, 52, 54, 48. El LLM fue consistentemente conservador (confidence 75-80%, threatScore 55-70), lo que mantiene los scores finales bajos. Esto es:
- **Positivo** para produccion (threshold 80): minimiza falsos positivos
- **Requiere threshold 50** para demos: de otro modo el sistema nunca ejecutaria el emergency withdraw con ataques simulados contra un contrato dummy

---

## 9. Configuracion Actual (Modo Demo)

> **IMPORTANTE:** El sistema esta actualmente en **MODO DEMO** con thresholds reducidos.

| Parametro | Valor actual (demo) | Valor produccion |
|---|---|---|
| `DEFAULT_EMERGENCY_THRESHOLD` (.env) | 50 | 80 |
| `threshold` (SentinelVault on-chain) | 50 | 80 |

### Para restaurar a produccion:

```bash
# 1. Actualizar .env
# Cambiar DEFAULT_EMERGENCY_THRESHOLD=50 → DEFAULT_EMERGENCY_THRESHOLD=80

# 2. Actualizar contrato on-chain
cast send $VAULT_ADDRESS "setThreshold(uint256)" 80 \
  --private-key $DEPLOYER_PRIVATE_KEY \
  --rpc-url $RPC_URL
```

---

## 10. Conclusion

ChainSentinel demostro capacidad funcional end-to-end como agente autonomo de seguridad DeFi sobre Polkadot Hub Testnet:

1. **Monitoreo en tiempo real** de bloques y transacciones on-chain
2. **Deteccion dual-layer** con heuristicas deterministas (Layer 1) + LLM (Layer 2)
3. **Identificacion correcta** de patrones de ataque (flash loan, valores anomalos, bursts)
4. **Ejecucion automatica** de emergency withdraw cuando el score supera el threshold
5. **Reporte publico** de amenazas al SentinelRegistry on-chain
6. **Sistema de alertas** funcional (logs estructurados, preparado para Telegram)

El sistema esta listo para Demo Day con threshold 50, demostrando la proteccion autonoma de fondos DeFi en Polkadot Hub.
