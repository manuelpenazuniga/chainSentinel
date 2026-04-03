# Informe de revision de remediacion de auditoria de seguridad

Fecha: 2026-04-02

## Alcance

Se revisaron los cambios pendientes en:

- `contracts/`
- `agent/`
- `frontend/`

El objetivo fue validar si las remediaciones sugeridas en la auditoria quedaron correctamente implementadas y si existen regresiones funcionales o de seguridad.

## Resumen ejecutivo

Estado general: parcialmente implementado.

Conclusion principal:

- La remediacion on-chain del `SentinelRegistry` esta bien implementada y respaldada por tests que pasan.
- La remediacion total no esta cerrada todavia porque el agente introduce problemas funcionales relevantes y la integracion de algunos cambios quedo incompleta.
- El frontend mejoro mensajes de configuracion y validaciones de entrada, pero no bloquea de forma segura interacciones cuando la configuracion es invalida.

## Validaciones ejecutadas

Se ejecutaron validaciones no destructivas:

### 1. Tests de contratos

Comando ejecutado:

```bash
forge test
```

Resultado:

- 60/60 tests pasando
- `SentinelRegistryTest`: 26/26
- `SentinelVaultTest`: 34/34

Lectura:

- Los cambios del contrato `SentinelRegistry` no rompen la suite actual.
- El control de acceso para reporters autorizados quedo correctamente cubierto por tests.

### 2. Tests del agente

Comando ejecutado:

```bash
npm test
```

Resultado:

- 8 de 9 tests fallan en `agent/test/heuristics.test.ts`
- Error principal: `context.isWhitelisted is not a function`

Lectura:

- La remediacion del agente no quedo integrada de punta a punta.
- El cambio introducido en heuristicas no fue acompañado por la actualizacion completa de tests y mocks.

## Hallazgos

## Hallazgo 1

Severidad: Alta

Titulo: deteccion incorrecta de contratos "recientes" puede generar falsos positivos

### Evidencia

- `agent/src/context.ts`, metodo `resolveContractAge`
- Se limita la busqueda historica a `2000` bloques
- `agent/src/heuristics.ts`, regla `FRESH_CONTRACT`

Puntos concretos:

- En `agent/src/context.ts` la busqueda del bloque de despliegue usa una ventana maxima de 2000 bloques.
- Si el contrato fue desplegado antes de esa ventana, el algoritmo no obtiene el bloque real de despliegue.
- En ese caso, el contrato puede quedar marcado como mucho mas nuevo de lo que realmente es.
- La regla `FRESH_CONTRACT` toma ese dato y suma score por riesgo.

### Impacto

- Contratos antiguos pueden ser clasificados como recien desplegados.
- Esto puede elevar scores de riesgo sin fundamento.
- En casos limite puede escalar alertas o contribuir a retiros de emergencia injustificados.

### Causa tecnica

La heuristica depende de una estimacion de antiguedad que no es confiable cuando el despliegue esta fuera de la ventana de busqueda o cuando el RPC falla en consultas historicas.

### Recomendacion de subsanacion

Opciones recomendadas:

1. No inferir "fresh contract" si no se puede determinar con certeza el bloque real de despliegue.
2. Cambiar la logica para devolver un estado "unknown" en vez de asumir antiguedad reciente.
3. Si el RPC no soporta busqueda historica fiable, desactivar temporalmente la regla `FRESH_CONTRACT`.
4. Agregar tests unitarios para:
   - contrato desplegado dentro de la ventana
   - contrato desplegado fuera de la ventana
   - error del RPC en bloques historicos
   - caso "unknown age"

### Criterio de aceptacion sugerido

- Un contrato antiguo nunca debe recibir score por `FRESH_CONTRACT` si su edad no pudo resolverse de forma confiable.

## Hallazgo 2

Severidad: Media

Titulo: la mejora de deteccion de flash loans no aplica correctamente al tx actual

### Evidencia

- `agent/src/monitor.ts`
- `agent/src/context.ts`
- `agent/src/heuristics.ts`

Puntos concretos:

- El analisis de transacciones corre antes de `updateWithBlock`.
- El hash del flash loan se registra dentro de `updateWithBlock`.
- La heuristica `FLASH_LOAN_PATTERN` consulta `ctx.hasFlashLoanInteraction(tx.hash)` durante el analisis.

### Impacto

- La rama `high gas + flash loan interaction` no puede activarse para la transaccion actual.
- En la practica, la regla queda reducida casi solo al chequeo por selector directo.

### Causa tecnica

Hay una dependencia temporal incorrecta entre enriquecimiento del contexto y evaluacion de heuristicas.

### Recomendacion de subsanacion

Opciones recomendadas:

1. Registrar el indicador de flash loan antes de ejecutar el analisis.
2. O eliminar `hasFlashLoanInteraction(tx.hash)` y evaluar el patron directamente sobre los datos ya disponibles del tx actual.
3. O pasar una bandera precomputada en `TransactionData` durante el enriquecimiento del bloque.

### Tests sugeridos

- Caso con selector de flash loan.
- Caso sin selector pero con criterio complementario valido.
- Caso donde el tx actual debe ser detectado sin depender del estado post-analisis.

### Criterio de aceptacion sugerido

- La heuristica debe poder detectar el flash loan del tx actual sin depender de una actualizacion posterior del contexto.

## Hallazgo 3

Severidad: Media

Titulo: integracion incompleta del cambio de whitelist rompe los tests del agente

### Evidencia

- `agent/src/heuristics.ts` ahora llama `context.isWhitelisted(...)`
- `agent/src/types.ts` agrega ese metodo a la interfaz
- `agent/test/heuristics.test.ts` no implementa ese metodo en el mock

### Impacto

- La suite del agente falla.
- La remediacion no esta cerrada a nivel de integracion.
- Se pierde confianza en la cobertura automatizada justo en la parte de heuristicas.

### Causa tecnica

Se actualizo la interfaz de produccion, pero no se actualizaron los dobles de prueba.

### Recomendacion de subsanacion

1. Actualizar `agent/test/heuristics.test.ts` para incluir `isWhitelisted: () => false`.
2. Agregar tests nuevos para el comportamiento de reduccion de score en contratos whitelisted.
3. Ejecutar `npm test` como parte obligatoria de cierre de remediacion.

### Tests minimos recomendados

- `isWhitelisted = false` no altera score.
- `isWhitelisted = true` reduce score 50%.
- El score final sigue respetando el cap de 100.

### Criterio de aceptacion sugerido

- La suite del agente debe volver a verde antes de considerar cerrada la remediacion.

## Hallazgo 4

Severidad: Baja

Titulo: el frontend informa configuracion invalida, pero no falla en modo seguro

### Evidencia

- `frontend/components/ConfigBanner.tsx`
- `frontend/lib/contracts.ts`
- `frontend/components/DepositForm.tsx`
- `frontend/components/WithdrawForm.tsx`
- `frontend/components/GuardianConfig.tsx`
- `frontend/lib/useThreatEvents.ts`

### Impacto

- Si faltan direcciones reales de contratos, el frontend puede seguir intentando leer o escribir contra `0x0000000000000000000000000000000000000000`.
- Esto no es un bug critico on-chain, pero si una UX insegura y confusa.

### Causa tecnica

Se agrego una advertencia visual, pero no se bloquearon las operaciones.

### Recomendacion de subsanacion

1. Hacer que `IS_CONFIGURED` valide no solo presencia de env vars, sino tambien que no apunten a zero address.
2. Bloquear formularios y lecturas on-chain cuando la app no este configurada correctamente.
3. Mostrar estado deshabilitado explicito en componentes dependientes de contratos.

### Criterio de aceptacion sugerido

- Con configuracion invalida, el usuario no debe poder disparar lecturas o escrituras on-chain desde la UI.

## Cambios validados como correctos

## SentinelRegistry

Los siguientes cambios quedaron bien implementados:

- Se introdujo `owner`
- Se agrego `authorizedReporters`
- `reportThreat` ahora exige reporter autorizado
- `addReporter` y `removeReporter` quedaron restringidos por `onlyOwner`
- Se agregaron tests de acceso y eventos
- El script de deploy autoriza al agente con `AGENT_ADDRESS`

Conclusion para esta parte:

- Remediacion correcta y validada por tests.

## SentinelVault

La suite actual sigue pasando completa.

Esto indica que:

- No se detectaron regresiones funcionales por los cambios revisados alrededor del registry y la integracion general.
- La invariante de seguridad principal del guardian sigue cubierta por tests.

Nota:

- Que `SentinelVault` pase tests no implica que el agente este tomando decisiones correctas.
- El riesgo residual principal ahora esta en la capa off-chain de deteccion.

## Priorizacion sugerida

Orden recomendado de correccion:

1. Corregir Hallazgo 3
   Motivo: restaurar la suite del agente para recuperar señal automatizada.

2. Corregir Hallazgo 1
   Motivo: evita falsos positivos serios con impacto operativo.

3. Corregir Hallazgo 2
   Motivo: completa la remediacion de flash loans para que la heuristica funcione como se espera.

4. Corregir Hallazgo 4
   Motivo: mejora robustez y evita interacciones erroneas desde UI.

## Definicion practica de cierre

La remediacion puede considerarse cerrada cuando se cumpla todo lo siguiente:

- `forge test` pasa completo
- `npm test` pasa completo
- Existen tests nuevos para whitelist y resolucion de edad de contratos
- La heuristica `FRESH_CONTRACT` no produce falsos positivos por falta de datos confiables
- La deteccion de flash loans aplica correctamente al tx actual
- El frontend bloquea interacciones cuando la configuracion es invalida

## Conclusion final

La auditoria no puede considerarse totalmente remediada todavia.

Estado por area:

- Contratos on-chain: correcto
- Agente off-chain: incompleto
- Frontend: parcialmente corregido

La prioridad deberia estar en cerrar la integracion y la logica del agente antes de dar por finalizada la remediacion.
