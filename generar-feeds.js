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
  if (errores) process.exitCode = 1;
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

  const segundos = Math.round((Date.now() - inicio) / 1000);
  escribir(path.join(dir, 'estado.json'), JSON.stringify({
    tienda: t.nombre,
    actualizado: new Date().toISOString(),
    frecuencia_horas: frecuenciaHoras(t, { productos: productos.size }),
    duracion_segundos: segundos,
    productos_vtex: rastreo.total,
    productos: productos.size,
    grupos_de_precio: rastreo.grupos,
    skus: items.length,
    en_stock: items.filter((i) => i.disponible).length,
    fuente_precio: fuentes,
    feeds,
  }, null, 2));

  console.log(`[${t.slug}] ${productos.size}/${rastreo.total} productos, ${items.length} SKUs en ${segundos}s` +
    ` (${rastreo.grupos} grupos) · precio: ${JSON.stringify(fuentes)}`);
  if (fuentes.base) {
    console.warn(`[${t.slug}] AVISO: ${fuentes.base} SKUs sin impuesto en la API; revisa "ajuste_precio" en tiendas.json`);
  }
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
    const item = {
      id: String(sku.itemId),
      grupo: String(p.productId),
      titulo,
      descripcion: limpiarHtml(p.description || p.metaTagDescription) || t.descripcion_default || titulo,
      link: `${t.dominio.replace(/\/+$/, '')}/${p.linkText}/p?skuId=${sku.itemId}`,
      imagenes: (sku.images || []).map((i) => imagen(i.imageUrl, t.tamano_imagen || 800)).filter(Boolean),
      imagenesPinterest: (sku.images || []).map((i) => imagen(i.imageUrl, 1000, 1500)).filter(Boolean),
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
