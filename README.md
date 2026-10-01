# Cotizador NeoDehesa

Cotizador online para la sala de ventas del proyecto NeoDehesa (Vitalia Inmobiliaria).

- Selector 3D del edificio: click en un departamento para cotizarlo.
- Precios de lista y con descuento (el precio base no está en la aplicación).
- Cotización en PDF de dos páginas: cotización + ficha del departamento (planta y ubicación).
- Estacionamiento (UF 450) y bodega (UF 95) como adicionales.
- Plan de pago por defecto: 10 % pie al firmar + 10 % pie en 18 cuotas + 80 % crédito hipotecario.
- Valor UF del día obtenido automáticamente (mindicador.cl), editable.
- Departamentos vendidos: se marcan en negro y no admiten nuevas cotizaciones.
- Clientes guardados y exportables a Excel.
- Registro de todas las cotizaciones emitidas, con exportación a Excel y reimpresión.

## Estructura

| Archivo | Descripción |
|---|---|
| `server.js` | Servidor Node/Express: sirve la página y la API (`/api/...`). |
| `public/index.html` | La aplicación completa (precios, fichas e imágenes embebidos). |
| `package.json` | Dependencias: `express`, `xlsx`. |
| `render.yaml` | Configuración para desplegar en Render. |
| `data/db.json` | Base de datos (se crea sola; no va al repositorio). |

## Ejecutar en local

```bash
npm install
npm start
# abre http://localhost:3000
```

## Desplegar en Render

1. En Render: **New → Web Service**, conectar este repositorio de GitHub.
2. Runtime **Node**, build `npm install`, start `node server.js` (o usar el `render.yaml` incluido como Blueprint).
3. Variables de entorno:
   - `DATA_DIR`: carpeta donde se guarda `db.json`.
   - `ADMIN_PIN` (opcional): si se define, marcar vendidos, guardar clientes y emitir cotizaciones piden ese PIN una vez por sesión.

> **Importante sobre los datos.** En el plan gratuito de Render el disco es temporal: los bloqueos, clientes y cotizaciones se pierden en cada redeploy o reinicio. Para conservarlos, agregar un **disco persistente** (plan Starter) montado por ejemplo en `/var/data` y apuntar `DATA_DIR` a esa ruta. Mientras tanto, la pestaña **Cotizaciones** tiene un botón de **respaldo** que descarga `db.json`, y `POST /api/restore` permite restaurarlo.

## API

| Método | Ruta | Uso |
|---|---|---|
| GET | `/api/state` | Bloqueos, clientes y resumen de cotizaciones. |
| POST | `/api/bloqueos` | `{ key, blocked, motivo }` marca o libera un departamento. |
| GET / POST / DELETE | `/api/clientes`, `/api/clientes/:id` | Clientes guardados. |
| GET | `/api/clientes.xlsx` | Exporta clientes a Excel. |
| GET / POST | `/api/cotizaciones`, `/api/cotizaciones/:id` | Cotizaciones emitidas (el servidor asigna el número). |
| GET | `/api/cotizaciones.xlsx` | Exporta cotizaciones a Excel. |
| GET | `/api/uf` | Valor UF del día (caché de 6 horas). |
| GET / POST | `/api/backup`, `/api/restore` | Respaldo y restauración de la base de datos. |

## Actualizar precios o fichas

`public/index.html` se genera con el script `build_cotizador.ps1` (fuera del repositorio) a partir del Excel de pricing, el logo y las imágenes de las fichas. Para cambiar la lista de precios se vuelve a generar el archivo y se hace commit.
