# Servidor multijugador — El Supermercado del Silencio

Sin dependencias: solo necesitas **Node 18 o más nuevo**.

## Usarlo

```
npm start
```

1. Abre `http://localhost:3000` (el servidor entrega el juego).
2. Tus amigos en tu misma red abren `http://TU-IP:3000` (el servidor la imprime al arrancar).
3. En el menú del juego, creen/únanse a la misma sala con el mismo número de 4 dígitos.

Para jugar por internet, sube esta carpeta a cualquier hosting de Node (Render, Railway, Fly.io…) con
comando de inicio `npm start`; usa solo `PORT` del entorno. Con https el juego usa `wss://` solo.

## Si abres el HTML suelto (sin pasar por el servidor)

Agrega la dirección del servidor: `El_Supermercado_del_Silencio_5.html?server=ws://TU-IP:3000/ws`

## Qué hace

- Salas por nombre (`sala-1234`), hasta 12 jugadores cada una.
- Reparte posiciones/estado (presencia) 10 veces por segundo y reenvía eventos (chat, voz, disparos, inicio de partida).
- Límites: 64 KB por mensaje, 120 mensajes por segundo por jugador.
- `GET /health` responde `ok`.

Dentro de Claude (artifact publicado) el juego sigue usando las salas de Claude; este servidor solo se usa
cuando esas no existen.
