# ChainSentinel — Plan de Implementacion Multi-Usuario

> Plan detallado para escalar ChainSentinel de un demo single-user a un servicio multi-usuario.
> Incluye decisiones clave con analisis de pros/contras para cada opcion.
> Fecha: 2026-03-22

---

## Indice

1. [Estado actual y dependencias](#1-estado-actual-y-dependencias)
2. [Decision 1: Arquitectura de Vaults](#2-decision-1-arquitectura-de-vaults)
3. [Decision 2: Patron de Deploy (Factory)](#3-decision-2-patron-de-deploy-factory)
4. [Decision 3: Gas del Agente](#4-decision-3-gas-del-agente)
5. [Decision 4: Gestion de Guardian Keys](#5-decision-4-gestion-de-guardian-keys)
6. [Decision 5: Arquitectura del Agente Multi-Vault](#6-decision-5-arquitectura-del-agente-multi-vault)
7. [Decision 6: Frontend Multi-Vault](#7-decision-6-frontend-multi-vault)
8. [Decision 7: Modelo de Negocio](#8-decision-7-modelo-de-negocio)
9. [Plan de Implementacion por Fases](#9-plan-de-implementacion-por-fases)
10. [Riesgos y Mitigaciones](#10-riesgos-y-mitigaciones)

---

## 1. Estado Actual y Dependencias

### 1.1 Inventario de hardcoding single-user

Cada componente del sistema tiene asunciones de un solo vault que deben cambiar:

| Componente | Archivo | Linea(s) | Hardcoding |
|---|---|---|---|
| Agent config | `agent/src/index.ts` | 27 | `vaultAddress: process.env.VAULT_ADDRESS!` — un solo string |
| Agent executor | `agent/src/executor.ts` | 34 | `this.vault = new ethers.Contract(config.vaultAddress, ...)` — un solo contrato |
| Agent executor | `agent/src/executor.ts` | 72-80 | Chequea guardian de un solo vault |
| Agent alerter | `agent/src/alerter.ts` | — | Logs mencionan un solo vault |
| Frontend config | `frontend/lib/contracts.ts` | 2-4 | `VAULT_ADDRESS` constante global |
| Frontend dashboard | `frontend/app/page.tsx` | 43-47 | `useReadContract({ address: VAULT_ADDRESS })` |
| Frontend VaultStatus | `frontend/components/VaultStatus.tsx` | 9 | Hardcoded `VAULT_ADDRESS` |
| Frontend GuardianConfig | `frontend/components/GuardianConfig.tsx` | 13 | Hardcoded `VAULT_ADDRESS` |
| Frontend DepositForm | `frontend/components/DepositForm.tsx` | — | Hardcoded `VAULT_ADDRESS` |
| Frontend WithdrawForm | `frontend/components/WithdrawForm.tsx` | — | Hardcoded `VAULT_ADDRESS` |
| Contrato SentinelVault | `contracts/src/SentinelVault.sol` | 101-106 | `owner = msg.sender` sin `transferOwnership()` |

### 1.2 Lo que NO necesita cambiar

| Componente | Razon |
|---|---|
| `SentinelRegistry.sol` | Ya es global — reportes por contrato target, no por vault |
| `agent/src/monitor.ts` | Analiza TODAS las txs del chain, no filtra por vault |
| `agent/src/heuristics.ts` | Reglas son genericas, no vault-specific |
| `agent/src/llm.ts` | Analisis LLM es independiente del vault |
| `agent/src/context.ts` | Contexto es por contrato target, no por vault |
| ThreatChart/ThreatFeed | Ya usan eventos globales `ThreatReported` |

---

## 2. Decision 1: Arquitectura de Vaults

### Pregunta: ¿Un vault por usuario o un vault compartido?

---

### Opcion A: Un vault individual por usuario (RECOMENDADA)

Cada usuario despliega su propio contrato `SentinelVault` con su propia configuracion.

```
Usuario A → VaultA (owner=A, safeAddress=A_cold, threshold=80)
Usuario B → VaultB (owner=B, safeAddress=B_multisig, threshold=60)
Usuario C → VaultC (owner=C, safeAddress=C_hw, threshold=90)
```

**Pros:**
- **Aislamiento total**: un bug o exploit en un vault no afecta a otros
- **Flexibilidad**: cada usuario configura su threshold, safeAddress, guardian independientemente
- **Seguridad**: los fondos estan separados fisicamente en contratos distintos
- **Simplicidad conceptual**: el modelo actual ya funciona asi, solo hay que multiplicarlo
- **Auditabilidad**: cada vault tiene su propio historial de eventos on-chain
- **Responsabilidad clara**: el owner es el unico que puede depositar/retirar
- **Compatible con el contrato actual**: SentinelVault.sol ya soporta esto sin cambios

**Contras:**
- **Costo de deploy**: cada vault cuesta gas (~$2-5 USD en L2, potencialmente mas en Polkadot Hub)
- **Mas contratos en la chain**: N usuarios = N contratos desplegados
- **Complejidad del agente**: debe monitorear N vaults en paralelo
- **Overhead de gas acumulado**: N emergency withdraws si hay ataque generalizado

---

### Opcion B: Vault compartido con mappings internos

Un solo contrato mantiene los fondos de todos los usuarios con separacion logica.

```solidity
contract SharedVault {
    struct UserConfig {
        address safeAddress;
        uint256 threshold;
        bool isActive;
    }
    mapping(address => mapping(address => uint256)) public balances; // user => token => amount
    mapping(address => UserConfig) public configs;
}
```

**Pros:**
- **Eficiencia en gas**: un solo deploy, funciones shared son mas baratas
- **Monitoreo simple**: el agente solo monitorea un contrato
- **UX mas simple**: el usuario solo interactua con un contrato conocido
- **Menos contratos en la chain**: 1 contrato vs N contratos

**Contras:**
- **Riesgo sistematico**: un bug en el contrato afecta a TODOS los usuarios
- **Superficie de ataque mayor**: mas logica = mas posibilidades de vulnerabilidad
- **Upgradeability necesario**: si hay un bug, no puedes re-deployar sin migrar fondos de todos
- **Complejidad del contrato**: mucho mas codigo, mas dificil de auditar
- **Limitaciones de gas**: funciones que iteran sobre N usuarios pueden exceder gas limit
- **Contrato actual incompatible**: SentinelVault.sol tendria que reescribirse completamente

---

### Opcion C: Modelo hibrido — Proxy pattern (vaults individuales, logica compartida)

Cada usuario tiene su propio proxy (almacenamiento separado) que delega a una implementacion compartida.

```
VaultProxy_A → [delegatecall] → VaultImplementation v1
VaultProxy_B → [delegatecall] → VaultImplementation v1
VaultProxy_C → [delegatecall] → VaultImplementation v1
```

**Pros:**
- **Aislamiento de fondos**: cada proxy tiene su propio storage
- **Deploy barato**: un proxy es ~$0.50 vs ~$3 para un vault completo
- **Upgradeable**: puedes actualizar la implementacion para todos los vaults a la vez
- **Eficiente**: combina lo mejor de A y B

**Contras:**
- **Complejidad del patrón proxy**: delegatecall es notoriamente dificil de implementar correctamente
- **Riesgo de storage collision**: errores en el layout de storage son catastróficos
- **Dependencia de OpenZeppelin Proxy**: no reinventar la rueda, pero agrega dependencia
- **Storage immutable**: una vez desplegado, el layout de storage no puede cambiar sin migracion
- **Mas dificil de auditar**: delegatecall + proxy patterns son fuente frecuente de bugs

---

### **Recomendacion: Opcion A (vaults individuales) para v1.1, migrar a Opcion C (proxies) en v2.0**

**Razonamiento:**
- v1.1 debe ser rapido de implementar — vaults individuales solo requieren un Factory contract
- El contrato actual (SentinelVault.sol) funciona sin cambios, solo hay que agregarle `transferOwnership()`
- Cuando haya volumen real de usuarios (>100), migrar a minimal proxies (EIP-1167) para reducir costos
- EIP-1167 clones cuestan ~$0.10 vs ~$3 del vault completo

---

## 3. Decision 2: Patron de Deploy (Factory)

### Pregunta: ¿Como despliega cada usuario su vault?

---

### Opcion A: Factory simple con `new` (RECOMENDADA para v1.1)

```solidity
contract VaultFactory {
    event VaultCreated(address indexed owner, address indexed vault, address safeAddress);

    address public serviceGuardian; // Direccion del agente IA del servicio
    address[] public allVaults;
    mapping(address => address[]) public userVaults;

    function createVault(address safeAddress, uint256 threshold) external returns (address) {
        SentinelVault vault = new SentinelVault(safeAddress, threshold);
        // El factory es el owner inicial, luego transfiere
        vault.setGuardian(serviceGuardian);
        vault.transferOwnership(msg.sender);
        allVaults.push(address(vault));
        userVaults[msg.sender].push(address(vault));
        emit VaultCreated(msg.sender, address(vault), safeAddress);
        return address(vault);
    }

    function getUserVaults(address user) external view returns (address[] memory) {
        return userVaults[user];
    }

    function getActiveVaultCount() external view returns (uint256) {
        return allVaults.length;
    }
}
```

**Pros:**
- Simple, facil de entender y auditar
- SentinelVault.sol existente funciona con minimos cambios (solo agregar `transferOwnership()`)
- Evento `VaultCreated` permite indexar off-chain
- `getUserVaults()` permite al frontend descubrir vaults del usuario conectado
- `allVaults` permite al agente descubrir todos los vaults activos

**Contras:**
- Costo de deploy por vault: ~130,000-200,000 gas (el bytecode completo del vault)
- Sin upgradeability — si hay bug, cada vault debe migrarse individualmente
- No se puede predecir la direccion del vault antes del deploy

---

### Opcion B: Factory con CREATE2 (direcciones predecibles)

```solidity
function createVault(address safeAddress, uint256 threshold, bytes32 salt) external returns (address) {
    SentinelVault vault = new SentinelVault{salt: keccak256(abi.encodePacked(msg.sender, salt))}(
        safeAddress, threshold
    );
    // ...
}
```

**Pros:**
- Direccion del vault predecible antes del deploy (`keccak256(deployer + salt + bytecode)`)
- Util para UX: "tu vault sera 0x1234..." antes de que el usuario confirme
- Permite pre-autorizar transfers al vault antes de que exista

**Contras:**
- Complejidad adicional sin beneficio claro para el MVP
- El salt debe ser unico por usuario (sino colision)
- Si el bytecode del vault cambia, todas las predicciones se invalidan

---

### Opcion C: Factory con Minimal Proxy (EIP-1167 Clones)

```solidity
import "@openzeppelin/contracts/proxy/Clones.sol";

contract VaultFactory {
    using Clones for address;
    address public implementation; // SentinelVault desplegado una vez

    function createVault(address safeAddress, uint256 threshold) external returns (address) {
        address clone = implementation.clone();
        SentinelVault(payable(clone)).initialize(msg.sender, safeAddress, threshold);
        // ...
    }
}
```

**Pros:**
- Deploy extremadamente barato: ~45,000 gas vs ~200,000+ (proxy es solo 45 bytes)
- Todos los clones comparten la misma logica (implementation)
- Actualizar implementation = actualizar logica para futuros clones (no retroactivo)

**Contras:**
- SentinelVault necesita reescribirse: constructor → `initialize()` (patron initializable)
- Riesgo de doble-inicializacion si no se usa `initializer` modifier correctamente
- Clones anteriores NO se actualizan cuando cambias el implementation (no es un beacon)
- Mas complejo de testear

---

### Opcion D: Factory con Beacon Proxy (upgradeable retroactivo)

```solidity
import "@openzeppelin/contracts/proxy/beacon/UpgradeableBeacon.sol";
import "@openzeppelin/contracts/proxy/beacon/BeaconProxy.sol";

contract VaultFactory {
    UpgradeableBeacon public beacon;

    function createVault(address safeAddress, uint256 threshold) external returns (address) {
        bytes memory data = abi.encodeCall(SentinelVault.initialize, (msg.sender, safeAddress, threshold));
        BeaconProxy proxy = new BeaconProxy(address(beacon), data);
        // ...
    }
}
```

**Pros:**
- **Todos los vaults se actualizan al mismo tiempo** cambiando el implementation del beacon
- Deploy relativamente barato (proxy pattern)
- Corregir un bug en produccion es un solo tx (upgrade beacon)

**Contras:**
- Poder centralizado: quien controle el beacon puede cambiar la logica de todos los vaults
- Riesgo de upgrade malicioso: un attack al beacon compromete TODOS los fondos
- Complejidad maxima: beacon + proxy + initializable + storage layout
- SentinelVault necesita reescribirse completamente (initializable pattern)
- Los usuarios deben confiar en el operador del beacon

---

### **Recomendacion:**

| Fase | Patron | Razon |
|---|---|---|
| **v1.1** | **Opcion A (Factory simple)** | Rapido, seguro, compatible con vault actual. Solo agregar `transferOwnership()` |
| **v2.0** | **Opcion C (EIP-1167 Clones)** | Cuando el costo de deploy sea un problema (>100 usuarios) |
| **v3.0** | Evaluar **Opcion D (Beacon)** | Solo si se necesita upgradeability retroactiva y hay governance descentralizado |

---

## 4. Decision 3: Gas del Agente

### Pregunta: ¿Quien paga el gas de `emergencyWithdraw()` y `reportThreat()`?

Esto es critico porque el agente necesita gas para cada accion y con N usuarios puede ser costoso.

---

### Opcion A: Gas tank centralizado (RECOMENDADA para v1.1)

El servicio mantiene una wallet fondeada que paga gas por todas las operaciones.

```
Modelo:
- El servicio tiene una hot wallet con PAS
- Cobra a los usuarios via suscripcion o fee por vault
- Monitorea el balance y alerta si baja de umbral
```

**Pros:**
- Implementacion trivial — es lo que ya hacemos (una wallet con fondos)
- UX transparente para el usuario (no necesita entender gas)
- Rapido de implementar

**Contras:**
- Riesgo de quedarse sin gas si hay muchos emergency withdraws simultaneos
- Centralizacion: si la wallet se compromete, el agente no puede actuar
- No escala bien a miles de usuarios sin recarga automatica
- El servicio absorbe el costo de gas

---

### Opcion B: Gas tank por usuario

Cada vault tiene un deposito de gas que el agente consume.

```solidity
contract SentinelVault {
    uint256 public gasTank;

    function depositGas() external payable onlyOwner {
        gasTank += msg.value;
    }

    function emergencyWithdraw(...) external onlyGuardian {
        // ... ejecutar withdraw ...
        // Reembolsar gas al guardian desde el tank
        uint256 gasUsed = (startGas - gasleft()) * tx.gasprice;
        require(gasTank >= gasUsed, "Insufficient gas tank");
        gasTank -= gasUsed;
        payable(msg.sender).transfer(gasUsed);
    }
}
```

**Pros:**
- Justo: cada usuario paga su propia proteccion
- Sin riesgo de agotamiento global
- Incentivo alineado: el usuario fondea porque quiere proteccion

**Contras:**
- UX mas compleja: el usuario debe hacer un deposito adicional para gas
- Si el gas tank se agota, el vault queda sin proteccion
- El reembolso in-contract agrega complejidad y superficie de ataque
- El precio del gas puede variar — dificil estimar cuanto depositar

---

### Opcion C: Meta-transactions (ERC-2771 / Relayer)

El usuario firma un mensaje off-chain, un relayer paga el gas.

```
Flujo:
1. Agente detecta amenaza
2. Agente firma meta-tx: "emergencyWithdraw(vault=0x123, score=85)"
3. Relayer (ej: OpenZeppelin Defender, Gelato) envia la tx y paga gas
4. El costo se cobra al usuario via suscripcion
```

**Pros:**
- Desacoplado: el agente no necesita tener balance de gas
- Escalable: el relayer puede procesar miles de txs
- Fiable: servicios como Gelato/Defender tienen SLA de uptime

**Contras:**
- Dependencia de terceros: si el relayer esta caido, no hay emergency withdraw
- Costo del servicio de relayer (Gelato cobra ~$0.01/tx + gas)
- Complejidad: integrar ERC-2771, trusted forwarder, etc.
- SentinelVault necesita soportar meta-txs (`_msgSender()` en vez de `msg.sender`)
- Polkadot Hub puede no tener relayers disponibles aun

---

### Opcion D: Account Abstraction (ERC-4337)

El vault paga su propio gas usando los fondos depositados.

```
Flujo:
1. Agente crea un UserOperation
2. Bundler lo incluye en un bundle
3. El vault es un Smart Account que paga gas desde su balance
4. Paymaster podria subsidiar gas
```

**Pros:**
- Eliminacion completa del problema de gas del agente
- El vault es auto-suficiente
- UX ideal para el usuario (no necesita pensar en gas)

**Contras:**
- ERC-4337 puede NO estar implementado en Polkadot Hub (es relativamente nuevo)
- Complejidad extrema: UserOperation, Bundler, EntryPoint, Paymaster
- SentinelVault necesita reescribirse como Smart Account
- Overhead de gas significativo (bundles son mas caros que txs directas)
- Riesgo de seguridad: si el vault paga su propio gas, un atacante podria drenar gas

---

### **Recomendacion:**

| Fase | Opcion | Razon |
|---|---|---|
| **v1.1** | **Opcion A (gas tank centralizado)** | Ya funciona, cero cambios en contratos |
| **v1.2** | **Opcion B (gas tank por usuario)** | Escalar costos al usuario, cambio moderado en vault |
| **v2.0+** | Evaluar **Opcion C (relayer)** | Cuando Polkadot Hub tenga ecosistema de relayers |

---

## 5. Decision 4: Gestion de Guardian Keys

### Pregunta: ¿Como se almacena y protege la private key del agente?

La private key del guardian es el activo mas sensible del servicio. Si se compromete, el atacante puede ejecutar emergency withdraws (aunque solo hacia el safeAddress de cada usuario — no puede robar fondos).

---

### Opcion A: Private key en .env (SOLO DEMO)

```bash
AGENT_PRIVATE_KEY=0x6329307286a1e9137f...
```

**Pros:**
- Trivial de implementar
- Funciona para desarrollo/hackathon

**Contras:**
- Sin encripcion — cualquiera con acceso al servidor la lee
- Sin rotacion — si se filtra, hay que migrar TODOS los vaults
- Sin audit log — no sabes quien accedio a la key
- **Inaceptable para produccion**

---

### Opcion B: Secret Manager encriptado (RECOMENDADA para MVP)

Usar AWS Secrets Manager, GCP Secret Manager, o HashiCorp Vault.

```typescript
// Ejemplo con AWS Secrets Manager
const client = new SecretsManagerClient({ region: "us-east-1" });
const secret = await client.send(new GetSecretValueCommand({ SecretId: "chainsentinel/agent-key" }));
const privateKey = JSON.parse(secret.SecretString!).AGENT_PRIVATE_KEY;
```

**Pros:**
- Encripcion at-rest y in-transit
- Audit log de accesos
- Rotacion automatica posible
- Control de acceso via IAM

**Contras:**
- Dependencia de cloud provider
- La key sigue existiendo en memoria del proceso (no es un HSM)
- Costo: ~$0.40/secreto/mes + $0.05/10,000 llamadas API
- Latencia de ~50-200ms al arrancar el agente

---

### Opcion C: Cloud KMS para firma (RECOMENDADA para produccion)

La private key NUNCA sale del HSM. El agente envia datos a firmar y recibe la firma.

```typescript
// Ejemplo con AWS KMS
const kmsClient = new KMSClient({ region: "us-east-1" });
const signResult = await kmsClient.send(new SignCommand({
    KeyId: "alias/chainsentinel-agent",
    Message: txHash,
    SigningAlgorithm: "ECDSA_SHA_256",
}));
// Usar la firma para construir la transaccion
```

**Pros:**
- La key NUNCA sale del hardware
- Imposible de extraer — ni siquiera los admins de AWS pueden
- Audit log completo (CloudTrail)
- Cumple con SOC2, PCI-DSS, HIPAA

**Contras:**
- Complejidad: firmar txs via KMS requiere adaptar ethers.js Signer
- Latencia: ~100-500ms por firma (vs ~1ms local)
- Costo: ~$1/mes por key + $0.03/10,000 firmas
- La firma ECDSA de KMS produce DER encoding (hay que convertir a r,s,v)
- No todos los providers soportan secp256k1 (AWS KMS si, GCP Cloud HSM si)

---

### Opcion D: HSM dedicado (Enterprise)

Hardware fisico (Thales Luna, YubiHSM) que almacena keys.

**Pros:**
- Maximo nivel de seguridad
- Sin dependencia de cloud
- Cumple regulaciones financieras

**Contras:**
- Costo: $5,000-$50,000 por dispositivo
- Requiere infraestructura fisica
- Overkill para un servicio DeFi temprano

---

### **Recomendacion:**

| Fase | Opcion | Razon |
|---|---|---|
| **v1.0** (actual) | Opcion A (.env) | Demo/hackathon |
| **v1.1** | **Opcion B (Secret Manager)** | Primer paso de produccion, bajo costo |
| **v2.0** | **Opcion C (Cloud KMS)** | Cuando haya fondos reales de usuarios |

---

## 6. Decision 5: Arquitectura del Agente Multi-Vault

### Pregunta: ¿Como estructura el agente el monitoreo de N vaults?

---

### Opcion A: Un executor con array de vaults (RECOMENDADA para v1.1)

```typescript
class MultiVaultExecutor {
    private vaults: Map<string, ethers.Contract> = new Map();
    private wallet: ethers.Wallet;

    async refreshVaults(): Promise<void> {
        const vaultAddresses = await this.factory.getAllVaults();
        for (const addr of vaultAddresses) {
            if (!this.vaults.has(addr)) {
                const vault = new ethers.Contract(addr, VAULT_ABI, this.wallet);
                const guardian = await vault.guardian();
                if (guardian === this.wallet.address) {
                    this.vaults.set(addr, vault);
                }
            }
        }
    }

    async executeForVault(vaultAddr: string, assessment: ThreatAssessment): Promise<void> {
        const vault = this.vaults.get(vaultAddr);
        if (!vault) return;
        await vault.emergencyWithdrawAll(assessment.score, reason);
    }
}
```

**Pros:**
- Extension natural del executor actual
- Un solo proceso, facil de gestionar
- Comparte conexion RPC, wallet, etc.
- Refresh periodico del factory (cada N bloques)

**Contras:**
- Punto unico de falla: si el proceso muere, todos los vaults quedan sin proteccion
- Con muchos vaults (>1000), el refresh y la iteracion pueden ser lentos
- Si un emergency withdraw tarda, puede retrasar otros

---

### Opcion B: Worker pool (un worker por vault)

```typescript
// Proceso principal
const workers = new Map<string, Worker>();
for (const vault of activeVaults) {
    workers.set(vault, new Worker('./vault-worker.ts', { workerData: { vault } }));
}
```

**Pros:**
- Paralelismo real: cada vault se monitorea independientemente
- Si un worker falla, los demas siguen funcionando
- Escala horizontalmente

**Contras:**
- N workers = N conexiones RPC = posible rate limiting
- Overhead de memoria (~50MB por worker)
- Complejidad de IPC (inter-process communication)
- Overkill para <100 vaults

---

### Opcion C: Event-driven con cola de mensajes

```
Monitor → [tx detectada] → Message Queue → [vault1_worker, vault2_worker, ...]
```

**Pros:**
- Arquitectura de microservicios, maxima escalabilidad
- Resiliencia: si un worker muere, la cola retiene el mensaje
- Metrics/observabilidad por vault

**Contras:**
- Complejidad operacional masiva (RabbitMQ, Redis Streams, o SQS)
- Latencia adicional (~10-100ms por hop en la cola)
- Para un servicio DeFi de seguridad, la latencia puede ser critica
- Overkill hasta tener miles de usuarios

---

### Opcion D: Modelo mixto — monitor compartido + executor por vault

```
1 Monitor (lee bloques, analiza txs, genera assessments)
    ↓
N Executors (uno por vault, ejecutan emergency withdraw si aplica)
```

**Pros:**
- Monitor es el cuello de botella mas caro (RPC calls) — solo 1 instancia
- Executors son baratos (solo firman y envian txs cuando es necesario)
- La mayoria de las txs no disparan emergency — bajo overhead

**Contras:**
- El monitor debe saber que txs son relevantes para que vault
- Mas complejo que un solo proceso

---

### **Recomendacion:**

| Fase | Opcion | Razon |
|---|---|---|
| **v1.1** | **Opcion A (un executor, array de vaults)** | Simplicidad, compatible con <100 vaults |
| **v2.0** | **Opcion D (monitor compartido + executors)** | Cuando el volumen de vaults justifique separacion |
| **v3.0** | Evaluar **Opcion C** | Solo con miles de usuarios y equipo de infra |

---

## 7. Decision 6: Frontend Multi-Vault

### Pregunta: ¿Como descubre y gestiona el frontend los vaults del usuario?

---

### Opcion A: Query al Factory contract (RECOMENDADA)

```typescript
// Hook personalizado
function useUserVaults() {
    const { address } = useAccount();
    const { data: vaults } = useReadContract({
        address: FACTORY_ADDRESS,
        abi: FACTORY_ABI,
        functionName: "getUserVaults",
        args: [address],
    });
    return vaults as `0x${string}`[] || [];
}
```

**Pros:**
- On-chain, trustless, siempre actualizado
- No requiere backend adicional
- El factory ya tiene `getUserVaults()` en el diseno

**Contras:**
- Si el usuario tiene muchos vaults, la llamada puede ser costosa
- No incluye metadata (nombre, estado, etc.)
- Requiere que el Factory este desplegado

---

### Opcion B: Indexer off-chain (subgraph / API)

Un servicio indexa eventos `VaultCreated` y mantiene una base de datos.

**Pros:**
- Rapido — query a una API REST/GraphQL
- Puede incluir metadata, metricas, historial
- No depende de llamadas RPC

**Contras:**
- Centralizado — si el indexer falla, el frontend no puede descubrir vaults
- Complejidad adicional (The Graph, o un backend propio)
- Costo de infraestructura

---

### Arquitectura del frontend multi-vault

```
/app
├── page.tsx                    # Dashboard — muestra vault seleccionado
├── vaults/
│   ├── page.tsx                # Lista de vaults del usuario
│   └── [address]/
│       ├── page.tsx            # Dashboard de un vault especifico
│       ├── protect/page.tsx    # Configuracion de ese vault
│       └── activity/page.tsx   # Historial de actividad
├── create-vault/page.tsx       # Formulario para crear nuevo vault
└── registry/page.tsx           # Registry global (sin cambios)
```

**Componentes nuevos necesarios:**

| Componente | Funcion |
|---|---|
| `VaultList.tsx` | Lista de vaults del usuario con balance, estado, score |
| `CreateVaultForm.tsx` | Formulario: safeAddress, threshold → llama `factory.createVault()` |
| `VaultSelector.tsx` | Dropdown/modal para cambiar de vault activo |
| `VaultContext.tsx` | React Context que mantiene el vault seleccionado |

**Componentes existentes a modificar:**

| Componente | Cambio |
|---|---|
| `VaultStatus.tsx` | Recibir `vaultAddress` como prop en vez de usar constante |
| `GuardianConfig.tsx` | Recibir `vaultAddress` como prop |
| `DepositForm.tsx` | Recibir `vaultAddress` como prop |
| `WithdrawForm.tsx` | Recibir `vaultAddress` como prop |
| `Navbar.tsx` | Agregar vault selector |

---

### **Recomendacion: Opcion A (query al Factory)** para v1.1

---

## 8. Decision 7: Modelo de Negocio

### Pregunta: ¿Como se monetiza el servicio multi-usuario?

---

### Opcion A: Fee por vault creation (one-time)

```solidity
function createVault(...) external payable {
    require(msg.value >= creationFee, "Insufficient fee");
    // ... deploy vault ...
    payable(treasury).transfer(msg.value);
}
```

**Pros:** Simple, sin suscripcion. **Contras:** Ingreso no recurrente, no cubre costos operativos.

---

### Opcion B: Suscripcion mensual (off-chain)

El usuario paga via Stripe/crypto y el servicio activa/desactiva el monitoreo.

**Pros:** Ingreso recurrente, modelo SaaS probado. **Contras:** Requiere backend de pagos, complejidad.

---

### Opcion C: Fee on emergency withdraw (comision por rescate)

```solidity
function emergencyWithdrawAll(...) external onlyGuardian {
    // ... withdraw ...
    uint256 fee = totalValue * FEE_BPS / 10000; // ej: 0.5%
    payable(serviceTreasury).transfer(fee);
    payable(safeAddress).transfer(totalValue - fee);
}
```

**Pros:** El usuario solo paga cuando el servicio realmente le salva fondos. Alineamiento de incentivos perfecto. **Contras:** Si nunca hay ataques, ingreso = 0. Incentivo perverso (el servicio gana mas si hay ataques).

---

### Opcion D: Freemium (alertas gratis, auto-withdraw premium)

| Tier | Precio | Incluye |
|---|---|---|
| Free | $0 | Monitoreo + alertas (sin auto-withdraw) |
| Pro | $29/mes | Auto-withdraw + LLM analysis + Telegram alerts |
| Enterprise | Custom | Multi-chain + custom rules + SLA de respuesta |

**Pros:** Funnel de usuarios, conversion path claro. **Contras:** Usuarios gratis consumen recursos sin pagar.

---

### **Recomendacion: Opcion D (Freemium) + Opcion C (fee on rescue) como componentes**

El tier Free atrae usuarios. El tier Pro cobra suscripcion. Opcionalmente, un fee de 0.1-0.5% en rescates exitosos alinea incentivos y genera ingreso variable.

---

## 9. Plan de Implementacion por Fases

### Fase 1: Smart Contracts (v1.1) — ~1 semana

```
Prioridad: ALTA
Dependencias: Ninguna
```

**Tareas:**

1. **Agregar `transferOwnership()` a SentinelVault.sol**
   - Agregar funcion `transferOwnership(address newOwner)` con modifier `onlyOwner`
   - Emitir evento `OwnershipTransferred(oldOwner, newOwner)`
   - Actualizar tests en `SentinelVault.t.sol`

2. **Crear `VaultFactory.sol`**
   - `createVault(address safeAddress, uint256 threshold) → address`
   - `getUserVaults(address user) → address[]`
   - `getAllVaults() → address[]`
   - `getActiveVaultCount() → uint256`
   - `serviceGuardian` (address del agente) configurable por el owner del factory
   - El factory: deploya vault → setGuardian(serviceGuardian) → transferOwnership(msg.sender)
   - Tests completos en `VaultFactory.t.sol`

3. **Script de deploy: `DeployFactory.s.sol`**
   - Despliega factory con serviceGuardian = AGENT_ADDRESS
   - Deploy en Paseo testnet

4. **Tests**
   - Test: usuario crea vault → deposita → guardian puede hacer emergency withdraw
   - Test: usuario no puede acceder vault de otro usuario
   - Test: factory trackea vaults correctamente
   - Estimacion: ~15-20 tests nuevos

### Fase 2: Agent Multi-Vault (v1.1) — ~1 semana

```
Prioridad: ALTA
Dependencias: Fase 1 (factory desplegado)
```

**Tareas:**

1. **Nuevo modulo: `vault-registry.ts`**
   - Clase `VaultRegistry` que consulta el factory periodicamente
   - Metodo `refreshVaults()`: lee `getAllVaults()` del factory
   - Filtra solo vaults donde el agente es guardian
   - Cache local con TTL de N bloques

2. **Modificar `executor.ts`**
   - Reemplazar `this.vault` (singular) por `this.vaults: Map<string, Contract>`
   - `execute(assessment, vaultAddress)` recibe el vault target
   - Iterar sobre vaults cuando hay amenaza para determinar cuales estan afectados

3. **Modificar `index.ts`**
   - Reemplazar `config.vaultAddress` (string) por `config.factoryAddress` (string)
   - Instanciar `VaultRegistry` con factory address
   - Refresh de vaults cada 100 bloques (~10 minutos)

4. **Modificar `types.ts`**
   - `AgentConfig.vaultAddress` → `AgentConfig.factoryAddress`
   - Agregar `VaultInfo` interface

5. **Actualizar `.env.example`**
   - `VAULT_ADDRESS` → `FACTORY_ADDRESS` (o mantener ambos para backward compat)

### Fase 3: Frontend Multi-Vault (v1.1) — ~1 semana

```
Prioridad: MEDIA
Dependencias: Fase 1 (factory desplegado)
```

**Tareas:**

1. **Nuevo: `lib/factory.ts`**
   - ABI del VaultFactory
   - FACTORY_ADDRESS desde env var

2. **Nuevo: `hooks/useUserVaults.ts`**
   - Hook que llama `factory.getUserVaults(connectedAddress)`
   - Retorna array de vault addresses

3. **Nuevo: `context/VaultContext.tsx`**
   - React Context con `selectedVault` y `setSelectedVault`
   - Provider en layout.tsx

4. **Nuevo: `app/vaults/page.tsx`**
   - Lista de vaults del usuario
   - Balance, estado de proteccion, threshold por cada uno
   - Boton "Create New Vault"

5. **Nuevo: `app/create-vault/page.tsx`**
   - Formulario: safeAddress + threshold
   - Llama `factory.createVault()` via wagmi

6. **Nuevo: `components/VaultSelector.tsx`**
   - Dropdown en navbar para cambiar de vault
   - Muestra address abreviada + balance

7. **Modificar componentes existentes**
   - Todos reciben `vaultAddress` como prop via VaultContext
   - Eliminar import directo de VAULT_ADDRESS en componentes

8. **Routing**
   - `/vaults` → lista de vaults
   - `/vaults/[address]` → dashboard de un vault especifico
   - `/create-vault` → crear nuevo vault

### Fase 4: Testing e Integracion (v1.1) — ~3-5 dias

```
Prioridad: ALTA
Dependencias: Fases 1-3
```

**Tareas:**

1. Test E2E multi-usuario:
   - Usuario A crea vault, deposita, configura threshold
   - Usuario B crea vault, deposita, configura threshold diferente
   - Simular ataque que afecta a ambos
   - Verificar que el agente ejecuta emergency withdraw en ambos vaults
   - Verificar que fondos de A van a safeAddress_A y fondos de B a safeAddress_B

2. Test de aislamiento:
   - Verificar que A no puede acceder al vault de B
   - Verificar que emergency withdraw de un vault no afecta al otro

3. Test de frontend:
   - Conectar con wallet A → ver solo vaults de A
   - Conectar con wallet B → ver solo vaults de B
   - Crear vault → aparece en la lista

---

## 10. Riesgos y Mitigaciones

| # | Riesgo | Impacto | Probabilidad | Mitigacion |
|---|---|---|---|---|
| 1 | Bug en VaultFactory permite crear vaults con guardian incorrecto | CRITICO | Baja | Tests exhaustivos, audit del factory antes de mainnet |
| 2 | Agente no puede pagar gas para N emergency withdraws simultaneos | ALTO | Media | Monitorear balance, alertas de low balance, gas tank |
| 3 | Factory se queda sin gas del deployer | MEDIO | Media | Usuario paga el gas del deploy (es su tx) |
| 4 | Rate limiting del RPC con N vaults | MEDIO | Alta | Cache agresivo, batch calls, o nodo propio |
| 5 | Frontend se vuelve lento con muchos vaults | BAJO | Baja | Paginacion, lazy loading, virtualizar listas |
| 6 | Private key del agente comprometida | ALTO | Baja | Fondos solo van a safeAddress (mitigacion by design) |
| 7 | Usuario configura safeAddress incorrecta y pierde fondos | ALTO | Media | Warning en frontend, confirmacion doble, no permitir address(0) |
| 8 | Upgrade de vault logica rompe storage de proxies (si se usa proxy pattern) | CRITICO | Baja | Evitar proxies en v1.1, solo usar en v2.0+ con audits |

---

## Resumen de Decisiones

| # | Decision | Recomendacion v1.1 | Alternativa v2.0+ |
|---|---|---|---|
| 1 | Arquitectura de vaults | Vault individual por usuario | Minimal proxy (EIP-1167) |
| 2 | Patron de deploy | Factory simple con `new` | EIP-1167 Clones |
| 3 | Gas del agente | Gas tank centralizado | Gas tank por usuario |
| 4 | Guardian keys | Secret Manager (AWS/GCP) | Cloud KMS / HSM |
| 5 | Arquitectura del agente | Un executor con array de vaults | Monitor compartido + executors |
| 6 | Frontend multi-vault | Query al Factory contract | Indexer off-chain (subgraph) |
| 7 | Modelo de negocio | Freemium + fee on rescue | Suscripcion + enterprise |

---

## Estimacion Total

| Fase | Duracion estimada | Dependencias |
|---|---|---|
| Fase 1: Smart Contracts | ~1 semana | Ninguna |
| Fase 2: Agent Multi-Vault | ~1 semana | Fase 1 |
| Fase 3: Frontend Multi-Vault | ~1 semana | Fase 1 |
| Fase 4: Testing e Integracion | ~3-5 dias | Fases 1-3 |
| **Total v1.1** | **~3-4 semanas** | — |
