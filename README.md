# VTEX Feeds (tiendas pequeñas)

Genera cada hora los feeds de **Meta**, **Google Merchant Center**, **TikTok** y **Pinterest** desde las APIs públicas de VTEX.

- Sin AppKey/AppToken, sin Google Sheets, sin Outlook y **sin tarjeta de crédito** (GitHub Actions + GitHub Pages gratis).
- Precio igual al front: `Price + Tax` informado por VTEX → total en 1 cuota → `taxPercentage` → `ajuste_precio` manual.
- Tiendas de cualquier tamaño. La API pública solo pagina 2.500 productos, así que los catálogos grandes se dividen automáticamente por rangos de precio (`fq=P:[min TO max]`) y se deduplican.
- Frecuencia automática:
  - **menos de 2.500 productos → cada hora**
  - **2.500 productos o más → una vez al día**
  - Se puede forzar por tienda con `"frecuencia_horas"`.
- Si VTEX falla o devuelve menos de la mitad de SKUs que la vez anterior, se conservan los feeds anteriores.

## URLs de los feeds

```
https://<usuario>.github.io/<repositorio>/<slug>/meta.csv
https://<usuario>.github.io/<repositorio>/<slug>/google.xml
https://<usuario>.github.io/<repositorio>/<slug>/tiktok.csv
https://<usuario>.github.io/<repositorio>/<slug>/pinterest.csv   ← imágenes 1000×1500
https://<usuario>.github.io/<repositorio>/<slug>/estado.json   ← auditoría
```

## Instalación (una sola vez)

1. Crear una cuenta en [github.com](https://github.com) con cualquier correo (el corporativo sirve).
2. **New repository** → nombre `vtex-feeds` → **Public** → Create.
   (GitHub Pages gratis solo funciona con repositorios públicos. Los feeds contienen solo datos que ya son públicos en cada tienda.)
3. **Add file → Upload files** y subir: `generar-feeds.js`, `tiendas.json`, `README.md` y la carpeta `.github/workflows/feeds.yml`
   (si el navegador no sube la carpeta oculta, usar **Add file → Create new file** con el nombre `.github/workflows/feeds.yml` y pegar su contenido).
4. **Settings → Pages → Source: GitHub Actions**.
5. **Actions → Feeds VTEX → Run workflow**. Al terminar (≈1 min) abrir la URL de `estado.json`.
6. Registrar las URLs en cada plataforma con frecuencia **cada hora**:
   - Meta Commerce Manager → Catálogo → Orígenes de datos → Feed de datos → Programado → `meta.csv`
   - TikTok Catalog Manager → Agregar productos → Programar feed de datos → `tiktok.csv`
   - Google Merchant Center → Productos → Fuentes → Agregar → Archivo desde URL → `google.xml`
   - Pinterest Business → Catálogos → Crear catálogo → Fuente de datos → URL → `pinterest.csv`

## Agregar una tienda

Editar `tiendas.json` en GitHub (ícono del lápiz) y agregar un bloque:

```json
{
  "slug": "mitienda",
  "nombre": "Mi Tienda",
  "account": "mitiendaco",
  "dominio": "https://www.mitienda.com.co",
  "moneda": "COP",
  "sc": 1,
  "marca": "Mi Tienda",
  "descripcion_default": "",
  "ajuste_precio": 1,
  "feeds": ["meta", "google", "tiktok", "pinterest"]
}
```

| Campo | Uso |
|---|---|
| `account` | Cuenta VTEX (lo que va antes de `.vtexcommercestable.com.br`) |
| `sc` | Política comercial / canal de venta |
| `region_id` | Opcional, si el precio depende de la región |
| `marca` | Si se deja vacío usa la marca de cada producto en VTEX |
| `ajuste_precio` | Solo se aplica cuando VTEX **no** informa impuesto. Ej.: `1.19` si la tienda suma el IVA en el front |
| `google_product_category` | Opcional, ID de la taxonomía de Google |
| `frecuencia_horas` | Opcional. Por defecto 1 h (menos de 2.500 productos) o 24 h (2.500 o más) |
| `activo` | `false` para pausar la tienda |

En `estado.json`, `fuente_precio` indica de dónde salió cada precio. Si aparece `base`, esos SKUs no traen impuesto en la API: comparar con el front y ajustar `ajuste_precio`.

## Probar en el computador

```
node generar-feeds.js                     # tiendas a las que les toca según su frecuencia
node generar-feeds.js papajohns           # solo una
node generar-feeds.js papajohns --forzar  # ignora la frecuencia
```

Los archivos quedan en `public/<slug>/`.

## Notas

- El cron de GitHub puede retrasarse algunos minutos en horas de alta demanda.
- Para tiendas grandes, programar la descarga en Meta/TikTok/Pinterest/Google **una vez al día** (no cada hora): el feed no cambia más seguido y así no se consume el ancho de banda de GitHub Pages (límite blando de 100 GB/mes y 1 GB por sitio; cada archivo debe pesar menos de 100 MB).
- GitHub desactiva los workflows programados de un repositorio sin commits durante 60 días; envía un correo antes y se reactiva con un clic.
- Si una ejecución falla, GitHub envía un correo al dueño del repositorio.
