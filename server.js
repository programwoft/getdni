const express = require('express');
const path = require('path');
const { chromium } = require('playwright');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const FORM_URL = 'https://eldni.com/pe/buscar-datos-por-dni';

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

// Un solo browser reutilizado entre peticiones.
let browserPromise = null;
function getBrowser() {
  if (!browserPromise) {
    browserPromise = chromium.launch({ headless: true });
  }
  return browserPromise;
}

/**
 * Consulta un DNI en eldni.com usando Playwright:
 *  1) Abre el formulario en un contexto/página nueva.
 *  2) Escribe el DNI y hace click en "Buscar" (submit real del form).
 *  3) Espera a que cargue la página de resultados.
 *  4) Extrae la fila del <tbody> con page.evaluate().
 */
async function consultarDniOld(dni) {
  const browser = await getBrowser();
  const context = await browser.newContext({ userAgent: USER_AGENT });
  const page = await context.newPage();

  try {
    // 'networkidle' puede colgarse si la página tiene scripts de fondo
    // (analytics, ads) que nunca dejan de hacer requests. Usamos
    // 'domcontentloaded' (más liviano) y dejamos que waitForSelector
    // se encargue de esperar lo que realmente necesitamos.
    await page.goto(FORM_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });

    try {
      // Render (plan compartido) puede ser más lento que tu máquina local,
      // por eso subimos el timeout de 10s a 20s.
      await page.waitForSelector('#dni', { timeout: 20000 });
    } catch (selectorErr) {
      // Diagnóstico: si no aparece #dni, queremos saber QUÉ cargó en
      // realidad (¿un challenge de Cloudflare? ¿un bloqueo por IP?
      // ¿el sitio caído?) en vez de solo ver "timeout".
      const titulo = await page.title().catch(() => '(sin título)');
      const urlActual = page.url();
      const textoVisible = await page
        .evaluate(() => document.body?.innerText?.slice(0, 300) || '')
        .catch(() => '(no se pudo leer el body)');

      console.error('--- DIAGNÓSTICO: no apareció #dni ---');
      console.error('URL final:', urlActual);
      console.error('Título de la página:', titulo);
      console.error('Primeros 300 caracteres visibles:', textoVisible);
      console.error('--------------------------------------');

      // Adjuntamos el diagnóstico al error para que llegue hasta la
      // respuesta HTTP (modo debug), no solo a los logs del servidor.
      selectorErr.diagnostico = { urlActual, titulo, textoVisible };

      throw selectorErr;
    }

    await page.fill('#dni', dni);

    // El <form> original hace un submit normal (no AJAX), así que
    // esperamos la navegación junto con el click.
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }),
      page.click('#btn-buscar-datos-por-dni'),
    ]);

    const resultado = await page.evaluate(() => {
      const fila = document.querySelector('table tbody tr');
      if (!fila) return null;

      const celdas = Array.from(fila.querySelectorAll('td')).map((td) =>
        td.textContent.trim()
      );

      if (celdas.length < 4) return null;

      return {
        dni: celdas[0],
        nombres: celdas[1],
        apellidoPaterno: celdas[2],
        apellidoMaterno: celdas[3],
      };
    });

    return resultado;
  } finally {
    await context.close();
  }
}

async function consultarDni(dni) {
  const browser = await getBrowser();
  const context = await browser.newContext({
    userAgent: USER_AGENT,
  });

  const page = await context.newPage();

  try {
    await page.goto('https://buscardniperu.com/', {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });

    await page.waitForSelector('#campo-dni', {
      timeout: 20000,
    });

    await page.fill('#campo-dni', dni);

    await page.click('button[data-submit]');

    // Esperamos a que los 3 campos tengan contenido.
    await page.waitForFunction(() => {
      const resultado = document.querySelector('[data-resultado]');

      if (!resultado) {
        return false;
      }

      const valores = Array.from(
        resultado.querySelectorAll('dl dd')
      ).map((dd) => dd.textContent.trim());

      return (
        valores.length >= 3 &&
        valores.every((valor) => valor.length > 0)
      );
    }, { timeout: 30000 });

    // Ahora extraemos los datos
    const resultado = await page.evaluate(() => {
      const contenedor = document.querySelector(
        '[data-resultado]'
      );

      if (!contenedor) {
        return null;
      }

      const datos = {
        nombres: '',
        apellidoPaterno: '',
        apellidoMaterno: '',
      };

      contenedor.querySelectorAll('dl > div').forEach((fila) => {
        const dt = fila.querySelector('dt');
        const dd = fila.querySelector('dd');

        if (!dt || !dd) return;

        const campo = dt.textContent.trim().toLowerCase();
        const valor = dd.textContent.trim();

        if (campo === 'nombres') {
          datos.nombres = valor;
        } else if (campo === 'apellido paterno') {
          datos.apellidoPaterno = valor;
        } else if (campo === 'apellido materno') {
          datos.apellidoMaterno = valor;
        }
      });

      return datos;
    });

    console.log('Resultado DNI:', {
      dni,
      ...resultado,
    });

    return {
      dni,
      ...resultado,
    };

  } catch (error) {
    console.error('Error real (modo debug):', error);

    try {
      console.error('URL actual:', page.url());
      console.error('Título:', await page.title());

      const debug = await page.evaluate(() => ({
        resultado:
          document.querySelector('[data-resultado]')?.outerHTML || null,

        texto:
          document.body?.innerText?.slice(0, 1000) || '',
      }));

      console.error('Debug:', debug);
    } catch (debugError) {
      console.error('Error obteniendo diagnóstico:', debugError);
    }

    throw error;

  } finally {
    await context.close();
  }
}

app.post('/api/consultar', async (req, res) => {
  const dni = (req.body?.dni || '').toString().trim();

  if (!/^\d{8}$/.test(dni)) {
    return res
      .status(400)
      .json({ error: 'Ingresa un DNI válido de 8 dígitos.' });
  }

  try {
    const resultado = await consultarDni(dni);

    if (!resultado) {
      return res
        .status(404)
        .json({ error: 'No se encontraron resultados para ese DNI.' });
    }

    return res.json(resultado);
  } catch (err) {
    console.error('Error consultando DNI:', err.message);
    // Modo debug: devolvemos el error real (mensaje + stack corto) para
    // saber exactamente qué está fallando. Quitar esto antes de producción.
    return res.status(502).json({
      error: 'Error real (modo debug): ' + err.message,
      stack: err.stack?.split('\n').slice(0, 5).join('\n'),
      diagnostico: err.diagnostico || null,
    });
  }
});

app.listen(PORT, () => {
  console.log(`Servidor corriendo en http://localhost:${PORT}`);
});

process.on('SIGINT', async () => {
  if (browserPromise) {
    const browser = await browserPromise;
    await browser.close();
  }
  process.exit(0);
});
