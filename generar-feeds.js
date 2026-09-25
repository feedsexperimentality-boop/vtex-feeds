#!/usr/bin/env node
// Genera feeds de catálogo para Meta, Google Merchant Center, TikTok y Pinterest
// desde las APIs públicas de VTEX. No usa AppKey ni AppToken.
// Uso: node generar-feeds.js [slug] [--forzar]
'use strict';

const fs = require('fs');
const path = require('path');

const RAIZ = __dirname;
const SALIDA = path.join(RAIZ, 'public');
const PAGINA = 50;
const LIMITE_VTEX = Number(process.env.LIMITE_VTEX) || 2500; // tope de _from/_to en Catalog Search
const UMBRAL_GRANDE = 2500; // desde aquí la tienda se actualiza una vez al día
const PARALELO = 4;
const PRECIO_MAXIMO = 1e9;
const MAX_IMAGENES = 4; // principal + 3 adicionales por SKU
const HISTORIAL = 30; // actualizaciones que se muestran en la app
const SIN_DECIMALES = ['COP', 'CLP', 'PYG', 'JPY', 'KRW'];

async function main() {
  const args = process.argv.slice(2);
  const forzar = args.includes('--forzar');
  const filtro = args.find((a) => !a.startsWith('--'));
  const tiendas = JSON.parse(fs.readFileSync(path.join(RAIZ, 'tiendas.json'), 'utf8'));
  fs.mkdirSync(SALIDA, { recursive: true });
  fs.writeFileSync(path.join(SALIDA, 'robots.txt'), 'User-agent: *\nDisallow: /\n');
  fs.writeFileSync(path.join(SALIDA, '.nojekyll'), '');

  // Las tiendas pequeñas van primero para que su actualización horaria no espere a las grandes.
  const pendientes = tiendas
    .filter((t) => t.activo !== false && (!filtro || t.slug === filtro))
    .map((t) => ({ t, previo: leerJson(path.join(SALIDA, t.slug, 'estado.json')) }))
    .sort((a, b) => productosPrevios(a.previo) - productosPrevios(b.previo));

  let errores = 0;
  for (const { t, previo } of pendientes) {
    const horas = frecuenciaHoras(t, previo);
    if (!forzar && !tocaActualizar(previo, horas)) {
      console.log(`[${t.slug}] al día (se actualiza cada ${horas} h; última: ${previo.actualizado})`);
      continue;
    }
    try {
      await generarTienda(t, previo);
    } catch (error) {
      errores++;
      console.error(`[${t.slug}] ERROR: ${error.message}. Se conservan los feeds anteriores.`);
    }
  }
  escribirIndice(tiendas.filter((t) => t.activo !== false));
  if (errores) process.exitCode = 1;
}

// ---------- Página principal ----------

const FEEDS_INDICE = [
  ['meta', 'Meta', 'meta.csv'], ['tiktok', 'TikTok', 'tiktok.csv'],
  ['pinterest', 'Pinterest', 'pinterest.csv'], ['google', 'Google Merchant Center', 'google.xml'],
];

// El cron corre en el minuto 7 de cada hora; las tiendas diarias pueden correr desde las 23,5 h.
function proximaActualizacion(estado) {
  const horas = estado.frecuencia_horas || 1;
  const desde = Date.parse(estado.actualizado) + (horas > 1 ? horas * 3600e3 - 30 * 60e3 : 0);
  const proxima = new Date(desde);
  proxima.setUTCMinutes(7, 0, 0);
  if (proxima.getTime() <= desde) proxima.setTime(proxima.getTime() + 3600e3);
  return proxima.toISOString();
}

function textoCambios(c) {
  if (!c) return '—';
  if (c.primera_vez) return 'Primera publicación';
  const partes = [];
  if (c.modificados) partes.push(`${c.modificados} modificados`);
  if (c.nuevos) partes.push(`${c.nuevos} nuevos`);
  if (c.eliminados) partes.push(`${c.eliminados} eliminados`);
  return partes.length ? partes.join(', ') : 'Sin cambios';
}

function escribirIndice(tiendas) {
  const repo = process.env.GITHUB_REPOSITORY || 'feedsexperimentality-boop/vtex-feeds';
  const [dueno, nombreRepo] = repo.split('/');
  const base = `https://${dueno}.github.io/${nombreRepo}`;
  const html = (v) => String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  const tarjetas = tiendas.map((t) => {
    const estado = leerJson(path.join(SALIDA, t.slug, 'estado.json'));
    const feeds = t.feeds || FEEDS_INDICE.map((f) => f[0]);
    const filas = FEEDS_INDICE.filter(([id]) => feeds.includes(id)).map(([, nombre, archivo]) => {
      const url = `${base}/${t.slug}/${archivo}`;
      return `<div class="fila"><span class="plataforma">${nombre}</span>` +
        `<input readonly value="${html(url)}" aria-label="Enlace ${nombre}">` +
        `<button type="button" data-copiar="${html(url)}">Copiar</button></div>`;
    }).join('');
    const fecha = (iso) => `<time datetime="${html(iso)}">${html(iso)}</time>`;
    const numero = (n) => Number(n || 0).toLocaleString('es-CO');
    const historial = (estado && estado.historial) || [];
    const resumen = estado ? `
<div class="act">
  <div><span>Última actualización</span><strong>${fecha(estado.actualizado)}</strong></div>
  <div><span>Próxima (aprox.)</span><strong data-proxima="${html(proximaActualizacion(estado))}">${fecha(proximaActualizacion(estado))}</strong></div>
  <div><span>Cambios</span><strong>${textoCambios(estado.cambios)}</strong></div>
  <div><span>SKUs</span><strong>${numero(estado.skus)} · ${numero(estado.en_stock)} en stock</strong></div>
</div>
<p class="resumen">Se actualiza cada ${estado.frecuencia_horas === 1 ? 'hora' : `${estado.frecuencia_horas} h`} · <a href="${base}/${t.slug}/estado.json" target="_blank">estado técnico</a></p>
${historial.length ? `<details><summary>Historial de actualizaciones (${historial.length})</summary><table>
<thead><tr><th>Fecha</th><th>SKUs</th><th>En stock</th><th>Cambios</th></tr></thead><tbody>
${historial.map((h) => `<tr><td>${fecha(h.fecha)}</td><td>${numero(h.skus)}</td><td>${numero(h.en_stock)}</td><td>${textoCambios(h)}</td></tr>`).join('\n')}
</tbody></table></details>` : ''}`
      : '<p class="resumen">Generando los feeds por primera vez…</p>';
    const aviso = estado && estado.fuente_precio && estado.fuente_precio.base
      ? `<p class="aviso">${estado.fuente_precio.base} SKUs sin impuesto en la API: revisa que el precio coincida con la tienda.</p>` : '';
    return `<section class="tienda"><header><h2>${html(t.nombre)}</h2>` +
      `<a href="${html(t.dominio)}" target="_blank" rel="noopener">${html(t.dominio.replace(/^https?:\/\//, ''))}</a></header>` +
      `${resumen}${aviso}${filas}</section>`;
  }).join('\n');

  escribir(path.join(SALIDA, 'index.html'), `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Feeds VTEX</title>
<style>
:root { --fondo:#f6f7f9; --tarjeta:#fff; --texto:#1b1f24; --suave:#5b636e; --borde:#dde1e6; --acento:#1f6feb; --aviso:#9a6700; --error:#cf222e; }
@media (prefers-color-scheme: dark) { :root { --fondo:#0d1117; --tarjeta:#161b22; --texto:#e6edf3; --suave:#9aa4af; --borde:#30363d; --acento:#4493f8; --aviso:#d29922; --error:#f85149; } }
* { box-sizing: border-box; }
body { margin:0; background:var(--fondo); color:var(--texto); font:15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width:880px; margin:0 auto; padding:32px 16px 64px; }
.top { display:flex; flex-wrap:wrap; gap:12px; align-items:center; justify-content:space-between; margin-bottom:8px; }
h1 { margin:0; font-size:24px; }
.intro { color:var(--suave); margin:0 0 24px; }
.boton { background:var(--acento); color:#fff; text-decoration:none; padding:10px 16px; border-radius:8px; font-weight:600; }
.tienda { background:var(--tarjeta); border:1px solid var(--borde); border-radius:12px; padding:18px; margin-bottom:16px; }
.tienda header { display:flex; flex-wrap:wrap; gap:4px 12px; align-items:baseline; }
h2 { margin:0; font-size:18px; }
a { color:var(--acento); }
.resumen { color:var(--suave); font-size:13px; margin:4px 0 12px; }
.aviso { color:var(--aviso); font-size:13px; margin:0 0 12px; }
.fila { display:grid; grid-template-columns:170px 1fr auto; gap:8px; align-items:center; margin-top:8px; }
.plataforma { font-weight:600; font-size:14px; }
input { width:100%; min-width:0; font:13px ui-monospace, Consolas, monospace; padding:7px 9px; border:1px solid var(--borde); border-radius:6px; background:var(--fondo); color:var(--texto); }
button { font:inherit; font-size:13px; padding:7px 12px; border-radius:6px; border:1px solid var(--borde); background:var(--tarjeta); color:var(--texto); cursor:pointer; }
button.ok { border-color:var(--acento); color:var(--acento); }
.pie { color:var(--suave); font-size:13px; margin-top:24px; }
.act { display:grid; grid-template-columns:repeat(4, 1fr); gap:8px; margin:12px 0 6px; }
.act div { background:var(--fondo); border:1px solid var(--borde); border-radius:8px; padding:8px 10px; min-width:0; }
.act span { display:block; color:var(--suave); font-size:12px; }
.act strong { display:block; font-size:14px; font-weight:600; }
.act strong.atrasada { color:var(--error); }
details { margin:0 0 10px; font-size:13px; }
summary { cursor:pointer; color:var(--acento); }
table { width:100%; border-collapse:collapse; margin-top:8px; }
th, td { text-align:left; padding:5px 8px; border-bottom:1px solid var(--borde); }
th { color:var(--suave); font-weight:600; }
@media (max-width:700px) { .act { grid-template-columns:1fr 1fr; } }
@media (max-width:600px) { .fila { grid-template-columns:1fr auto; } .plataforma { grid-column:1 / -1; } }
</style>
</head>
<body>
<main>
<div class="top"><h1>Feeds VTEX</h1>
<a class="boton" href="https://github.com/${repo}/issues/new?template=nueva-tienda.yml" target="_blank" rel="noopener">+ Agregar tienda</a></div>
<p class="intro">Copia el enlace de cada plataforma y pégalo como feed programado. Menos de 2.500 productos: se actualiza cada hora; desde 2.500: una vez al día.</p>
${tarjetas || '<p>Aún no hay tiendas. Pulsa “Agregar tienda”.</p>'}
<p class="pie"><a href="https://github.com/${repo}/actions" target="_blank" rel="noopener">Ver actualizaciones</a> ·
<a href="https://github.com/${repo}/edit/main/tiendas.json" target="_blank" rel="noopener">Editar tiendas</a></p>
</main>
<script>
document.querySelectorAll('time').forEach(function (t) {
  var d = new Date(t.getAttribute('datetime'));
  if (!isNaN(d)) t.textContent = d.toLocaleString('es-CO', { dateStyle: 'medium', timeStyle: 'short' });
});
// Si la próxima actualización ya debió ocurrir hace más de 2 horas, se marca como atrasada.
document.querySelectorAll('[data-proxima]').forEach(function (el) {
  if (Date.now() - new Date(el.getAttribute('data-proxima')).getTime() > 2 * 3600e3) {
    el.classList.add('atrasada');
    el.insertAdjacentText('beforeend', ' · atrasada');
  }
});
document.addEventListener('click', function (e) {
  var b = e.target.closest('[data-copiar]');
  if (!b) return;
  var listo = function () { b.textContent = 'Copiado'; b.classList.add('ok'); setTimeout(function () { b.textContent = 'Copiar'; b.classList.remove('ok'); }, 1500); };
  if (navigator.clipboard) navigator.clipboard.writeText(b.dataset.copiar).then(listo, function () { b.previousElementSibling.select(); });
  else { b.previousElementSibling.select(); document.execCommand('copy'); listo(); }
});
</script>
</body>
</html>
`);
}

function productosPrevios(previo) {
  return (previo && previo.productos) || 0;
}

function frecuenciaHoras(t, previo) {
  if (Number(t.frecuencia_horas) > 0) return Number(t.frecuencia_horas);
  return productosPrevios(previo) >= UMBRAL_GRANDE ? 24 : 1;
}

function tocaActualizar(previo, horas) {
  if (horas <= 1 || !previo || !previo.actualizado) return true;
  const transcurrido = Date.now() - Date.parse(previo.actualizado);
  // Margen de 30 min para los retrasos del cron de GitHub.
  return !(transcurrido < horas * 3600e3 - 30 * 60e3);
}

async function generarTienda(t, previo) {
  const inicio = Date.now();
  const items = [];
  const fuentes = {};
  const productos = new Set();
  const skus = new Set();
  const rastreo = await rastrear(t, (lote) => {
    for (const p of lote) {
      productos.add(p.productId);
      agregarItems(p, t, items, skus, fuentes);
    }
  });
  if (!items.length) throw new Error('VTEX no devolvió SKUs publicables');

  // Protección: una respuesta parcial de VTEX no debe vaciar el catálogo en las plataformas.
  if (previo && previo.skus && items.length < previo.skus * 0.5) {
    throw new Error(`solo ${items.length} SKUs frente a ${previo.skus} de la última publicación`);
  }

  const dir = path.join(SALIDA, t.slug);
  fs.mkdirSync(dir, { recursive: true });
  const feeds = t.feeds || ['meta', 'google', 'tiktok', 'pinterest'];
  if (feeds.includes('meta')) escribir(path.join(dir, 'meta.csv'), feedMeta(items, t));
  if (feeds.includes('google')) escribir(path.join(dir, 'google.xml'), feedGoogle(items, t));
  if (feeds.includes('tiktok')) escribir(path.join(dir, 'tiktok.csv'), feedTikTok(items, t));
  if (feeds.includes('pinterest')) escribir(path.join(dir, 'pinterest.csv'), feedPinterest(items, t));

  const cambios = registrarCambios(dir, items);
  const segundos = Math.round((Date.now() - inicio) / 1000);
  const actualizado = new Date().toISOString();
  const enStock = items.filter((i) => i.disponible).length;
  const historial = [{ fecha: actualizado, skus: items.length, en_stock: enStock, ...cambios }]
    .concat((previo && previo.historial) || []).slice(0, HISTORIAL);
  escribir(path.join(dir, 'estado.json'), JSON.stringify({
    tienda: t.nombre,
    actualizado,
    frecuencia_horas: frecuenciaHoras(t, { productos: productos.size }),
    duracion_segundos: segundos,
    productos_vtex: rastreo.total,
    productos: productos.size,
    grupos_de_precio: rastreo.grupos,
    skus: items.length,
    en_stock: enStock,
    cambios,
    fuente_precio: fuentes,
    feeds,
    historial,
  }, null, 2));

  console.log(`[${t.slug}] ${productos.size}/${rastreo.total} productos, ${items.length} SKUs en ${segundos}s` +
    ` (${rastreo.grupos} grupos) · cambios: ${JSON.stringify(cambios)} · precio: ${JSON.stringify(fuentes)}`);
  if (fuentes.base) {
    console.warn(`[${t.slug}] AVISO: ${fuentes.base} SKUs sin impuesto en la API; revisa "ajuste_precio" en tiendas.json`);
  }
}

// Compara cada SKU con la publicación anterior (precio, oferta, stock, título, link e imágenes)
// para mostrar en la app cuántos cambiaron realmente.
function registrarCambios(dir, items) {
  const archivo = path.join(dir, 'huellas.json');
  const anteriores = leerJson(archivo);
  const actuales = {};
  for (const i of items) {
    actuales[i.id] = [i.precio, i.oferta, i.disponible, i.titulo, i.link, i.imagenes.join(' ')].join('|');
  }
  escribir(archivo, JSON.stringify(actuales));
  if (!anteriores) return { primera_vez: true, nuevos: items.length, modificados: 0, eliminados: 0 };
  let nuevos = 0;
  let modificados = 0;
  for (const id of Object.keys(actuales)) {
    if (!(id in anteriores)) nuevos++;
    else if (anteriores[id] !== actuales[id]) modificados++;
  }
  const eliminados = Object.keys(anteriores).filter((id) => !(id in actuales)).length;
  return { nuevos, modificados, eliminados };
}

// ---------- VTEX ----------

async function pedir(url, intentos = 4) {
  for (let intento = 1; ; intento++) {
    try {
      const respuesta = await fetch(url, { headers: { Accept: 'application/json' } });
      if (!respuesta.ok) throw new Error(`HTTP ${respuesta.status} en ${url.split('?')[0]}`);
      return respuesta;
    } catch (error) {
      if (intento >= intentos) throw error;
      await new Promise((resolve) => setTimeout(resolve, 3000 * intento));
    }
  }
}

function urlBusqueda(t, fq, desde, hasta) {
  const query = new URLSearchParams({ _from: desde, _to: hasta, sc: t.sc || 1 });
  if (fq) query.set('fq', fq);
  if (t.region_id) query.set('regionId', t.region_id);
  // El firewall de VTEX rechaza "+" como espacio en fq; se envía %20.
  const qs = String(query).replace(/\+/g, '%20');
  return `https://${t.account}.vtexcommercestable.com.br/api/catalog_system/pub/products/search?${qs}`;
}

// VTEX informa el total en el encabezado "resources: 0-0/13000".
async function contar(t, fq) {
  const respuesta = await pedir(urlBusqueda(t, fq, 0, 0));
  await respuesta.arrayBuffer();
  const match = String(respuesta.headers.get('resources') || '').match(/\/(\d+)$/);
  if (!match) throw new Error('VTEX no informó el total de productos');
  return Number(match[1]);
}

// La API pública no pagina más allá de 2.500 productos. Los catálogos grandes
// se dividen por rangos de precio hasta que cada grupo quede por debajo del tope.
async function dividirPorPrecio(t, min, max) {
  const fq = `P:[${min} TO ${max}]`;
  const total = await contar(t, fq);
  if (total === 0) return [];
  if (total <= LIMITE_VTEX) return [{ fq, total }];
  if (max - min < 2) throw new Error(`más de ${LIMITE_VTEX} productos con precio cercano a ${min}; no se puede dividir`);
  const medio = Math.floor((min + max) / 2);
  return [...await dividirPorPrecio(t, min, medio), ...await dividirPorPrecio(t, medio, max)];
}

async function rastrear(t, alRecibirLote) {
  const total = await contar(t, '');
  const grupos = total <= LIMITE_VTEX ? [{ fq: '', total }] : await dividirPorPrecio(t, 0, PRECIO_MAXIMO);
  const paginas = [];
  for (const g of grupos) {
    for (let desde = 0; desde < g.total; desde += PAGINA) paginas.push({ fq: g.fq, desde });
  }
  await enParalelo(paginas, PARALELO, async ({ fq, desde }) => {
    const lote = await (await pedir(urlBusqueda(t, fq, desde, desde + PAGINA - 1))).json();
    if (!Array.isArray(lote)) throw new Error('respuesta inesperada de VTEX');
    alRecibirLote(lote);
  });
  return { total, grupos: grupos.length };
}

async function enParalelo(lista, limite, tarea) {
  let siguiente = 0;
  const trabajador = async () => {
    while (siguiente < lista.length) await tarea(lista[siguiente++]);
  };
  await Promise.all(Array.from({ length: Math.min(limite, lista.length) }, trabajador));
}

// ---------- Normalización ----------

function agregarItems(p, t, items, vistos, fuentes) {
  for (const sku of p.items || []) {
    if (vistos.has(sku.itemId)) continue;
    const seller = elegirSeller(sku.sellers || []);
    const oferta = (seller && seller.commertialOffer) || {};
    const venta = precioFront(oferta.Price, oferta, t);
    const lista = oferta.ListPrice > oferta.Price ? precioFront(oferta.ListPrice, oferta, t) : venta;
    const titulo = tituloSku(p, sku);
    const fotos = (sku.images || []).slice(0, Number(t.max_imagenes) || MAX_IMAGENES);
    const item = {
      id: String(sku.itemId),
      grupo: String(p.productId),
      titulo,
      descripcion: limpiarHtml(p.description || p.metaTagDescription) || t.descripcion_default || titulo,
      link: `${t.dominio.replace(/\/+$/, '')}/${p.linkText}/p?skuId=${sku.itemId}`,
      imagenes: fotos.map((i) => imagen(i.imageUrl, t.tamano_imagen || 800)).filter(Boolean),
      imagenesPinterest: fotos.map((i) => imagen(i.imageUrl, 1000, 1500)).filter(Boolean),
      disponible: venta.valor > 0 && (oferta.AvailableQuantity > 0 || oferta.IsAvailable === true),
      precio: lista.valor,
      oferta: lista.valor - venta.valor >= 1 ? venta.valor : 0,
      marca: t.marca || p.brand || t.nombre,
      gtin: /^\d{8}$|^\d{12,14}$/.test(sku.ean || '') ? sku.ean : '',
      categoria: categoria(p),
    };
    if (!item.titulo || !item.imagenes.length || !(item.precio > 0)) continue;
    vistos.add(sku.itemId);
    fuentes[venta.fuente] = (fuentes[venta.fuente] || 0) + 1;
    items.push(item);
  }
}

// Reproduce el precio que muestra el front: base + impuesto informado por VTEX.
function precioFront(base, oferta, t) {
  base = Number(base) || 0;
  const price = Number(oferta.Price) || 0;
  if (base <= 0) return { valor: 0, fuente: 'sin_precio' };
  const tax = Number(oferta.Tax) || 0;
  if (tax > 0 && price > 0) return { valor: base * (1 + tax / price), fuente: 'tax' };
  const cuota = (oferta.Installments || []).find(
    (x) => x.NumberOfInstallments === 1 && x.TotalValuePlusInterestRate > price + 0.01
  );
  if (cuota && price > 0) return { valor: base * (cuota.TotalValuePlusInterestRate / price), fuente: 'cuota' };
  const tasa = Number(oferta.taxPercentage) || 0;
  if (tasa > 0) return { valor: base * (1 + tasa), fuente: 'taxPercentage' };
  const ajuste = Number(t.ajuste_precio) || 1;
  return { valor: base * ajuste, fuente: ajuste !== 1 ? 'ajuste_manual' : 'base' };
}

function elegirSeller(sellers) {
  const conPrecio = sellers.filter((s) => s.commertialOffer && s.commertialOffer.Price > 0);
  return conPrecio.find((s) => s.sellerDefault) || conPrecio[0] || sellers[0] || null;
}

function tituloSku(p, sku) {
  const nombre = (p.productName || '').trim();
  const variante = (sku.name || '').trim();
  const titulo = variante && !nombre.toLowerCase().includes(variante.toLowerCase())
    ? `${nombre} - ${variante}` : nombre;
  return titulo.slice(0, 150);
}

function imagen(url, ancho, alto = ancho) {
  if (!url) return '';
  return String(url)
    .replace(/^http:/, 'https:')
    .replace(/(\/arquivos\/ids\/\d+)(-\d+-\d+)?/, `$1-${ancho}-${alto}`);
}

function categoria(p) {
  const ruta = (p.categories || []).slice().sort((a, b) => b.length - a.length)[0] || '';
  return ruta.split('/').filter(Boolean).slice(0, 5).join(' > ');
}

function limpiarHtml(html) {
  return String(html || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ').trim().slice(0, 5000);
}

// ---------- Formatos ----------

function precio(valor, moneda) {
  if (!(valor > 0)) return '';
  const monto = SIN_DECIMALES.includes(moneda) ? String(Math.round(valor)) : valor.toFixed(2);
  return `${monto} ${moneda}`;
}

function csv(filas) {
  const celda = (v) => {
    const s = String(v == null ? '' : v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return filas.map((f) => f.map(celda).join(',')).join('\n') + '\n';
}

function xml(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
}

function feedMeta(items, t) {
  const cols = ['id', 'title', 'description', 'availability', 'condition', 'price', 'sale_price', 'link',
    'image_link', 'additional_image_link', 'brand', 'item_group_id', 'product_type', 'gtin'];
  return csv([cols, ...items.map((i) => [
    i.id, i.titulo, i.descripcion, i.disponible ? 'in stock' : 'out of stock', 'new',
    precio(i.precio, t.moneda), precio(i.oferta, t.moneda), i.link,
    i.imagenes[0], i.imagenes.slice(1, 10).join(','), i.marca, i.grupo, i.categoria, i.gtin,
  ])]);
}

function feedTikTok(items, t) {
  const cols = ['sku_id', 'title', 'description', 'availability', 'condition', 'price', 'sale_price', 'link',
    'image_link', 'additional_image_link', 'brand', 'item_group_id', 'product_type'];
  return csv([cols, ...items.map((i) => [
    i.id, i.titulo, i.descripcion, i.disponible ? 'in stock' : 'out of stock', 'new',
    precio(i.precio, t.moneda), precio(i.oferta, t.moneda), i.link,
    i.imagenes[0], i.imagenes.slice(1, 10).join(','), i.marca, i.grupo, i.categoria,
  ])]);
}

// Pinterest recomienda imágenes 2:3 y admite hasta 10 adicionales.
function feedPinterest(items, t) {
  const cols = ['id', 'title', 'description', 'link', 'image_link', 'additional_image_link', 'price',
    'sale_price', 'availability', 'condition', 'brand', 'item_group_id', 'product_type',
    'google_product_category'];
  return csv([cols, ...items.map((i) => [
    i.id, i.titulo, i.descripcion, i.link, i.imagenesPinterest[0], i.imagenesPinterest.slice(1, 11).join(','),
    precio(i.precio, t.moneda), precio(i.oferta, t.moneda), i.disponible ? 'in stock' : 'out of stock',
    'new', i.marca, i.grupo, i.categoria, t.google_product_category || '',
  ])]);
}

function feedGoogle(items, t) {
  const tag = (nombre, valor) => (valor ? `<g:${nombre}>${xml(valor)}</g:${nombre}>` : '');
  const cuerpo = items.map((i) => [
    '<item>',
    tag('id', i.id), tag('title', i.titulo), tag('description', i.descripcion), tag('link', i.link),
    tag('image_link', i.imagenes[0]),
    ...i.imagenes.slice(1, 11).map((img) => tag('additional_image_link', img)),
    tag('availability', i.disponible ? 'in_stock' : 'out_of_stock'), tag('condition', 'new'),
    tag('price', precio(i.precio, t.moneda)), tag('sale_price', precio(i.oferta, t.moneda)),
    tag('brand', i.marca), i.gtin ? tag('gtin', i.gtin) : tag('identifier_exists', 'no'),
    tag('item_group_id', i.grupo), tag('product_type', i.categoria),
    tag('google_product_category', t.google_product_category),
    '</item>',
  ].filter(Boolean).join('\n')).join('\n');
  return '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<rss version="2.0" xmlns:g="http://base.google.com/ns/1.0">\n<channel>\n' +
    `<title>${xml(t.nombre)}</title>\n<link>${xml(t.dominio)}</link>\n<description>${xml(t.nombre)}</description>\n` +
    cuerpo + '\n</channel>\n</rss>\n';
}

// ---------- Archivos ----------

function escribir(archivo, contenido) {
  const temporal = archivo + '.tmp';
  fs.writeFileSync(temporal, contenido, 'utf8');
  fs.renameSync(temporal, archivo);
}

function leerJson(archivo) {
  try { return JSON.parse(fs.readFileSync(archivo, 'utf8').replace(/^﻿/, '')); } catch (_) { return null; }
}

main();
