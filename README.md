# Cotizador Vía Trapenses

Cotizador online para la sala de ventas del proyecto Vía Trapenses (Vitalia Inmobiliaria).

- Acceso con usuario y contraseña. Dos roles: **vendedor** (solo el cotizador) y **admin** (cotizador + administración).
- Selector 3D del edificio: click en un departamento para cotizarlo.
- Precios de lista y con descuento (el precio base no está en la aplicación).
- Cotización en PDF de dos páginas: cotización + ficha del departamento (planta y ubicación).
- Estacionamiento (UF 450) y bodega (UF 95) como adicionales.
- Plan de pago por defecto: 10 % pie al firmar + 10 % pie en 18 cuotas + 80 % crédito hipotecario.
- Valor UF del día obtenido automáticamente (mindicador.cl, con respaldo en boostr.cl y gael.cloud), editable.
- Departamentos vendidos: se marcan en negro y no admiten nuevas cotizaciones.
- Clientes guardados y exportables a Excel.
- Registro de todas las cotizaciones emitidas, con exportación a Excel y reimpresión.
- Ventas: cada departamento vendido tiene un estado comercial (**Bloqueado**, **Reservado**, **Promesa**) que se puede cambiar, un cliente asociado (de la lista guardada o nuevo) y una nota. Filtro por estado y exportación a Excel.
- **Administración** (solo admin): usuarios y su actividad (en línea / última actividad / últimos ingresos), e **informe de ventas** con cotizaciones y clientes nuevos por semana (lunes a domingo), avance de ventas, vendidos por tipología, mapa 3D de disponibilidad (blanco = disponible, negro = vendido), tablas de resumen y exportación a PDF.

## Usuarios

Los usuarios (nombre, rol, datos de vendedor) están en `server.js` (`DEFAULT_USERS`). **Las contraseñas no están en el código**: cada usuario la lee de una variable de entorno que se define en Render (Environment):

| Usuario | Rol | Variable de entorno con la contraseña |
|---|---|---|
| Leonor | vendedor | `CLAVE_LEONOR` |
| Exequiel | admin | `CLAVE_EXEQUIEL` |

Si una variable no está definida, ese usuario no puede ingresar (el servidor lo avisa al arrancar). Para agregar o cambiar usuarios sin tocar el código, definir la variable `USERS` con un JSON:

```json
[
  { "usuario": "Leonor",   "clave": "…", "rol": "vendedor", "nombre": "Leonor Olavarria", "fono": "+56 9 …", "email": "…@ivitalia.cl" },
  { "usuario": "Exequiel", "clave": "…", "rol": "admin",    "nombre": "Exequiel" }
]
```

El nombre, fono y email del usuario se usan como datos del vendedor por defecto en la cotización. La sesión dura 30 días sin uso; "Salir" la cierra. Tras 8 intentos fallidos seguidos desde una misma IP, el ingreso se bloquea 10 minutos.

## Estructura

| Archivo | Descripción |
|---|---|
| `server.js` | Servidor Node/Express: login, sesiones, página y API (`/api/...`). |
| `public/index.html` | La aplicación completa (precios, fichas e imágenes embebidos). |
| `public/login.html` | Página de ingreso. |
| `package.json` | Dependencias: `express`, `xlsx`. |
| `render.yaml` | Configuración para desplegar en Render. |
| `data/db.json` | Base de datos (se crea sola; no va al repositorio). Incluye sesiones y registro de ingresos. |

## Ejecutar en local

```powershell
npm install
$env:CLAVE_LEONOR = "..."
$env:CLAVE_EXEQUIEL = "..."
npm start
# abre http://localhost:3000
```

## Desplegar en Render

1. En Render: **New → Web Service**, conectar este repositorio de GitHub.
2. Runtime **Node**, build `npm install`, start `node server.js` (o usar el `render.yaml` incluido como Blueprint).
3. Variables de entorno:
   - `DATA_DIR`: carpeta donde se guarda `db.json`. Con el disco persistente debe ser su ruta de montaje (`/var/data`).
   - `CLAVE_LEONOR` y `CLAVE_EXEQUIEL`: contraseñas de los usuarios (obligatorias para poder ingresar).
   - `USERS` (opcional): lista completa de usuarios y contraseñas en JSON (ver arriba).
   - `ADMIN_PIN` (opcional): si se define, marcar vendidos, guardar clientes y emitir cotizaciones piden además ese PIN una vez por sesión.

> **Importante sobre los datos.** En el plan gratuito de Render el disco es temporal: los bloqueos, clientes, cotizaciones y sesiones se pierden en cada redeploy o reinicio. Para conservarlos, agregar un **disco persistente** (plan Starter) montado por ejemplo en `/var/data` y apuntar `DATA_DIR` a esa ruta. Mientras tanto, la pestaña **Administración** tiene un botón de **respaldo** que descarga `db.json`, y `POST /api/restore` permite restaurarlo.

## API

Todas las rutas (salvo login, `/api/me` y `/healthz`) exigen sesión; sin ella responden `401 {"error":"login"}` y la página redirige a `/login.html`.

| Método | Ruta | Uso |
|---|---|---|
| POST | `/api/login`, `/api/logout` | Ingreso (`{ usuario, clave }`) y salida. |
| GET | `/api/me` | Usuario de la sesión actual. |
| GET | `/api/state` | Usuario, bloqueos, clientes y resumen de cotizaciones. |
| GET | `/api/admin/usuarios` | (admin) Usuarios, estado en línea, última actividad y últimos ingresos. |
| POST | `/api/precios/xlsx` | (admin) Genera el Excel de la lista de precios con estado de venta y comprador (las filas las arma la página). |
| POST | `/api/precios/parse` | (admin) Lee un Excel subido (base64) y devuelve sus filas. |
| POST / DELETE | `/api/precios` | (admin) Guarda la lista de precios cargada (`{ precios: { "6-01-O": { lista, desc } } }`) o vuelve a la lista original. |
| POST | `/api/bloqueos` | `{ key, blocked, estado, cliente, nota }` registra o actualiza una venta (`blocked: false` la libera). |
| GET / POST / DELETE | `/api/clientes`, `/api/clientes/:id` | Clientes guardados. |
| GET | `/api/clientes.xlsx` | Exporta clientes a Excel. |
| GET / POST | `/api/cotizaciones`, `/api/cotizaciones/:id` | Cotizaciones emitidas (el servidor asigna el número). |
| DELETE | `/api/cotizaciones/:id` | (admin) Elimina una cotización. |
| GET | `/api/ventas.xlsx` | Exporta las ventas (estado, cliente, nota) a Excel. |
| GET | `/api/cotizaciones.xlsx` | Exporta cotizaciones a Excel. |
| GET | `/api/uf` | Valor UF del día (caché de 6 horas). |
| GET / POST | `/api/backup`, `/api/restore` | (admin) Respaldo y restauración de la base de datos. |

## Lista de precios desde Administración

En la pestaña Administración, la sección **Lista de precios** permite descargar un Excel con todas las unidades (precio de lista, precio con descuento, estado de venta y comprador) y cargar un Excel con el mismo formato para cambiar precios de lista o descuentos. La página muestra una vista previa de los cambios antes de aplicarlos. Los precios cargados se guardan en `db.json` (`precios`) y reemplazan a los de `index.html` al cotizar; las ventas registradas y las cotizaciones ya emitidas no se modifican. "Volver a la lista original" elimina los precios cargados.

Columnas que se leen al cargar: **Piso**, **Unidad**, **Lado** (o **Código**, p. ej. `601O`) y **Precio lista UF**, **Precio descuento UF**. Si vienen las columnas **Precio venta UF**, **Estacionamientos** o **Bodegas**, actualizan esos campos en las ventas ya registradas (los mismos que la vendedora edita en la pestaña Ventas). Las demás columnas se ignoran.

## Fichas por piso

Además de las fichas base (tipos A a I), `public/index.html` incluye fichas propias para el **1° piso con jardín** (claves `A1`, `C1`, `D1`, `E1`, `F1`) y el **6° piso con azotea** (`A6`, `B6`, `C6`, `D6`, `E6`, `F6`, `G6`, `I6`). La función `fichaFor(u)` elige la variante según piso, patio y azotea; el 10-O del 6° piso (tipo H en la lista de precios) usa la ficha `I6`, que es la única con azotea para esa unidad. La cotización y la ficha muestran además la superficie de jardín o azotea y el total con ella.

## Actualizar precios o fichas

`public/index.html` se genera con el script `build_cotizador.ps1` (fuera del repositorio) a partir del Excel de pricing, el logo y las imágenes de las fichas. Para cambiar la lista de precios se vuelve a generar el archivo y se hace commit. **Atención:** la lógica de la aplicación (login, administración, informe) vive en el mismo archivo; si se regenera con el script hay que conservar esos cambios.
